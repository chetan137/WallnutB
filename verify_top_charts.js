'use strict';
/**
 * verify_top_charts.js  (DB only, pm2 can keep running)
 * Checks the "Top Products" and "Top Sales Officers" charts of the CEO dashboard against the
 * database, using the same rows as the dashboard (utils/salesRecordsSql.js, category "sale").
 *
 *   - how much of Net Sales has NO officer / NO item name (those rows are left out of the charts,
 *     so the bars never add up to the full Net Sales),
 *   - top 10 officers (name cleaned like the dashboard: "Mr. X" / "Mr.X" / "X" = one person),
 *   - officer names that look like the same person under different spellings,
 *   - top 10 products.
 *
 * Usage (tallybackend folder):   node verify_top_charts.js 25-26      (Financial Year, or "all")
 */
require('dotenv').config();
const pool = require('./db/pool');
const { buildSalesRecordsSql } = require('./utils/salesRecordsSql');

const fy = (process.argv[2] || 'all').toLowerCase();
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');
const clean = (n) => String(n || '').trim().replace(/^(mr|mrs|ms|miss|shri|smt|dr)(\.\s*|\s+)/i, '').replace(/\s+/g, ' ').trim();

(async () => {
  let dateFilter = '';
  const params = [];
  if (fy !== 'all') {
    const start = 2000 + Number(fy.slice(0, 2));
    params.push(`${start}-04-01`, `${start + 1}-03-31`);
    dateFilter = ' AND v.date >= $1 AND v.date <= $2';
  }
  const { rows } = await pool.query(buildSalesRecordsSql({ dateFilter }), params);
  const sales = rows.filter((r) => r.invoiceCategory === 'sale');
  const total = sales.reduce((s, r) => s + Number(r.amount || 0), 0);

  const noOfficer = sales.filter((r) => !String(r.salesMan || '').trim());
  const noItem = sales.filter((r) => !r.itemName);
  console.log(`\nPeriod: ${fy === 'all' ? 'all years' : `FY ${fy}`} | sales rows: ${sales.length} | Net Sales ${fmt(total)}`);
  console.log(`Rows with NO officer: ${noOfficer.length}, worth ${fmt(noOfficer.reduce((s, r) => s + Number(r.amount || 0), 0))}  (not in the officer chart)`);
  console.log(`Rows with NO item name: ${noItem.length}, worth ${fmt(noItem.reduce((s, r) => s + Number(r.amount || 0), 0))}  (not in the product chart)`);

  const off = new Map();
  for (const r of sales) {
    if (!String(r.salesMan || '').trim()) continue;
    const name = clean(r.salesMan);
    if (!name) continue;
    const k = name.toLowerCase();
    const o = off.get(k) || { officer: name, amount: 0, dealers: new Set(), spellings: new Set() };
    o.amount += Number(r.amount || 0); o.dealers.add(r.partyName); o.spellings.add(r.salesMan.trim());
    off.set(k, o);
  }
  const offList = [...off.values()].sort((a, b) => b.amount - a.amount);
  console.log('\nTop 10 officers (as the chart shows them):');
  console.table(offList.slice(0, 10).map((o) => ({ officer: o.officer, net_sales: fmt(o.amount), dealers: o.dealers.size, spellings_in_tally: [...o.spellings].join(' | ') })));
  console.log(`Officers in the chart in total: ${offList.length}, their sales ${fmt(offList.reduce((s, o) => s + o.amount, 0))} of ${fmt(total)}`);

  // Same person, different spelling: share first + last word
  const keyOf = (n) => { const w = n.toLowerCase().split(' '); return `${w[0]} ${w[w.length - 1]}`; };
  const byKey = new Map();
  offList.forEach((o) => { const k = keyOf(o.officer); byKey.set(k, [...(byKey.get(k) || []), o]); });
  const dup = [...byKey.values()].filter((g) => g.length > 1);
  if (dup.length) {
    console.log('\nOfficer names that may be the SAME person (first and last name match):');
    dup.forEach((g) => console.log('  - ' + g.map((o) => `${o.officer} (${fmt(o.amount)})`).join('   vs   ')));
  }

  const prod = new Map();
  for (const r of sales) { if (r.itemName) prod.set(r.itemName, (prod.get(r.itemName) || 0) + Number(r.amount || 0)); }
  const prodList = [...prod.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\nTop 10 products:');
  console.table(prodList.slice(0, 10).map(([product, amount]) => ({ product, net_sales: fmt(amount) })));
  console.log(`Products in the chart in total: ${prodList.length}, their sales ${fmt(prodList.reduce((s, [, a]) => s + a, 0))} of ${fmt(total)}`);
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
