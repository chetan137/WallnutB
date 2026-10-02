'use strict';
/**
 * diagnose_sales_by_type.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, DB only (pm2 can keep running).
 *
 * FY 24-25 after the Voucher-Register re-sync: dashboard Net Sales 9,74,42,135 vs
 * Tally P&L "Sales Accounts" 8,94,31,810 (+80 lakh); Branch 79,20,723 vs 59,57,452.
 * The dashboard only reads Sales and Credit Note vouchers, while Tally's group total
 * is the net of the postings of EVERY voucher type. This splits the postings to the
 * "Sales Accounts" / "Branch Trf-Sales" ledger groups by voucher type for the same
 * period as Tally's stored P&L snapshot, so the types the dashboard misses (Journal,
 * Debit Note, …) show up with their amounts, and lists the biggest such vouchers.
 *
 * Usage (in the tallybackend folder):   node diagnose_sales_by_type.js 24-25
 */

require('dotenv').config();
const pool = require('./db/pool');

const arg = process.argv[2];
if (!arg) { console.error('Usage: node diagnose_sales_by_type.js <company e.g. 24-25>'); process.exit(1); }
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');

async function show(label, sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    console.log(`\n── ${label}`);
    if (rows.length) console.table(rows); else console.log('   (no rows)');
    return rows;
  } catch (err) { console.log(`\n❌ ${label} FAILED: ${err.message}`); return []; }
}

async function main() {
  const { rows: cos } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (cos.length !== 1) { console.log(`"${arg}" matched ${cos.length} companies — need exactly 1.`); return; }
  const co = cos[0];
  console.log(`Company: ${co.name} (id ${co.id})`);

  const { rows: pl } = await pool.query(
    `SELECT group_name, main_amount, period_from::text AS f, period_to::text AS t FROM pl_items
     WHERE company_id = $1 AND (group_name ILIKE 'sales accounts' OR group_name ILIKE 'branch trf-sales')`, [co.id]);
  if (!pl.length) { console.log('No P&L snapshot for this company.'); return; }
  const from = pl[0].f, to = pl[0].t;
  const tallySales = Number((pl.find((r) => /^sales accounts$/i.test(r.group_name)) || {}).main_amount || 0);
  const tallyBranch = Number((pl.find((r) => /^branch trf-sales$/i.test(r.group_name)) || {}).main_amount || 0);
  console.log(`Period ${from} → ${to} | Tally P&L: Sales Accounts ${fmt(tallySales)}, Branch Trf-Sales ${fmt(tallyBranch)}`);

  const rows = await show('Postings to the Sales Accounts / Branch Trf-Sales groups, by voucher type (ALL types)',
    `SELECT v.vch_type, COUNT(DISTINCT v.id) AS vouchers,
            ROUND(SUM(e.amount) FILTER (WHERE l.parent_group = 'Sales Accounts'))        AS sales_accounts,
            ROUND(SUM(e.amount) FILTER (WHERE l.parent_group ILIKE 'Branch Trf%Sales%')) AS branch_trf_sales
     FROM voucher_ledger_entries e
     JOIN vouchers v ON v.id = e.voucher_id
     JOIN ledgers  l ON l.company_id = v.company_id AND l.name = e.ledger_name
     WHERE v.company_id = $1 AND v.is_cancelled = false AND v.date BETWEEN $2 AND $3
       AND (l.parent_group = 'Sales Accounts' OR l.parent_group ILIKE 'Branch Trf%Sales%')
     GROUP BY 1 ORDER BY 3 DESC NULLS LAST`, [co.id, from, to]);

  const totS = rows.reduce((s, r) => s + Number(r.sales_accounts || 0), 0);
  const totB = rows.reduce((s, r) => s + Number(r.branch_trf_sales || 0), 0);
  const dash = rows.filter((r) => /^(sales|credit note)/i.test(r.vch_type));
  const dashS = dash.reduce((s, r) => s + Number(r.sales_accounts || 0), 0);
  const dashB = dash.reduce((s, r) => s + Number(r.branch_trf_sales || 0), 0);
  console.log(`\nAll voucher types:      Sales Accounts ${fmt(totS)}   (Tally ${fmt(tallySales)}, diff ${fmt(totS - tallySales)})   | Branch ${fmt(totB)}   (Tally ${fmt(tallyBranch)}, diff ${fmt(totB - tallyBranch)})`);
  console.log(`Sales + Credit Note only (what the dashboard reads): Sales Accounts ${fmt(dashS)} | Branch ${fmt(dashB)}`);
  console.log(`=> missed by the dashboard: Sales Accounts ${fmt(totS - dashS)} | Branch ${fmt(totB - dashB)}`);

  await show('Biggest vouchers of the OTHER types (not Sales / Credit Note) posting to those groups',
    `SELECT v.date::text AS date, v.vch_type, v.vch_no, v.party_name,
            ROUND(SUM(e.amount) FILTER (WHERE l.parent_group = 'Sales Accounts'))        AS sales_accounts,
            ROUND(SUM(e.amount) FILTER (WHERE l.parent_group ILIKE 'Branch Trf%Sales%')) AS branch_trf_sales,
            LEFT(v.narration, 50) AS narration
     FROM voucher_ledger_entries e
     JOIN vouchers v ON v.id = e.voucher_id
     JOIN ledgers  l ON l.company_id = v.company_id AND l.name = e.ledger_name
     WHERE v.company_id = $1 AND v.is_cancelled = false AND v.date BETWEEN $2 AND $3
       AND v.vch_type !~* '^(sales|credit note)'
       AND (l.parent_group = 'Sales Accounts' OR l.parent_group ILIKE 'Branch Trf%Sales%')
     GROUP BY v.id, v.date, v.vch_type, v.vch_no, v.party_name, v.narration
     ORDER BY ABS(COALESCE(SUM(e.amount), 0)) DESC LIMIT 15`, [co.id, from, to]);

  console.log('\nHow to read: "All voucher types" should equal Tally. The rows other than Sales / Credit Note are what the');
  console.log('dashboard does not see. Paste this ENTIRE output back.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); process.exitCode = 1; })
  .finally(() => pool.end());
