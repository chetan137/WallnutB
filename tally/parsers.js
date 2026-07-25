'use strict';

const { safeStr, safeNum, ensureArray, tallyToIso } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * tally/parsers.js
 *
 * Converts fast-xml-parser output into clean JS arrays ready for DB UPSERT.
 *
 * RESILIENCE PRINCIPLES (all parsers follow these):
 *  1. Every field access uses safeStr() / safeNum() — never throws on missing keys.
 *  2. Unknown voucher types are stored as-is — no whitelist filtering.
 *  3. Unknown narration formats fall back to storing the raw narration string.
 *  4. A single malformed voucher/ledger never aborts the whole batch.
 *  5. fast-xml-parser returns consistent arrays (configured via isArray callback in client.js).
 */

// ── Shared XML navigation ──────────────────────────────────────────────────────

/**
 * Navigates to the data collection inside a parsed Tally XML object.
 *
 * Tally Prime can respond with TWO different envelope structures:
 *
 *  Structure A (EXPORTDATA — expected, seen in some Tally versions):
 *    ENVELOPE → BODY → EXPORTDATA → COLLECTION → VOUCHER[]
 *
 *  Structure B (IMPORTDATA — what this Tally Prime actually returns):
 *    ENVELOPE → BODY → IMPORTDATA → REQUESTDATA → TALLYMESSAGE → VOUCHER[]
 *
 * This function normalises both into a single object that looks like a COLLECTION:
 *   { VOUCHER: [...], LEDGER: [...], STOCKITEM: [...] }
 */
function getCollection(parsed) {
  const env  = parsed?.ENVELOPE;
  const body = env?.BODY;
  if (!body) return null;

  // ── Structure A: EXPORTDATA / DATA ────────────────────────────────────────
  const exportData = body.EXPORTDATA || body.DATA;
  if (exportData) {
    const col = exportData.COLLECTION || body.DATA?.COLLECTION;
    if (col) return col;
  }

  // ── Structure B: IMPORTDATA → REQUESTDATA → TALLYMESSAGE ──────────────────
  const importData = body.IMPORTDATA;
  if (importData) {
    const requestData = importData.REQUESTDATA;
    if (requestData) {
      // TALLYMESSAGE may be a single object or an array (handled by ensureArray at call site)
      const tm = requestData.TALLYMESSAGE;
      if (!tm) return null;
      // Merge all TALLYMESSAGE entries into one flat collection object
      const messages = Array.isArray(tm) ? tm : [tm];
      const merged = {};
      for (const msg of messages) {
        for (const key of Object.keys(msg)) {
          if (key.startsWith('@_')) continue; // skip xmlns attributes
          if (merged[key]) {
            // Append to existing array
            merged[key] = [
              ...(Array.isArray(merged[key]) ? merged[key] : [merged[key]]),
              ...(Array.isArray(msg[key])    ? msg[key]    : [msg[key]]),
            ];
          } else {
            merged[key] = msg[key];
          }
        }
      }
      return merged;
    }
  }

  return null;
}

// ── Qty / Rate string parser ────────────────────────────────────────────────────

/**
 * Parses Tally's complex quantity strings into qty + unit.
 *
 * Examples:
 *   "6000.000 Kgs =  300.000 Bags"  → { qty: 300, unit: 'Bags' }  (uses alt UOM after '=')
 *   "300.000 Bags"                   → { qty: 300, unit: 'Bags' }
 *   "6000.000 Kgs"                   → { qty: 6000, unit: 'Kgs' }
 *
 * @param {string|number} raw
 * @returns {{ qty: number, unit: string }}
 */
function parseQtyString(raw) {
  const str = String(raw || '').trim();
  if (!str) return { qty: 0, unit: '' };

  // If string has '=', take the part after '=' (alternate UOM — usually the billing unit)
  const eqIdx = str.indexOf('=');
  const part   = eqIdx >= 0 ? str.slice(eqIdx + 1).trim() : str;

  const qty        = parseFloat(part) || 0;
  // Unit = everything after the leading number (e.g. " Bags", " Kgs")
  const unitMatch  = part.match(/^[\d.,\s]+([A-Za-z].*?)\s*$/);
  const unit       = unitMatch ? unitMatch[1].trim() : '';
  return { qty, unit };
}

/**
 * Parses Tally's rate strings into a number.
 *
 * Examples:
 *   "242.00/Bags"  → 242
 *   "280.00/Bags"  → 280
 *   1500           → 1500
 *
 * @param {string|number} raw
 * @returns {number}
 */
