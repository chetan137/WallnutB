'use strict';
/**
 * verify_net_sales.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, DB only (pm2 can keep running). Runs the EXACT SQL the dashboard
 * backend will use for its sales rows (utils/salesRecordsSql.js — a copy of
 * backend/services/salesRecordsSql.js) and, per month, compares the totals
 * with Tally's P&L: "Sales Accounts" for Net Sales and "Branch Trf-Sales" for
 * Branch Transfer. Run this BEFORE deploying the backend change: it proves the
 * SQL is valid on this DB and that the dashboard's numbers will match Tally.
 *
 * Usage (in the tallybackend folder):
 *   node verify_net_sales.js 25-26
 */

require('dotenv').config();
const pool = require('./db/pool');
const { buildSalesRecordsSql } = require('./utils/salesRecordsSql');

// Tally P&L per month, company "…-2025-26" (excl. GST) — debug_voucher_access_2526.js PART 1.
const TALLY_SALES = {
  '2025-04': 7806115.89, '2025-05': 7628581.79, '2025-06': 6328772.40, '2025-07': 7220744.34,
  '2025-08': 7639718.55, '2025-09': 8145824.52, '2025-10': 7502430.24, '2025-11': 8152804.06,
  '2025-12': 7542176.34, '2026-01': 7477302.40, '2026-02': 7728421.78, '2026-03': 9559016.73,
  '2026-04': 3673215.21, '2026-05': 6754084.16, '2026-06': 7533439.05, '2026-07': 6620483.37,
  '2026-08': 8004362.41,
};
const TALLY_BRANCH = {
  '2025-04': 477057.03, '2025-05': 583539.15, '2025-06': 108191.06, '2025-07': 405582,
  '2025-08': 525587.53, '2025-09': 266508.6, '2025-10': 266877.75, '2025-11': 540650.52,
  '2025-12': 466654.2, '2026-01': 204261.6, '2026-02': 322520.77, '2026-03': 106349.02,
  '2026-04': 678630.75, '2026-05': 214910, '2026-06': 743285.29, '2026-07': 330778.6,
  '2026-08': 316166.46,
};

const arg = process.argv[2];
if (!arg) { console.error('Usage: node verify_net_sales.js <company e.g. 25-26>'); process.exit(1); }
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');

async function main() {
  const { rows: cos } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (cos.length !== 1) { console.log(`"${arg}" matched ${cos.length} companies — need exactly 1.`); return; }
  const co = cos[0];
  console.log(`Company: ${co.name} (id ${co.id})\n`);

  const t0 = Date.now();
  const { rows } = await pool.query(buildSalesRecordsSql({ companyFilter: ' AND v.company_id = $1' }), [co.id]);
  console.log(`SQL OK — ${rows.length} dashboard rows in ${Date.now() - t0}ms`);
  const bad = rows.filter((r) => r.amount === null || Number.isNaN(Number(r.amount))).length;
  console.log(`Rows with a NULL/NaN amount: ${bad}  (expect 0)\n`);

  const byMonth = {};
  for (const r of rows) {
    const m = new Date(r.date).toISOString ? `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, '0')}` : String(r.date).slice(0, 7);
    const o = (byMonth[m] = byMonth[m] || { sale: 0, branch: 0, sample: 0, creditNotes: 0 });
    const amt = Number(r.amount) || 0;
    if (r.invoiceCategory === 'sale') { o.sale += amt; if (/^credit note/i.test(r.vchType)) o.creditNotes += amt; }
    else if (r.invoiceCategory === 'branch_transfer') o.branch += amt;
    else if (r.invoiceCategory === 'sample') o.sample += amt;
  }

  console.log('month     NET SALES (dashboard)  incl. credit notes   TALLY Sales    diff  | BRANCH (dashboard)  TALLY Branch   diff | sample');
  for (const m of Object.keys(byMonth).sort()) {
    const o = byMonth[m], ts = TALLY_SALES[m], tb = TALLY_BRANCH[m];
    console.log(
      `${m}  ${fmt(o.sale).padStart(18)}  ${fmt(o.creditNotes).padStart(16)}   ` +
      `${ts ? fmt(ts).padStart(11) : '          -'}  ${ts ? fmt(o.sale - ts).padStart(8) : '       -'} | ` +
      `${fmt(o.branch).padStart(14)}  ${tb ? fmt(tb).padStart(11) : '          -'}  ${tb ? fmt(o.branch - tb).padStart(7) : '      -'} | ${fmt(o.sample)}`
    );
  }
  console.log('\nHow to read: diff ~0 for the months Tally gives (Apr-2025 … Aug-2026) = the dashboard will match Tally.');
  console.log('Sep/Oct 2026 have no Tally reference (partial months). Paste this ENTIRE output back.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); process.exitCode = 1; })
  .finally(() => pool.end());
