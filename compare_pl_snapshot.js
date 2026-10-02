'use strict';
/**
 * compare_pl_snapshot.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, DB only (no Tally request, pm2 can keep running).
 *
 * Each sync cycle stores Tally's own Profit & Loss for the company (table
 * pl_items: "Sales Accounts", "Branch Trf-Sales", … for period_from → period_to,
 * with synced_at). That is Tally's figure AS OF THAT SNAPSHOT — so it can be set
 * against the dashboard's own net sales over exactly the same period without
 * asking Tally again. Use it to settle a month (e.g. Sep-2026) where the Tally
 * mobile app is stale: if the snapshot's "Sales Accounts" equals the dashboard
 * total, the extra rupees are real Tally entries, not a data problem.
 *
 * Usage (in the tallybackend folder):   node compare_pl_snapshot.js 25-26
 */

require('dotenv').config();
const pool = require('./db/pool');
const { buildSalesRecordsSql } = require('./utils/salesRecordsSql');

const arg = process.argv[2];
if (!arg) { console.error('Usage: node compare_pl_snapshot.js <company e.g. 25-26>'); process.exit(1); }
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function main() {
  const { rows: cos } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (cos.length !== 1) { console.log(`"${arg}" matched ${cos.length} companies — need exactly 1.`); return; }
  const co = cos[0];
  console.log(`Company: ${co.name} (id ${co.id})\n`);

  const { rows: pl } = await pool.query(
    `SELECT group_name, main_amount, period_from::text AS period_from, period_to::text AS period_to, synced_at
     FROM pl_items WHERE company_id = $1 AND (group_name ILIKE 'sales accounts' OR group_name ILIKE 'branch trf-sales')
     ORDER BY group_name`, [co.id]);
  if (!pl.length) { console.log('No P&L snapshot rows for Sales Accounts / Branch Trf-Sales.'); return; }
  console.log('Tally P&L snapshot stored by the sync:');
  console.table(pl.map((r) => ({ ...r, synced_at: new Date(r.synced_at).toLocaleString('en-GB') })));

  const salesRow = pl.find((r) => /^sales accounts$/i.test(r.group_name));
  const branchRow = pl.find((r) => /^branch trf-sales$/i.test(r.group_name));
  const from = (salesRow || branchRow).period_from, to = (salesRow || branchRow).period_to;

  const { rows } = await pool.query(
    buildSalesRecordsSql({ companyFilter: ' AND v.company_id = $1', dateFilter: ' AND v.date >= $2 AND v.date <= $3' }),
    [co.id, from, to]);
  let sale = 0, branch = 0;
  const byMonth = {};
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    const m = iso(r.date).slice(0, 7);
    byMonth[m] = byMonth[m] || { sale: 0, branch: 0 };
    if (r.invoiceCategory === 'sale') { sale += amt; byMonth[m].sale += amt; }
    else if (r.invoiceCategory === 'branch_transfer') { branch += amt; byMonth[m].branch += amt; }
  }

  console.log(`\nSame period (${from} → ${to}):`);
  console.log(`  Net Sales   dashboard ${fmt(sale).padStart(14)}   Tally P&L "Sales Accounts"    ${fmt(salesRow && salesRow.main_amount).padStart(14)}   diff ${fmt(sale - Number(salesRow ? salesRow.main_amount : 0))}`);
  console.log(`  Branch      dashboard ${fmt(branch).padStart(14)}   Tally P&L "Branch Trf-Sales"  ${fmt(branchRow && branchRow.main_amount).padStart(14)}   diff ${fmt(branch - Number(branchRow ? branchRow.main_amount : 0))}`);
  console.log('\nHow to read: diff ~0 → the dashboard equals Tally as of the snapshot time (see synced_at above),');
  console.log('so any gap to an older Tally figure (e.g. the mobile app) is just entries made after that figure. Paste this ENTIRE output back.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); process.exitCode = 1; })
  .finally(() => pool.end());
