'use strict';
/**
 * fix_company1_stockitems.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-off: refresh ONLY company 1's stock_items, bypassing runSyncCycle()'s
 * "historical + initial_sync_done → skip everything" gate (which is correct
 * for normal cycles — company 1 never needs its vouchers re-walked — but
 * also means its masters never refresh again automatically).
 *
 * Run this ONCE, with Tally focused on "Wallnut Building Solutions India
 * Pvt Ltd-2024-25", to pick up the stock_items fix (real items instead of
 * group rollups) for company 1 too, without re-running its 53-chunk full
 * voucher backfill.
 *
 * Run: node fix_company1_stockitems.js
 */

require('dotenv').config();
const pool       = require('./db/pool');
const syncEngine = require('./sync/syncEngine');

async function main() {
  const { rows } = await pool.query('SELECT * FROM companies WHERE id = 1');
  const company = rows[0];
  if (!company) {
    console.log('Company 1 not found.');
    return;
  }
  console.log(`Refreshing stock_items for: ${company.name} (Tally: "${company.tally_name}")`);
  await syncEngine.syncStockItems(company);
  console.log('Done — check stock_items for company_id=1 in Postgres.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); })
  .finally(() => pool.end());
