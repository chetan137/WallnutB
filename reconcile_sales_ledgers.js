'use strict';
/**
 * reconcile_sales_ledgers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY (SELECTs only, DB only — no Tally, so pm2 can keep running).
 *
 * reconcile_sales.js showed the dashboard's Sales (sum of item-line amounts of
 * Sales vouchers) is ~11-17 lakh/month ABOVE Tally's "Sales Accounts", and that
 * subtracting Credit Notes alone does not close the gap. Tally's own figure is
 * the net of every posting to the ledgers of the "Sales Accounts" group
 * (credit notes, adjustments and all), with "Branch Trf-Sales" a separate group.
 *
 * This sums exactly that from voucher_ledger_entries:
 *   PART 1  per month: Σ postings to ledgers whose group is "Sales Accounts"
 *           and to "Branch Trf-Sales", next to Tally's P&L figure and the
 *           dashboard's item-based figure. If "Sales Accounts" ≈ TALLY, the
 *           dashboard should be built from ledger postings.
 *   PART 2  one month in detail: every ledger in those groups (name, group,
 *           posting total, #vouchers, voucher types it appears in) plus the
 *           item-line total of the same vouchers — shows exactly where the
 *           item-based figure overshoots.
 *
 * Amount sign: Tally stores credits (sales) positive and debits negative in
 * these entries; totals are printed as stored, then as absolute values.
 *
 * Usage (in the tallybackend folder):
 *   node reconcile_sales_ledgers.js 25-26 [YYYY-MM for PART 2, default 2026-05]
 */

require('dotenv').config();
const pool = require('./db/pool');

// Tally P&L, company "…-2025-26": see reconcile_sales.js / debug_voucher_access_2526.js.
const TALLY_SALES = {
  '2026-04': 3673215.21, '2026-05': 6754084.16, '2026-06': 7533439.05,
  '2026-07': 6620483.37, '2026-08': 8004362.41,
};
const TALLY_BRANCH = {
  '2026-04': 678630.75, '2026-05': 214910, '2026-06': 743285.29,
  '2026-07': 330778.6, '2026-08': 316166.46,
};

const [, , arg, detailMonth = '2026-05'] = process.argv;
if (!arg) {
  console.error('Usage: node reconcile_sales_ledgers.js <company e.g. 25-26> [YYYY-MM]');
  process.exit(1);
}
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');

async function main() {
  const { rows: cos } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (cos.length !== 1) { console.log(`"${arg}" matched ${cos.length} companies — need exactly 1.`); return; }
  const co = cos[0];
  console.log(`Company: ${co.name} (id ${co.id})\n`);

  // Which groups exist that look like sales — so a wrong group name is visible.
  const { rows: groups } = await pool.query(`
    SELECT parent_group, COUNT(*) AS ledgers FROM ledgers
    WHERE company_id = $1 AND parent_group ILIKE ANY (ARRAY['%sales%', '%branch trf%', '%income%'])
    GROUP BY 1 ORDER BY 1`, [co.id]);
  console.log('Ledger groups that look sales/income related:');
  console.table(groups);

  // ── PART 1 ───────────────────────────────────────────────────────────────
  const { rows: months } = await pool.query(`
    SELECT to_char(v.date, 'YYYY-MM') AS month,
           SUM(vle.amount) FILTER (WHERE l.parent_group = 'Sales Accounts')      AS sales_raw,
           SUM(vle.amount) FILTER (WHERE l.parent_group ILIKE 'Branch Trf%Sales%') AS branch_raw,
           COUNT(DISTINCT v.id) FILTER (WHERE l.parent_group = 'Sales Accounts')  AS vouchers
    FROM voucher_ledger_entries vle
    JOIN vouchers v ON v.id = vle.voucher_id
    JOIN ledgers  l ON l.company_id = v.company_id AND l.name = vle.ledger_name
    WHERE v.company_id = $1 AND v.is_cancelled = false
      AND (l.parent_group = 'Sales Accounts' OR l.parent_group ILIKE 'Branch Trf%Sales%')
    GROUP BY 1 ORDER BY 1`, [co.id]);

  console.log('PART 1 — postings to ledgers of group "Sales Accounts" / "Branch Trf-Sales" (all voucher types):');
  console.log('month     SalesAcc(raw)   SalesAcc(abs)   TALLY Sales    diff    | Branch(abs)  TALLY Branch   #vouchers');
  for (const r of months) {
    const s = Number(r.sales_raw || 0), b = Number(r.branch_raw || 0);
    const ts = TALLY_SALES[r.month], tb = TALLY_BRANCH[r.month];
    console.log(
      `${r.month}  ${fmt(s).padStart(13)}  ${fmt(Math.abs(s)).padStart(13)}  ` +
      `${ts ? fmt(ts).padStart(11) : '          -'}  ${ts ? fmt(Math.abs(s) - ts).padStart(8) : '       -'} | ` +
      `${fmt(Math.abs(b)).padStart(10)}  ${tb ? fmt(tb).padStart(11) : '          -'}   ${String(r.vouchers).padStart(6)}`
    );
  }

  // ── PART 2 ───────────────────────────────────────────────────────────────
  console.log(`\nPART 2 — every ledger in those groups for ${detailMonth}:`);
  const { rows: ledgers } = await pool.query(`
    SELECT l.parent_group AS grp, vle.ledger_name AS ledger,
           SUM(vle.amount)::numeric(15,2) AS total_amount,
           COUNT(DISTINCT v.id) AS vouchers,
           string_agg(DISTINCT v.vch_type, ', ') AS voucher_types
    FROM voucher_ledger_entries vle
    JOIN vouchers v ON v.id = vle.voucher_id
    JOIN ledgers  l ON l.company_id = v.company_id AND l.name = vle.ledger_name
    WHERE v.company_id = $1 AND v.is_cancelled = false
      AND to_char(v.date, 'YYYY-MM') = $2
      AND (l.parent_group = 'Sales Accounts' OR l.parent_group ILIKE 'Branch Trf%Sales%')
    GROUP BY 1, 2 ORDER BY 1, 3 DESC`, [co.id, detailMonth]);
  console.table(ledgers);

  const { rows: items } = await pool.query(`
    SELECT v.vch_type, COUNT(DISTINCT v.id) AS vouchers, SUM(vie.amount)::numeric(15,2) AS item_total
    FROM vouchers v LEFT JOIN voucher_inventory_entries vie ON vie.voucher_id = v.id
    WHERE v.company_id = $1 AND v.is_cancelled = false
      AND to_char(v.date, 'YYYY-MM') = $2
      AND (v.vch_type ILIKE 'sales%' OR v.vch_type ILIKE 'credit note%')
    GROUP BY 1 ORDER BY 3 DESC`, [co.id, detailMonth]);
  console.log(`Item-line totals of the same month's Sales / Credit Note vouchers (what the dashboard adds up):`);
  console.table(items);

  console.log('Read it like this: if PART 1 "SalesAcc(abs)" is ~TALLY for Apr-Aug 2026, the dashboard');
  console.log('should total ledger postings instead of item lines. PART 2 shows which ledgers/voucher');
  console.log('types make the item-line total overshoot. Paste this ENTIRE output back.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
