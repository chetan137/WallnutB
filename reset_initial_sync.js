'use strict';
/**
 * reset_initial_sync.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Makes the sync redo the FULL voucher backfill for one company, without psql
 * and without deleting anything.
 *
 * It flips ONE flag — companies.initial_sync_done = false — for the company
 * you name. No voucher, ledger or any other row is deleted or changed; the
 * sync upserts (ON CONFLICT DO UPDATE), so existing data stays and the
 * re-fetched vouchers just refresh it. Uses the same .env / DB settings as
 * the sync service itself.
 *
 * Usage (in the tallybackend folder):
 *   node reset_initial_sync.js              → only SHOWS the companies (changes nothing)
 *   node reset_initial_sync.js 25-26        → resets the company whose name contains "25-26"
 */

require('dotenv').config();
const pool = require('./db/pool');

const arg = process.argv[2];

async function show(label) {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.is_historical, c.initial_sync_done,
           (SELECT COUNT(*) FROM vouchers v WHERE v.company_id = c.id) AS vouchers_in_db,
           (SELECT MIN(date)::text FROM vouchers v WHERE v.company_id = c.id) AS first_voucher,
           (SELECT MAX(date)::text FROM vouchers v WHERE v.company_id = c.id) AS last_voucher
    FROM companies c ORDER BY c.id`);
  console.log(`\n${label}`);
  console.table(rows);
}

async function main() {
  await show('Companies in the DB right now:');

  if (!arg) {
    console.log('\nNothing changed. To redo the backfill for one company run e.g.:  node reset_initial_sync.js 25-26');
    return;
  }

  const { rows: matches } = await pool.query(
    'SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (matches.length !== 1) {
    console.log(`\n❌ "${arg}" matched ${matches.length} companies — need exactly 1. Nothing changed.`);
    return;
  }

  await pool.query('UPDATE companies SET initial_sync_done = false WHERE id = $1', [matches[0].id]);
  console.log(`\n✅ "${matches[0].name}": initial_sync_done set to false. No data was deleted.`);
  console.log('   Now start the sync:  pm2 restart tally-sync   (the next cycle does the full backfill)');
  await show('After:');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
