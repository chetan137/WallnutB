'use strict';
/**
 * tally/ledgerContacts.js
 * Reads ledger master contact fields (address, pincode, country, mailing name, GST
 * registration type, phone, email, contact person) from Tally and stores them in `ledgers`.
 *
 * Read-only on Tally. Verified tag names (check_ledger_contact_fields.js, TallyPrime):
 *   top level            COUNTRYNAME, MAILINGNAME, LEDSTATENAME, LEDGERPHONE, LEDGERMOBILE, EMAIL, LEDGERCONTACT, PARTYGSTIN
 *   LEDGSTREGDETAILS.LIST  GSTREGISTRATIONTYPE        (can repeat, one per APPLICABLEFROM)
 *   LEDMAILINGDETAILS.LIST ADDRESS.LIST/ADDRESS (many lines), PINCODE, MAILINGNAME, STATE, COUNTRY
 * When a tag repeats, the LAST non-empty value wins (latest APPLICABLEFROM).
 */

const tallyClient = require('./client');
const logger      = require('../utils/logger');
const pool        = require('../db/pool');
const query       = (...a) => pool.query(...a);

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildLedgerContactsRequest(companyName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>WnLedgerContacts</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="WnLedgerContacts" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
        <TYPE>Ledger</TYPE>
        <FETCH>Name, Parent, Address, PinCode, CountryName, MailingName, GSTRegistrationType, LedgerPhone, LedgerMobile, Email, LedgerContact, LedStateName, StateName, PartyGSTIN, LedMailingDetails, LedGSTRegDetails</FETCH>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;
}

function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
const clean = (s) => decode(s).replace(/[\x00-\x08\x0b-\x1f]/g, '').replace(/\s+/g, ' ').trim();

/** Tally's "\x04 Any" (any state) -> null, empty -> null. */
function normState(s) {
  const raw = decode(s || '').replace(/\x04/g, '').trim();
  return !raw || /^any$/i.test(raw) ? null : raw;
}

const values = (block, tag) =>
  [...block.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => clean(m[1])).filter(Boolean);
const lastValue = (block, tag) => { const v = values(block, tag); return v.length ? v[v.length - 1] : null; };

function parseContactBlock(block) {
  const name = clean((block.match(/<LEDGER[^>]*\sNAME="([^"]*)"/) || [])[1] || '');
  if (!name) return null;

  // Address lines: take the LAST mailing block that has any.
  let address = null;
  const mailBlocks = [...block.matchAll(/<LEDMAILINGDETAILS\.LIST>[\s\S]*?<\/LEDMAILINGDETAILS\.LIST>/g)].map((m) => m[0]);
  for (const mb of mailBlocks) { const lines = values(mb, 'ADDRESS'); if (lines.length) address = lines.join(', '); }
  if (!address) { const lines = values(block, 'ADDRESS'); if (lines.length) address = lines.join(', '); }

  return {
    name,
    address,
    pincode:               lastValue(block, 'PINCODE'),
    country:               lastValue(block, 'COUNTRYNAME') || lastValue(block, 'COUNTRY'),
    mailingName:           lastValue(block, 'MAILINGNAME'),
    gstRegistrationType:   lastValue(block, 'GSTREGISTRATIONTYPE'),
    phone:                 lastValue(block, 'LEDGERPHONE') || lastValue(block, 'LEDGERMOBILE'),
    email:                 lastValue(block, 'EMAIL'),
    contactPerson:         lastValue(block, 'LEDGERCONTACT'),
    state:                 normState(lastValue(block, 'LEDSTATENAME') || lastValue(block, 'STATENAME') || lastValue(block, 'STATE') || ''),
  };
}

async function ensureColumns() {
  await query(`ALTER TABLE ledgers
    ADD COLUMN IF NOT EXISTS address TEXT,
    ADD COLUMN IF NOT EXISTS pincode TEXT,
    ADD COLUMN IF NOT EXISTS country TEXT,
    ADD COLUMN IF NOT EXISTS mailing_name TEXT,
    ADD COLUMN IF NOT EXISTS gst_registration_type TEXT,
    ADD COLUMN IF NOT EXISTS phone TEXT,
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS contact_person TEXT`);
}

/**
 * Fetches the contact fields of every ledger of one company and updates the existing
 * `ledgers` rows (by company_id + name). A value Tally returns empty never overwrites a stored one.
 * @returns {{ fetched:number, updated:number }}
 */
async function syncLedgerContacts(company) {
  await ensureColumns();
  const raw = await tallyClient.request(buildLedgerContactsRequest(company.tally_name || company.tallyName));
  const blocks = [...raw.matchAll(/<LEDGER[ >][\s\S]*?<\/LEDGER>/g)].map((m) => m[0]);
  let updated = 0;
  for (const b of blocks) {
    const r = parseContactBlock(b);
    if (!r) continue;
    const res = await query(
      `UPDATE ledgers SET
         address               = COALESCE($3, address),
         pincode               = COALESCE($4, pincode),
         country               = COALESCE($5, country),
         mailing_name          = COALESCE($6, mailing_name),
         gst_registration_type = COALESCE($7, gst_registration_type),
         phone                 = COALESCE($8, phone),
         email                 = COALESCE($9, email),
         contact_person        = COALESCE($10, contact_person),
         state                 = COALESCE($11, state)
       WHERE company_id = $1 AND name = $2`,
      [company.id, r.name, r.address, r.pincode, r.country, r.mailingName, r.gstRegistrationType, r.phone, r.email, r.contactPerson, r.state]
    );
    updated += res.rowCount;
  }
  await query(`UPDATE ledgers SET state = NULL WHERE company_id = $1 AND state ~* '^[[:cntrl:][:space:]]*any$'`, [company.id]);
  logger.info(`[ledgerContacts] "${company.name}": ${blocks.length} ledgers read, ${updated} rows updated`);
  return { fetched: blocks.length, updated };
}

module.exports = { syncLedgerContacts, parseContactBlock, normState, ensureColumns };
