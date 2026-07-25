'use strict';

const pool        = require('../db/pool');
const tallyClient = require('../tally/client');
const templates   = require('../tally/xmlTemplates');
const parsers     = require('../tally/parsers');
const syncLogs    = require('./syncLogs');
const logger      = require('../utils/logger');
const config      = require('../config');
const { subtractDays, todayIso } = require('../utils/helpers');

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanMs(ms) {
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function estimateParseTime(bytes) {
  // ~0.7 MB/s parse speed on this hardware
  const seconds = Math.ceil(bytes / (1024 * 1024) / 0.7);
  return `~${seconds}s`;
}

function progressBar(label, done, total, startMs) {
  if (total === 0) return;
  const pct    = Math.min(100, Math.round((done / total) * 100));
  const filled = Math.round(pct / 5);
  const bar    = '▓'.repeat(filled) + '░'.repeat(20 - filled);
  const elapsed = Date.now() - startMs;
  const rate   = done > 0 ? done / (elapsed / 1000) : 0;
  const remain = rate > 0 ? Math.round((total - done) / rate) : null;
  const eta    = remain !== null ? `ETA: ${humanMs(remain * 1000)}` : 'ETA: calculating...';
  const speed  = rate > 0 ? `${rate.toFixed(0)} rec/s` : '';
  logger.info(
    `[syncEngine]   [${bar}] ${String(pct).padStart(3)}%` +
    ` | ${done}/${total} ${label}` +
    ` | elapsed: ${humanMs(elapsed)}` +
    ` | ${eta} | ${speed}`
  );
}

/** Run all inserts inside a single transaction — 10-50x faster than auto-commit */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function logStep(label, msg) {
  logger.info(`[syncEngine]   ▶ ${label} | ${msg}`);
}

// ── Trial Balance (Group Totals) ─────────────────────────────────────────────────────
// Fetches group-level P&L and Balance Sheet amounts from Tally.
// This is the AUTHORITATIVE source for Sales, Purchase, Assets, Liabilities totals.
// Response is ~1KB — no streaming needed.
async function syncTrialBalance(company) {
  const { id: companyId, tally_name: tallyName, fiscal_year_from, is_historical } = company;
  const t0 = Date.now();
  logStep('TRIAL BAL', `start — company: "${company.name}"`);

  try {
    // Date range: full fiscal year for historical, YTD for current
    const fromDate = fiscal_year_from
      ? (fiscal_year_from instanceof Date
          ? fiscal_year_from.toISOString().slice(0, 10)
          : String(fiscal_year_from).slice(0, 10))
      : '2024-04-01';
    const toDate = is_historical ? endOfFiscalYear(fromDate) : todayIso();

    const xml = templates.buildTrialBalanceRequest(tallyName, fromDate, toDate);
    const raw = await tallyClient.request(xml);

    // Parse DSP format: <DSPDISPNAME>name</DSPDISPNAME> + <DSPCLDRAMTA>dr</DSPCLDRAMTA> + <DSPCLCRAMTA>cr</DSPCLCRAMTA>
    const names = [...raw.matchAll(/<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>/g)].map(m => m[1].trim());
    const drs   = [...raw.matchAll(/<DSPCLDRAMTA>([^<]*)<\/DSPCLDRAMTA>/g)].map(m => parseFloat(m[1]) || 0);
    const crs   = [...raw.matchAll(/<DSPCLCRAMTA>([^<]*)<\/DSPCLCRAMTA>/g)].map(m => parseFloat(m[1]) || 0);

    if (names.length === 0) {
      logStep('TRIAL BAL', '⚠️  no groups found in Tally response');
      return;
    }

    let upserted = 0;
    await withTransaction(async (client) => {
      for (let i = 0; i < names.length; i++) {
        const groupName  = names[i];
        const drAmount   = Math.abs(drs[i] || 0);   // make positive
        const crAmount   = Math.abs(crs[i] || 0);   // make positive
        // net: positive = CR balance (income/liability), negative = DR balance (expense/asset)
        const netBalance = (crs[i] || 0) + (drs[i] || 0);  // drs are negative in raw XML

        await client.query(`
          INSERT INTO trial_balance_groups
            (company_id, group_name, dr_amount, cr_amount, net_balance, period_from, period_to, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
          ON CONFLICT (company_id, group_name, period_from, period_to)
          DO UPDATE SET dr_amount=EXCLUDED.dr_amount, cr_amount=EXCLUDED.cr_amount,
            net_balance=EXCLUDED.net_balance, synced_at=NOW()
        `, [companyId, groupName, drAmount, crAmount, netBalance, fromDate, toDate]);
        upserted++;
      }
    });

    logStep('TRIAL BAL ✅', `${upserted} groups stored | ${humanMs(Date.now()-t0)}`);

  } catch (err) {
    logger.error(`[syncEngine] ❌ TRIAL BAL FAILED "${company.name}": ${err.message}`);
  }
}

/** Returns the last day of the fiscal year that started in fromDate (Indian FY: ends Mar 31) */
function endOfFiscalYear(fromDate) {
  const d = new Date(fromDate);
  // If fiscal year starts April, it ends next March 31
  const endYear = d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();
  return `${endYear}-03-31`;
}

// ── Profit & Loss Report (─────────────────────────────────────────────────────
// Fetches Tally's P&L report which gives actual P&L line items.
// Critically different from Trial Balance for CLOSED fiscal years:
//   - Trial Balance (closed year) = Balance Sheet only (P&L transferred to Retained Earnings)
//   - P&L Report = actual Sales/Purchase/Expense breakdown for ANY period
// XML tags used: DSPDISPNAME, BSMAINAMT (group total), PLSUBAMT (sub-item)
async function syncProfitAndLoss(company) {
  const { id: companyId, tally_name: tallyName, fiscal_year_from, is_historical } = company;
  const t0 = Date.now();
  logStep('P&L', `start — company: "${company.name}"`);

  try {
    const fromDate = fiscal_year_from
      ? (fiscal_year_from instanceof Date
          ? fiscal_year_from.toISOString().slice(0, 10)
          : String(fiscal_year_from).slice(0, 10))
      : '2024-04-01';
    const toDate = is_historical ? endOfFiscalYear(fromDate) : todayIso();

    const xml = templates.buildProfitAndLossRequest(tallyName, fromDate, toDate);
    const raw = await tallyClient.request(xml);

    // P&L uses BSMAINAMT (group total) and PLSUBAMT (sub-item detail)
    // — NOT the same as Trial Balance's DSPCLDRAMTA / DSPCLCRAMTA
    const names = [...raw.matchAll(/<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>/g)].map(m => m[1].trim());
    const mains = [...raw.matchAll(/<BSMAINAMT>([^<]*)<\/BSMAINAMT>/g)].map(m => parseFloat(m[1]) || 0);
    const subs  = [...raw.matchAll(/<PLSUBAMT>([^<]*)<\/PLSUBAMT>/g)].map(m => parseFloat(m[1]) || 0);

    if (names.length === 0) {
      logStep('P&L', '⚠️  no line items found in Tally P&L response');
      return;
    }

    let upserted = 0;
    await withTransaction(async (client) => {
      for (let i = 0; i < names.length; i++) {
        const groupName  = names[i];
        const mainAmount = mains[i] || 0;
        const subAmount  = subs[i]  || 0;

        await client.query(`
          INSERT INTO pl_items
            (company_id, group_name, main_amount, sub_amount, period_from, period_to, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT (company_id, group_name, period_from, period_to)
          DO UPDATE SET main_amount=EXCLUDED.main_amount, sub_amount=EXCLUDED.sub_amount,
            synced_at=NOW()
        `, [companyId, groupName, mainAmount, subAmount, fromDate, toDate]);
        upserted++;
      }
    });

    logStep('P&L ✅', `${upserted} items stored | ${humanMs(Date.now()-t0)}`);

  } catch (err) {
    logger.error(`[syncEngine] ❌ P&L FAILED "${company.name}": ${err.message}`);
  }
}

// ── Vouchers ───────────────────────────────────────────────────────────────────

async function syncVouchers(company) {
  const { id: companyId, tally_name: tallyName, fiscal_year_from, initial_sync_done } = company;
  const t0 = Date.now();
  logStep('VOUCHERS', `start — company: "${company.name}"`);
  await syncLogs.startSync(companyId, 'vouchers');

  try {
    const toDate = todayIso();
    let fromDate;

    if (!initial_sync_done) {
      fromDate = fiscal_year_from
        ? (fiscal_year_from instanceof Date
            ? fiscal_year_from.toISOString().slice(0, 10)
            : String(fiscal_year_from).slice(0, 10))
        : '2024-04-01';
      logStep('VOUCHERS', `FULL SYNC | range: ${fromDate} → ${toDate}`);
    } else {
      const lastSynced = await syncLogs.getLastSyncedDate(companyId, 'vouchers');
      const base       = lastSynced || toDate;
      fromDate         = subtractDays(base, config.sync.backfillDays);
      logStep('VOUCHERS', `INCREMENTAL | range: ${fromDate} → ${toDate}`);
    }

    // ── Fetch ────────────────────────────────────────────────────────────────
    logStep('VOUCHERS', '📡 sending to Tally...');
    const fetchStart = Date.now();
    const xml  = templates.buildAllVouchersRequest(tallyName, fromDate, toDate);
    const raw  = await tallyClient.request(xml);
    logStep('VOUCHERS', `📥 got ${humanBytes(raw.length)} in ${humanMs(Date.now() - fetchStart)}`);

    // ── Parse ────────────────────────────────────────────────────────────────
    const estTime = estimateParseTime(raw.length);
    logStep('VOUCHERS', `⚙️  parsing ${humanBytes(raw.length)} — NOTE: output pauses here ${estTime} (normal)`);
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseVouchers(parsed, companyId);
    logStep('VOUCHERS', `✅ parsed ${records.length} vouchers in ${humanMs(Date.now() - parseStart)}`);

    if (records.length === 0) {
      await syncLogs.successSync(companyId, 'vouchers', toDate, { fetched: 0, upserted: 0 });
      if (!initial_sync_done) await syncLogs.markInitialSyncDone(companyId);
      logStep('VOUCHERS', '⏭  0 records — Tally has no data for this range');
      return;
    }

    // ── DB Upsert (inside transaction) ───────────────────────────────────────
    logStep('VOUCHERS', `💾 writing ${records.length} vouchers inside 1 transaction (fast)...`);
    const dbStart = Date.now();
    let upserted = 0;

    await withTransaction(async (client) => {
      for (const r of records) {
        const vRes = await client.query(
          `INSERT INTO vouchers (company_id,vch_no,date,vch_type,party_name,narration,total_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (company_id,vch_no,vch_type)
           DO UPDATE SET date=EXCLUDED.date, party_name=EXCLUDED.party_name,
             narration=EXCLUDED.narration, total_amount=EXCLUDED.total_amount, synced_at=NOW()
           RETURNING id`,
          [r.companyId, r.vchNo, r.date, r.vchType, r.partyName, r.narration, r.totalAmount]
        );
        const voucherId = vRes.rows[0]?.id;
        if (!voucherId) continue;

        await client.query('DELETE FROM voucher_ledger_entries    WHERE voucher_id=$1', [voucherId]);
        await client.query('DELETE FROM voucher_inventory_entries WHERE voucher_id=$1', [voucherId]);

        for (const le of r.ledgerEntries) {
          await client.query(
            `INSERT INTO voucher_ledger_entries (voucher_id,ledger_name,amount,is_party_ledger,is_deemed_positive)
             VALUES ($1,$2,$3,$4,$5)`,
            [voucherId, le.ledgerName, le.amount, le.isParty, le.isDeemedPositive]
          );
        }
        for (const ie of r.inventoryEntries) {
          await client.query(
            `INSERT INTO voucher_inventory_entries (voucher_id,item_name,quantity,unit,rate,amount,sales_officer,area_city,state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [voucherId, ie.itemName, ie.quantity, ie.unit, ie.rate, ie.amount,
             ie.salesOfficer, ie.areaCity, ie.state]
          );
        }
        upserted++;
        if (upserted % 25 === 0 || upserted === records.length) {
          progressBar('vouchers', upserted, records.length, dbStart);
        }
      }
    });

    await syncLogs.successSync(companyId, 'vouchers', toDate, { fetched: records.length, upserted });
    if (!initial_sync_done) await syncLogs.markInitialSyncDone(companyId);
    logStep('VOUCHERS ✅', `${upserted}/${records.length} in DB | DB write: ${humanMs(Date.now()-dbStart)} | total: ${humanMs(Date.now()-t0)}`);

  } catch (err) {
    await syncLogs.failSync(companyId, 'vouchers', err.message);
    logger.error(`[syncEngine] ❌ VOUCHERS FAILED "${company.name}": ${err.message}`);
  }
}

// ── Ledger Masters (STREAMING) ────────────────────────────────────────────────
// Uses SAX streaming parser — never loads 55 MB into memory.
// Shows real-time download + parse progress every 2 MB.

async function syncLedgers(company) {
  const { id: companyId, tally_name: tallyName, fiscal_year_from } = company;
  const t0 = Date.now();
  logStep('LEDGERS', `start — company: "${company.name}"`);
  await syncLogs.startSync(companyId, 'ledgers');

  try {
    // ── Date range for closing balance computation ────────────────────────
    // SVFROMDATE + SVTODATE are REQUIRED — without them Tally returns 0 for all balances.
    const fromDate = fiscal_year_from
      ? (fiscal_year_from instanceof Date
          ? fiscal_year_from.toISOString().slice(0, 10)
          : String(fiscal_year_from).slice(0, 10))
      : '2024-04-01';
    const toDate = todayIso();

    // ── Open streaming HTTP connection to Tally ───────────────────────────
    logStep('LEDGERS', `📡 opening stream to Tally (balance as of ${fromDate}→${toDate})...`);
    const xml    = templates.buildLedgerMasterRequest(tallyName, fromDate, toDate);
    const stream = await tallyClient.requestStream(xml);


    // ── Stream-parse: download + SAX parse simultaneously ────────────────
    logStep('LEDGERS', '⚙️  streaming download + parsing simultaneously...');
    let lastLoggedMB = 0;

    const { streamParseLedgers } = require('../tally/streamParser');

    const records = await streamParseLedgers(stream, companyId, (bytesReceived, recordsParsed) => {
      const mb = bytesReceived / (1024 * 1024);
      if (mb - lastLoggedMB >= 4) {   // log every 4 MB
        logStep('LEDGERS',
          `📥 downloaded ${mb.toFixed(1)} MB | parsed ${recordsParsed} ledgers so far | ` +
          `elapsed: ${humanMs(Date.now() - t0)}`
        );
        lastLoggedMB = mb;
      }
    });

    logStep('LEDGERS', `✅ stream complete — ${records.length} ledgers parsed in ${humanMs(Date.now() - t0)}`);

    if (records.length === 0) {
      await syncLogs.successSync(companyId, 'ledgers', todayIso(), { fetched: 0, upserted: 0 });
      logStep('LEDGERS', '⏭  0 ledgers found in Tally response');
      return;
    }

    // ── DB Upsert inside single transaction (fast) ───────────────────────
    logStep('LEDGERS', `💾 writing ${records.length} ledgers to DB (1 transaction)...`);
    const dbStart = Date.now();
    let upserted  = 0;

    await withTransaction(async (client) => {
      for (const r of records) {
        await client.query(
          `INSERT INTO ledgers (company_id,name,parent_group,opening_balance,closing_balance,gst_no,state,synced_at)
           VALUES ($1,$2,$3,$4,$4,$5,$6,NOW())
           ON CONFLICT (company_id,name)
           DO UPDATE SET parent_group=EXCLUDED.parent_group,
             opening_balance=EXCLUDED.opening_balance,
             gst_no=EXCLUDED.gst_no, state=EXCLUDED.state, synced_at=NOW()`,
          [r.companyId, r.name, r.parentGroup, r.openingBalance, r.gstNo, r.state]
        );
        upserted++;
        if (upserted % 100 === 0 || upserted === records.length) {
          progressBar('ledgers', upserted, records.length, dbStart);
        }
      }
    });

    await syncLogs.successSync(companyId, 'ledgers', todayIso(), { fetched: records.length, upserted });
    logStep('LEDGERS ✅', `${upserted} in DB | DB write: ${humanMs(Date.now()-dbStart)} | total: ${humanMs(Date.now()-t0)}`);

  } catch (err) {
    await syncLogs.failSync(companyId, 'ledgers', err.message);
    logger.error(`[syncEngine] ❌ LEDGERS FAILED "${company.name}": ${err.message}`);
    logger.error(err.stack);
  }
}


// ── Stock Items ────────────────────────────────────────────────────────────────

async function syncStockItems(company) {
  const { id: companyId, tally_name: tallyName } = company;
  const t0 = Date.now();
  logStep('STOCK ITEMS', `start — company: "${company.name}"`);
  await syncLogs.startSync(companyId, 'stock_items');
  try {
    logStep('STOCK ITEMS', '📡 sending to Tally...');
    const fetchStart = Date.now();
    const xml  = templates.buildStockItemsRequest(tallyName);
    const raw  = await tallyClient.request(xml);
    logStep('STOCK ITEMS', `📥 got ${humanBytes(raw.length)} in ${humanMs(Date.now()-fetchStart)}`);

    logStep('STOCK ITEMS', `⚙️  parsing ${humanBytes(raw.length)} — NOTE: output pauses ${estimateParseTime(raw.length)} (normal)`);
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseStockItems(parsed, companyId);
    logStep('STOCK ITEMS', `✅ parsed ${records.length} items in ${humanMs(Date.now()-parseStart)}`);

    if (records.length === 0) {
      await syncLogs.successSync(companyId, 'stock_items', todayIso(), { fetched: 0, upserted: 0 });
      logStep('STOCK ITEMS', '⏭  0 records from Tally');
      return;
    }

    logStep('STOCK ITEMS', `💾 writing ${records.length} items inside 1 transaction...`);
    const dbStart = Date.now();
    let upserted = 0;

    await withTransaction(async (client) => {
      for (const r of records) {
        await client.query(
          `INSERT INTO stock_items (company_id,name,parent_group,base_unit,closing_qty,closing_value,synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (company_id,name)
           DO UPDATE SET parent_group=EXCLUDED.parent_group, base_unit=EXCLUDED.base_unit,
             closing_qty=EXCLUDED.closing_qty, closing_value=EXCLUDED.closing_value, synced_at=NOW()`,
          [r.companyId, r.name, r.parentGroup, r.baseUnit, r.closingQty, r.closingValue]
        );
        upserted++;
        if (upserted % 50 === 0 || upserted === records.length) {
          progressBar('stock items', upserted, records.length, dbStart);
        }
      }
    });

    await syncLogs.successSync(companyId, 'stock_items', todayIso(), { fetched: records.length, upserted });
    logStep('STOCK ITEMS ✅', `${upserted} in DB | total: ${humanMs(Date.now()-t0)}`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'stock_items', err.message);
    logger.error(`[syncEngine] ❌ STOCK ITEMS FAILED "${company.name}": ${err.message}`);
  }
}

// ── Outstanding ────────────────────────────────────────────────────────────────

async function syncOutstanding(company) {
  const { id: companyId, tally_name: tallyName } = company;
  const t0 = Date.now();
  logStep('OUTSTANDING', `start — company: "${company.name}"`);
  await syncLogs.startSync(companyId, 'outstanding');
  try {
    logStep('OUTSTANDING', '📡 sending to Tally...');
    const fetchStart = Date.now();
    const xml  = templates.buildOutstandingRequest(tallyName);
    const raw  = await tallyClient.request(xml);
    logStep('OUTSTANDING', `📥 got ${humanBytes(raw.length)} in ${humanMs(Date.now()-fetchStart)}`);

    logStep('OUTSTANDING', `⚙️  parsing ${humanBytes(raw.length)} — NOTE: output pauses ${estimateParseTime(raw.length)} (normal)`);
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseOutstanding(parsed, companyId);
    logStep('OUTSTANDING', `✅ parsed ${records.length} records in ${humanMs(Date.now()-parseStart)}`);

    if (records.length === 0) {
      await syncLogs.successSync(companyId, 'outstanding', todayIso(), { fetched: 0, upserted: 0 });
      logStep('OUTSTANDING', '⏭  0 records from Tally');
      return;
    }

    logStep('OUTSTANDING', `💾 replacing ${records.length} records inside 1 transaction...`);
    const dbStart = Date.now();
    let inserted = 0;

    await withTransaction(async (client) => {
      await client.query('DELETE FROM outstanding WHERE company_id=$1', [companyId]);
      for (const r of records) {
        await client.query(
          `INSERT INTO outstanding (company_id,party_name,total_outstanding,synced_at)
           VALUES ($1,$2,$3,NOW())
           ON CONFLICT (company_id,party_name)
           DO UPDATE SET total_outstanding=EXCLUDED.total_outstanding, synced_at=NOW()`,
          [r.companyId, r.partyName, r.totalOutstanding]
        );
        inserted++;
        if (inserted % 50 === 0 || inserted === records.length) {
          progressBar('outstanding', inserted, records.length, dbStart);
        }
      }
    });

    await syncLogs.successSync(companyId, 'outstanding', todayIso(), { fetched: records.length, upserted: records.length });
    logStep('OUTSTANDING ✅', `${inserted} records | total: ${humanMs(Date.now()-t0)}`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'outstanding', err.message);
    logger.error(`[syncEngine] ❌ OUTSTANDING FAILED "${company.name}": ${err.message}`);
  }
}

// ── Compute Closing Balances ───────────────────────────────────────────────────
// CLOSINGBALANCE is not exported by Tally's List of Accounts API.
// Formula: closing_balance = opening_balance + SUM(all ledger entries in vouchers this year)
// This runs once after both ledger masters AND vouchers are synced.
async function computeClosingBalances(company) {
  const { id: companyId } = company;
  const t0 = Date.now();
  logStep('CLOSING BAL', `Computing for company: "${company.name}"`);

  try {
    const client = await pool.connect();
    try {
      // Single-pass UPDATE: join ledgers → aggregated voucher_ledger_entries
      const result = await client.query(`
        UPDATE ledgers l
        SET closing_balance = l.opening_balance + COALESCE(vs.net_amount, 0)
        FROM (
          SELECT
            v.company_id,
            LOWER(TRIM(vle.ledger_name)) AS ledger_key,
            SUM(vle.amount)              AS net_amount
          FROM voucher_ledger_entries vle
          JOIN vouchers v ON v.id = vle.voucher_id
          WHERE v.company_id = $1
          GROUP BY v.company_id, LOWER(TRIM(vle.ledger_name))
        ) vs
        WHERE l.company_id = vs.company_id
          AND LOWER(TRIM(l.name)) = vs.ledger_key
        RETURNING l.id
      `, [companyId]);

      // Ledgers with NO transactions keep closing_balance = opening_balance
      await client.query(`
        UPDATE ledgers
        SET closing_balance = opening_balance
        WHERE company_id = $1
          AND closing_balance = 0
          AND opening_balance <> 0
      `, [companyId]);

      logStep('CLOSING BAL ✅', `Updated ${result.rowCount} ledgers in ${humanMs(Date.now()-t0)}`);
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`[syncEngine] ❌ CLOSING BAL FAILED "${company.name}": ${err.message}`);
  }
}


async function runSyncCycle({ includeMasters = false } = {}) {
  const cycleStart = Date.now();

  logger.info('[syncEngine] ════════════════════════════════════════════');
  logger.info('[syncEngine]  SYNC CYCLE START');
  logger.info('[syncEngine] ════════════════════════════════════════════');

  // 1. Tally health check
  logger.info('[syncEngine] 🔍 Pinging Tally...');
  const alive = await tallyClient.ping();
  if (!alive) {
    logger.warn('[syncEngine] ❌ Tally NOT reachable — skipping cycle.');
    return;
  }
  logger.info('[syncEngine] ✅ Tally is alive');

  // 2. Load active companies
  const { rows: companies } = await pool.query(
    'SELECT * FROM companies WHERE is_active=true ORDER BY id ASC'
  );
  logger.info(`[syncEngine] 📋 ${companies.length} company/companies to process`);

  if (companies.length === 0) {
    logger.warn('[syncEngine] No active companies — check TALLY_COMPANIES in .env.');
    return;
  }

  // 3. Process sequentially
  for (const company of companies) {
    // Trial Balance + P&L are tiny (~1-6KB) — always refresh regardless of historical status
    await syncTrialBalance(company);
    await syncProfitAndLoss(company);

    if (company.is_historical && company.initial_sync_done) {
      logger.info(`[syncEngine] ⏭  Skipping "${company.name}" (historical, fully synced already)`);
      continue;
    }

    const compStart = Date.now();
    logger.info(`[syncEngine] ────────────────────────────────────────────`);
    logger.info(`[syncEngine]  ▶▶ COMPANY: "${company.name}"  (id=${company.id})`);
    logger.info(`[syncEngine]     historical=${company.is_historical} | initial_done=${company.initial_sync_done}`);
    logger.info(`[syncEngine] ────────────────────────────────────────────`);

    await syncVouchers(company);
    await syncTrialBalance(company);  // always refresh — tiny 1KB request

    if (includeMasters || !company.initial_sync_done) {
      logger.info(`[syncEngine]   [masters: ledgers → stock items → outstanding → closing balances]`);
      await syncLedgers(company);
      await syncStockItems(company);
      await syncOutstanding(company);
      await computeClosingBalances(company);
    } else {
      await computeClosingBalances(company);
      logger.info(`[syncEngine]   [masters skipped — incremental voucher-only cycle]`);
    }

    logger.info(`[syncEngine]  ✅ COMPANY "${company.name}" done in ${humanMs(Date.now()-compStart)}`);
  }

  logger.info('[syncEngine] ════════════════════════════════════════════');
  logger.info(`[syncEngine]  SYNC CYCLE COMPLETE — total: ${humanMs(Date.now()-cycleStart)}`);
  logger.info('[syncEngine] ════════════════════════════════════════════');
}

module.exports = { runSyncCycle, syncVouchers, syncLedgers, syncStockItems, syncOutstanding, syncTrialBalance, syncProfitAndLoss };
