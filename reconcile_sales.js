'use strict';
/**
 * reconcile_sales.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY (SELECTs only). Compares, month by month, what the DASHBOARD would
 * count as sales against Tally's own "Sales Accounts" figure, to decide how
 * Credit Notes / Branch Transfer / Sample invoices must be treated so the
 * dashboard matches Tally.
 *
 * Per month it prints (all excl. GST, item amounts — same as the dashboard):
 *   sales        Sales vouchers that are plain sales (not Branch Transfer / Sample)
 *   cn_sales     Credit Notes touching a SALES ledger (likely real sales returns)
 *   cn_other     Credit Notes touching no sales ledger (expense/marketing adjustments)
 *   branch       Branch Transfer invoices      (Tally keeps these OUT of "Sales Accounts")
 *   sample       Sample invoices
 *   TALLY        Tally P&L "Sales Accounts" for that month (reference values below,
 *                taken from debug_voucher_access_2526.js — company 25-26 only)
 *   diff_a       sales            − TALLY
 *   diff_b       sales − cn_sales − TALLY
 * The column whose diff is closest to 0 is the rule the dashboard should follow.
 *
 * Uses the same .env / DB as the sync service. Does not touch Tally.
 *
 * Usage (in the tallybackend folder):
 *   node reconcile_sales.js 25-26
 *   node reconcile_sales.js 24-25
 */

require('dotenv').config();
const pool = require('./db/pool');

// Tally P&L "Sales Accounts" per month, company "…-2025-26" (excl. GST).
// Source: debug_voucher_access_2526.js PART 1 (matches Tally's mobile app).
const TALLY_SALES = {
  '2025-04': 7806115.89, '2025-05': 7628581.79, '2025-06': 6328772.40, '2025-07': 7220744.34,
  '2025-08': 7639718.55, '2025-09': 8145824.52, '2025-10': 7502430.24, '2025-11': 8152804.06,
  '2025-12': 7542176.34, '2026-01': 7477302.40, '2026-02': 7728421.78, '2026-03': 9559016.73,
  '2026-04': 3673215.21, '2026-05': 6754084.16, '2026-06': 7533439.05, '2026-07': 6620483.37,
  '2026-08': 8004362.41, '2026-09': 7864163.25,
};

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node reconcile_sales.js <company name part, e.g. 25-26>');
  process.exit(1);
}

const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');

// Same Branch Transfer / Sample rules as backend/services/dbDataService.js
// (INVOICE_CATEGORY_SQL) — keep in sync.
const CATEGORY_SQL = `
  CASE
    WHEN EXISTS (
           SELECT 1 FROM voucher_ledger_entries e
           LEFT JOIN ledgers el ON el.company_id = v.company_id AND el.name = e.ledger_name
           WHERE e.voucher_id = v.id
             AND (el.parent_group ILIKE 'Branch Trf%Sales%' OR e.ledger_name ILIKE '%branch transfer%')
         )
         OR pl.parent_group ILIKE '%Branch Trf%'
         OR pl.parent_group ILIKE 'Branch / Divisions'
      THEN 'branch_transfer'
    WHEN v.vch_type ILIKE 'promotional invoice%'
         OR EXISTS (
           SELECT 1 FROM voucher_ledger_entries e
           WHERE e.voucher_id = v.id
             AND e.ledger_name ILIKE ANY (ARRAY['free gift%', 'free promotional%', 'free sample%', 'sample sale%'])
         )
      THEN 'sample'
    ELSE 'sale'
  END`;

async function main() {
  const { rows: cos } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (cos.length !== 1) {
    console.log(`"${arg}" matched ${cos.length} companies — need exactly 1.`);
    return;
  }
  const co = cos[0];
  console.log(`Company: ${co.name} (id ${co.id})\n`);

  const { rows } = await pool.query(`
    WITH cat AS (
      SELECT v.id, v.date, v.vch_type, v.total_amount, ${CATEGORY_SQL} AS category,
             EXISTS (SELECT 1 FROM voucher_ledger_entries e
                     WHERE e.voucher_id = v.id AND e.is_party_ledger = false
                       AND e.ledger_name ILIKE '%sales%') AS touches_sales_ledger
      FROM vouchers v
      LEFT JOIN ledgers pl ON pl.company_id = v.company_id AND pl.name = v.party_name
      WHERE v.company_id = $1 AND v.is_cancelled = false
        AND (v.vch_type ILIKE 'sales%' OR v.vch_type ILIKE 'credit note%')
    ), lines AS (
      SELECT c.*, COALESCE(vie.amount, c.total_amount) AS amt
      FROM cat c LEFT JOIN voucher_inventory_entries vie ON vie.voucher_id = c.id
    )
    SELECT to_char(date, 'YYYY-MM') AS month,
      SUM(amt) FILTER (WHERE category = 'sale' AND vch_type ILIKE 'sales%')                              AS sales,
      SUM(amt) FILTER (WHERE category = 'sale' AND vch_type ILIKE 'credit note%' AND touches_sales_ledger)     AS cn_sales,
      SUM(amt) FILTER (WHERE category = 'sale' AND vch_type ILIKE 'credit note%' AND NOT touches_sales_ledger) AS cn_other,
      SUM(amt) FILTER (WHERE category = 'branch_transfer')                                                AS branch,
      SUM(amt) FILTER (WHERE category = 'sample')                                                         AS sample,
      COUNT(DISTINCT id) FILTER (WHERE category = 'sale' AND vch_type ILIKE 'credit note%')               AS cn_count
    FROM lines GROUP BY 1 ORDER BY 1`, [co.id]);

  console.log('month     sales        cn_sales     cn_other     branch       sample    #CN |  TALLY        diff_a(sales)  diff_b(sales-cn_sales)');
  let tot = { sales: 0, cn_sales: 0, cn_other: 0, branch: 0, sample: 0 };
  for (const r of rows) {
    const t = TALLY_SALES[r.month];
    const sales = Number(r.sales || 0), cns = Number(r.cn_sales || 0);
    for (const k of Object.keys(tot)) tot[k] += Number(r[k] || 0);
    console.log(
      `${r.month}  ${fmt(sales).padStart(11)}  ${fmt(cns).padStart(11)}  ${fmt(r.cn_other).padStart(11)}  ` +
      `${fmt(r.branch).padStart(11)}  ${fmt(r.sample).padStart(8)}  ${String(r.cn_count).padStart(4)} | ` +
      (t ? `${fmt(t).padStart(11)}  ${fmt(sales - t).padStart(12)}  ${fmt(sales - cns - t).padStart(14)}` : '  (no Tally reference for this month)')
    );
  }
  console.log(`\nTOTAL     ${fmt(tot.sales).padStart(11)}  ${fmt(tot.cn_sales).padStart(11)}  ${fmt(tot.cn_other).padStart(11)}  ${fmt(tot.branch).padStart(11)}  ${fmt(tot.sample).padStart(8)}`);
  console.log('\nRead it like this: a month where diff_b is ~0 but diff_a is not → Credit Notes on sales ledgers');
  console.log('must be SUBTRACTED from sales. diff_a ~0 → dashboard already matches. Partial months (Sep-26, and any');
  console.log('month the DB has not fully synced yet) will differ simply because data is missing.');
  console.log('\nPaste this ENTIRE output back.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
