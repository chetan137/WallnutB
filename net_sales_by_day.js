'use strict';
/**
 * net_sales_by_day.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, DB only. Net Sales per DAY of one month (the dashboard's own SQL,
 * utils/salesRecordsSql.js), with a running total — to line a month up against
 * a Tally figure that only covers part of it. Example: the Tally mobile app
 * ("Last updated 19 Sep 26") showed Sep-2026 sales Rs30,39,911 up to 19 Sep.
 *
 * Usage (in the tallybackend folder):
 *   node net_sales_by_day.js 25-26 2026-09
 *   node net_sales_by_day.js 25-26 2026-09 3039911 2026-09-19    # also diff the running
 *                                                                # total at that day vs 3039911
 */

require('dotenv').config();
const pool = require('./db/pool');
const { buildSalesRecordsSql } = require('./utils/salesRecordsSql');

const [, , arg, month, tallyTotal, tallyUpTo] = process.argv;
if (!arg || !/^\d{4}-\d{2}$/.test(month || '')) {
  console.error('Usage: node net_sales_by_day.js <company e.g. 25-26> <YYYY-MM> [tallyTotal tallyUpToDate]');
  process.exit(1);
}
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function main() {
  const { rows: cos } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (cos.length !== 1) { console.log(`"${arg}" matched ${cos.length} companies — need exactly 1.`); return; }
  const co = cos[0];
  console.log(`Company: ${co.name} (id ${co.id}) | month ${month}\n`);

  const { rows } = await pool.query(
    buildSalesRecordsSql({ companyFilter: ' AND v.company_id = $1', dateFilter: ' AND v.date >= $2 AND v.date < $3' }),
    [co.id, `${month}-01`, nextMonth(month)]
  );

  const byDay = {};
  for (const r of rows) {
    const day = iso(r.date);
    const o = (byDay[day] = byDay[day] || { sale: 0, credit: 0, branch: 0, sample: 0, vouchers: new Set() });
    const amt = Number(r.amount) || 0;
    if (r.invoiceCategory === 'sale') { o.sale += amt; if (/^credit note/i.test(r.vchType)) o.credit += amt; o.vouchers.add(r.vchNo); }
    else if (r.invoiceCategory === 'branch_transfer') o.branch += amt;
    else if (r.invoiceCategory === 'sample') o.sample += amt;
  }

  console.log('day          net sales   of which credit notes   running total   vouchers   branch(not sales)');
  let running = 0, atTarget = null;
  for (const day of Object.keys(byDay).sort()) {
    const o = byDay[day];
    running += o.sale;
    if (tallyUpTo && day <= tallyUpTo) atTarget = running;
    console.log(`${day}  ${fmt(o.sale).padStart(11)}  ${fmt(o.credit).padStart(20)}  ${fmt(running).padStart(14)}  ${String(o.vouchers.size).padStart(8)}   ${fmt(o.branch).padStart(12)}`);
  }
  console.log(`\nMonth total (net sales): ${fmt(running)}`);
  if (tallyTotal && tallyUpTo) {
    console.log(`Running total up to ${tallyUpTo}: ${fmt(atTarget)}   vs Tally ${fmt(tallyTotal)}   diff ${fmt(atTarget - Number(tallyTotal))}`);
  }
  console.log('\nPaste this ENTIRE output back.');
}

function nextMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
}

main()
  .catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); process.exitCode = 1; })
  .finally(() => pool.end());