function parseRateString(raw) {
  return Math.abs(parseFloat(String(raw || '')) || 0);
}

// ── Narration parser ────────────────────────────────────────────────────────────

/**
 * Parses the structured narration format used by this Wallnut Tally setup:
 *   "Item: <name> | Qty: <n> <unit> | Rate: <r> | Area: <a> | SO: <s> | State: <st>"
 *
 * For companies with a different / no narration format, all fields return '' or 0
 * and itemName falls back to the full narration text (truncated to 200 chars).
 *
 * @param {string} narration
 * @returns {{ itemName, quantity, unit, rate, salesOfficer, areaCity, state }}
 */
function parseNarration(narration) {
  const result = { itemName: '', quantity: 0, unit: '', rate: 0, salesOfficer: '', areaCity: '', state: '' };
  if (!narration) return result;

  const get = (key) => {
    const m = narration.match(new RegExp(`${key}:\\s*([^|]+)`, 'i'));
    return m ? m[1].trim() : '';
  };

  const isStructured = /Item:/i.test(narration);

  if (isStructured) {
    result.itemName     = get('Item');
    const qtyStr        = get('Qty');
    const qtyParts      = qtyStr.split(/\s+/);
    result.quantity     = Math.abs(parseFloat(qtyParts[0]) || 0);
    result.unit         = qtyParts.slice(1).join(' ');
    result.rate         = parseFloat(get('Rate')) || 0;
    result.salesOfficer = get('SO');
    result.areaCity     = get('Area');
    result.state        = get('State');
  } else {
    // Unknown narration format — store as item name (best effort)
    result.itemName = narration.slice(0, 200);
  }

  return result;
}

// ── parseVouchers ──────────────────────────────────────────────────────────────

/**
 * Parses Tally Day Book XML into voucher records for DB insertion.
 *
 * Each record contains:
 *  - voucher header fields (vchNo, date, vchType, partyName, narration, totalAmount)
 *  - ledgerEntries[]    — debit/credit ledger lines
 *  - inventoryEntries[] — stock item lines (if any)
 *
 * @param {Object} parsed     fast-xml-parser output
 * @param {number} companyId  FK for companies.id
 * @returns {Array}
 */
