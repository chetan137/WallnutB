'use strict';
/**
 * sync_ledger_contacts.js
 * One-time backfill of ledger contact fields (address, pincode, country, mailing name, GST type,
 * phone, email, contact person) for ONE company. Run once for each of 24-25, 25-26, 26-27,
 * switching the company in Tally each time. Read-only on Tally; only adds values to `ledgers`.
 *
 *   pm2 stop tally-sync
 *   node sync_ledger_contacts.js 24-25
 *   node sync_ledger_contacts.js 25-26
 *   node sync_ledger_contacts.js 26-27
 *   pm2 start tally-sync
 */
require('dotenv').config();
const pool = require('./db/pool');
const { syncLedgerContacts } = require('./tally/ledgerContacts');

const arg = process.argv[2];
if (!arg) { console.error('Usage: node sync_ledger_contacts.js <company e.g. 25-26>'); process.exit(1); }

(async () => {
  const { rows } = await pool.query('SELECT * FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (rows.length !== 1) { console.log(`"${arg}" matched ${rows.length} companies — need exactly 1.`); return; }
  console.log(`Company: ${rows[0].name} — make sure it is the one open in Tally.`);
  console.log(await syncLedgerContacts(rows[0]));
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