function parseVouchers(parsed, companyId) {
  const records = [];
  try {
    const collection = getCollection(parsed);
    const vouchers   = ensureArray(collection?.VOUCHER);

    vouchers.forEach((v, idx) => {
      try {
        const vchType   = safeStr(v.VOUCHERTYPENAME);
        const rawDate   = safeStr(v.DATE);
        const date      = tallyToIso(rawDate) || rawDate;
        const partyName = safeStr(v.PARTYLEDGERNAME);
        const vchNo     = safeStr(v.VOUCHERNUMBER) || `AUTO-${idx}-${Date.now()}`;
        const narration = safeStr(v.NARRATION);

        // ── Extract ledger entries (LEDGERENTRIES.LIST is the correct Tally field) ──
        // NOTE: We tried ALLLEDGERENTRIES.LIST — it does NOT exist in TallyPrime Day Book.
        // The actual field name is LEDGERENTRIES.LIST (confirmed via raw XML inspection).
        const ledgerLines   = ensureArray(v['LEDGERENTRIES.LIST']);
        let totalAmount     = 0;
        const ledgerEntries = [];

        for (const l of ledgerLines) {
          if (typeof l !== 'object' || l === null) continue;
          const ledgerName       = safeStr(l.LEDGERNAME);
          const amount           = safeNum(l.AMOUNT);
          const isParty          = safeStr(l.ISPARTYLEDGER).toLowerCase() === 'yes';
          const isDeemedPositive = safeStr(l.ISDEEMEDPOSITIVE).toLowerCase() === 'yes';

          // totalAmount = party ledger's abs amount (that's the invoice total).
          // Fall back to max abs amount if no party ledger is flagged.
          if (isParty && Math.abs(amount) > 0) {
            totalAmount = Math.abs(amount);
          } else if (totalAmount === 0 && Math.abs(amount) > Math.abs(totalAmount)) {
            totalAmount = Math.abs(amount);
          }

          ledgerEntries.push({ ledgerName, amount, isParty, isDeemedPositive });
        }

        // ── Extract inventory entries (ALLINVENTORYENTRIES.LIST) ──────────
        // Tally qty strings: "6000.000 Kgs =  300.000 Bags" → 300 Bags
        // Tally rate strings: "242.00/Bags" → 242
        const inventoryLines   = ensureArray(v['ALLINVENTORYENTRIES.LIST']);
        const inventoryEntries = [];
        const narParsed        = parseNarration(narration);

        for (const inv of inventoryLines) {
          // Skip empty placeholder nodes (Tally writes empty LIST tags for service vouchers)
          if (typeof inv !== 'object' || inv === null || Object.keys(inv).length === 0) continue;

          const invItemName = safeStr(inv.STOCKITEMNAME);
          if (!invItemName) continue; // true empty entry

          // Parse qty: prefer BILLEDQTY (in billing UOM) over ACTUALQTY
          const qtyParsed = parseQtyString(inv.BILLEDQTY || inv.ACTUALQTY);
          const invRate   = parseRateString(inv.RATE);
          const invAmount = Math.abs(safeNum(inv.AMOUNT));

          inventoryEntries.push({
            itemName:     invItemName,
            quantity:     qtyParsed.qty,
            unit:         qtyParsed.unit,
            rate:         invRate,
            amount:       invAmount || totalAmount,
            salesOfficer: narParsed.salesOfficer,
            areaCity:     narParsed.areaCity,
            state:        narParsed.state,
          });
        }

        // ── Fallback: parse narration when no real inventory nodes exist ───
        if (inventoryEntries.length === 0 && narParsed.itemName) {
          inventoryEntries.push({
            itemName:     narParsed.itemName,
            quantity:     narParsed.quantity,
            unit:         narParsed.unit,
            rate:         narParsed.rate,
            amount:       narParsed.rate > 0 && narParsed.quantity > 0
                            ? narParsed.rate * narParsed.quantity
                            : totalAmount,
            salesOfficer: narParsed.salesOfficer,
            areaCity:     narParsed.areaCity,
            state:        narParsed.state,
          });
        }

        // Skip vouchers with no date or no voucher number (likely header rows)
        if (!date || !vchNo) return;

        records.push({
          companyId,
          vchNo,
          date,
          vchType,
          partyName,
          narration,
          totalAmount,
          ledgerEntries,
          inventoryEntries,
        });

      } catch (innerErr) {
        logger.warn(`[parsers] Skipped voucher idx=${idx}: ${innerErr.message}`);
      }
    });

  } catch (outerErr) {
    logger.error(`[parsers] parseVouchers outer error: ${outerErr.message}`);
  }

  return records;
}

// ── parseLedgers ───────────────────────────────────────────────────────────────

/**
 * Parses List of Accounts XML into ledger master records.
 * Stores ALL accounts regardless of group — parent_group column is used later
 * by the AWS API to distinguish customers, suppliers, banks, etc.
 *
 * @param {Object} parsed
 * @param {number} companyId
 * @returns {Array}
 */
function parseLedgers(parsed, companyId) {
  const records = [];
  try {
    const collection = getCollection(parsed);
    const ledgers    = ensureArray(collection?.LEDGER);

    ledgers.forEach((l) => {
      try {
        // Tally puts the ledger name as an XML attribute NAME="..." AND as a child element
        const name           = safeStr(l['@_NAME'] || l.NAME);
        const parentGroup    = safeStr(l.PARENT);
        const closingBalance = safeNum(l.CLOSINGBALANCE);
        const gstNo          = safeStr(l.GSTREGISTRATIONNUMBER || l.GSTIN);
        const state          = safeStr(l.STATENAME || l.STATE);

        if (!name) return; // Skip empty rows

        records.push({ companyId, name, parentGroup, closingBalance, gstNo, state });
      } catch (e) {
        logger.warn(`[parsers] Skipped ledger: ${e.message}`);
      }
    });
  } catch (e) {
    logger.error(`[parsers] parseLedgers error: ${e.message}`);
  }
  return records;
}

// ── parseStockItems ────────────────────────────────────────────────────────────

/**
 * Parses Stock Summary (or Stock Item collection) XML into stock records.
 *
 * Tally's "Stock Summary" report returns a DSP display format:
 *   <DSPACCNAME><DSPDISPNAME>GroupName</DSPDISPNAME></DSPACCNAME>
 *   <DSPSTKINFO><DSPSTKCL><DSPCLQTY>77923.519 Nos.</DSPCLQTY><DSPCLAMTA>-118520.58</DSPCLAMTA></DSPSTKCL></DSPSTKINFO>
 *
 * DSPACCNAME[i] always pairs with DSPSTKINFO[i] in document order.
 * Items without a quantity string are stock groups (we store them too for completeness).
 *
 * Falls back to standard STOCKITEM collection format if present.
 *
 * @param {Object} parsed
 * @param {number} companyId
 * @returns {Array}
 */
function parseStockItems(parsed, companyId) {
  const records = [];
  try {
    // ── Try standard STOCKITEM collection format first ────────────────────
    const collection = getCollection(parsed);
    const items      = ensureArray(collection?.STOCKITEM);

    if (items.length > 0) {
      items.forEach((item) => {
        try {
          const name         = safeStr(item['@_NAME'] || item.NAME);
          const parentGroup  = safeStr(item.PARENT);
          const baseUnit     = safeStr(item.BASEUNITS);
          const closingQty   = Math.abs(safeNum(item.CLOSINGBALANCE));
          const closingValue = Math.abs(safeNum(item.CLOSINGVALUE));
          if (!name) return;
          records.push({ companyId, name, parentGroup, baseUnit, closingQty, closingValue });
        } catch (e) {
          logger.warn(`[parsers] Skipped stock item: ${e.message}`);
        }
      });
      return records;
    }

    // ── Fall back to DSP display format (Stock Summary report) ────────────
    // Tally returns alternating DSPACCNAME + DSPSTKINFO pairs at ENVELOPE level.
    const env = parsed?.ENVELOPE;
    if (!env) return records;

    const names = ensureArray(env.DSPACCNAME);
    const infos = ensureArray(env.DSPSTKINFO);

    names.forEach((nameNode, idx) => {
      try {
        const name    = safeStr(nameNode?.DSPDISPNAME);
        if (!name) return;

        const cl      = infos[idx]?.DSPSTKCL || {};
        const qtyStr  = safeStr(cl.DSPCLQTY).trim();        // e.g. "77923.519 Nos."
        const qty     = parseFloat(qtyStr) || 0;
        // Extract unit from qty string (everything after the number)
        const unitMatch = qtyStr.match(/^[\d.,\s]+(.+)$/);
        const unit    = unitMatch ? unitMatch[1].trim() : '';
        const value   = Math.abs(safeNum(cl.DSPCLAMTA));

        records.push({
          companyId,
          name,
          parentGroup:  '',   // Not available in Stock Summary display format
          baseUnit:     unit,
          closingQty:   qty,
          closingValue: value,
        });
      } catch (e) {
        logger.warn(`[parsers] Skipped DSP stock item idx=${idx}: ${e.message}`);
      }
    });

  } catch (e) {
    logger.error(`[parsers] parseStockItems error: ${e.message}`);
  }
  return records;
}

// ── parseBillsPayable ──────────────────────────────────────────────────────────

/**
 * Converts Tally date string "31-Jan-21" or "31-Jan-2021" to ISO "2021-01-31".
 * Returns null if unparseable.
 */
function parseTallyDate(str) {
  if (!str || !str.trim()) return null;
  const MONTHS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
  const parts = str.trim().split('-');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const mon = MONTHS[parts[1]];
  let year  = parseInt(parts[2], 10);
  if (year < 100) year += 2000;
  if (isNaN(day) || !mon || isNaN(year)) return null;
  return `${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

/**
 * Parses Tally's "Bills Payable" report XML.
 * Each bill block:
 *   <BILLFIXED><BILLDATE>DD-Mon-YY</BILLDATE><BILLREF>ref</BILLREF><BILLPARTY>name</BILLPARTY></BILLFIXED>
 *   <BILLCL>amount</BILLCL>
 *   <BILLDUE>DD-Mon-YY</BILLDUE>
 *   <BILLOVERDUE>days</BILLOVERDUE>
 *
 * @param {string} raw  Raw XML string
 * @param {number} companyId
 * @returns {Array<{companyId,partyName,billRef,billDate,amount,dueDate,overdueDays}>}
 */
function parseBillsPayable(raw, companyId) {
  const records = [];
  try {
    // Match each complete bill block as one unit
    const blockRe = /<BILLFIXED>[\s\S]*?<BILLDATE>([^<]*)<\/BILLDATE>[\s\S]*?<BILLREF>([^<]*)<\/BILLREF>[\s\S]*?<BILLPARTY>([^<]*)<\/BILLPARTY>[\s\S]*?<\/BILLFIXED>\s*<BILLCL>([^<]*)<\/BILLCL>\s*<BILLDUE>([^<]*)<\/BILLDUE>\s*<BILLOVERDUE>([^<]*)<\/BILLOVERDUE>/g;

    let m;
    while ((m = blockRe.exec(raw)) !== null) {
      const billDate    = parseTallyDate(m[1].trim());
      const billRef     = m[2].trim().replace(/&amp;/g, '&').replace(/&apos;/g, "'");
      const partyName   = m[3].trim().replace(/&amp;/g, '&').replace(/&apos;/g, "'");
      const amount      = parseFloat(m[4]) || 0;
      const dueDate     = parseTallyDate(m[5].trim());
      const overdueDays = parseInt(m[6], 10) || 0;

      if (!partyName || amount <= 0) continue; // skip zero/negative bills

      records.push({ companyId, partyName, billRef, billDate, amount, dueDate, overdueDays });
    }
  } catch (e) {
    logger.error(`[parsers] parseBillsPayable error: ${e.message}`);
  }
  return records;
}

// ── parseBillsReceivable ───────────────────────────────────────────────────────

/**
 * Parses Tally's "Bills Receivable" report XML.
 * IDENTICAL tag structure to Bills Payable (BILLFIXED, BILLCL, BILLDUE, BILLOVERDUE).
 *
 * KEY DIFFERENCE from payables:
 *   In Tally's double-entry system, money owed TO you (receivable) is stored as
 *   a CREDIT balance on the debtor ledger → BILLCL comes as a NEGATIVE number.
 *   We store Math.abs(BILLCL) so the dashboard always works with positive amounts.
 *
 * @param {string} raw  Raw XML string
 * @param {number} companyId
 * @returns {Array<{companyId,partyName,billRef,billDate,amount,dueDate,overdueDays}>}
 */
function parseBillsReceivable(raw, companyId) {
  const records = [];
  try {
    const blockRe = /<BILLFIXED>[\s\S]*?<BILLDATE>([^<]*)<\/BILLDATE>[\s\S]*?<BILLREF>([^<]*)<\/BILLREF>[\s\S]*?<BILLPARTY>([^<]*)<\/BILLPARTY>[\s\S]*?<\/BILLFIXED>\s*<BILLCL>([^<]*)<\/BILLCL>\s*<BILLDUE>([^<]*)<\/BILLDUE>\s*<BILLOVERDUE>([^<]*)<\/BILLOVERDUE>/g;

    let m;
    while ((m = blockRe.exec(raw)) !== null) {
      const billDate    = parseTallyDate(m[1].trim());
      const billRef     = m[2].trim().replace(/&amp;/g, '&').replace(/&apos;/g, "'");
      const partyName   = m[3].trim().replace(/&amp;/g, '&').replace(/&apos;/g, "'");
      // Receivable BILLCL is negative in Tally → take absolute value
      const amount      = Math.abs(parseFloat(m[4]) || 0);
      const dueDate     = parseTallyDate(m[5].trim());
      const overdueDays = parseInt(m[6], 10) || 0;

      if (!partyName || amount === 0) continue; // skip zero bills only

      records.push({ companyId, partyName, billRef, billDate, amount, dueDate, overdueDays });
    }
  } catch (e) {
    logger.error(`[parsers] parseBillsReceivable error: ${e.message}`);
  }
  return records;
}

module.exports = { parseVouchers, parseLedgers, parseStockItems, parseOutstanding, parseBillsPayable, parseBillsReceivable };


/**
 * Parses Outstanding Receivables XML.
 * Only includes parties with a positive closing balance (they owe us money).
 *
 * @param {Object} parsed
 * @param {number} companyId
 * @returns {Array}
 */
function parseOutstanding(parsed, companyId) {
  const records = [];
  try {
    const collection = getCollection(parsed);
    const ledgers    = ensureArray(collection?.LEDGER);

    ledgers.forEach((l) => {
      try {
        const partyName        = safeStr(l['@_NAME'] || l.NAME);
        const totalOutstanding = safeNum(l.CLOSINGBALANCE);

        if (!partyName || totalOutstanding <= 0) return;

        records.push({ companyId, partyName, totalOutstanding });
      } catch (e) {
        logger.warn(`[parsers] Skipped outstanding entry: ${e.message}`);
      }
    });
  } catch (e) {
    logger.error(`[parsers] parseOutstanding error: ${e.message}`);
  }
  return records;
}
