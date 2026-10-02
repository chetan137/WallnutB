'use strict';
/**
 * diagnose_duplicates.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, DB only (pm2 can keep running). Looks for anything that could make
 * the dashboard's sales come out inflated / doubled:
 *   1. duplicate vouchers
 *   2. duplicate item lines / ledger lines inside vouchers
 *   3. bills_receivable holding more than one row per bill — the dashboard query
 *      joins it on (company, party, bill_ref = vch_no), so duplicate bills would
 *      repeat every item row of that voucher and multiply its amount
 *   4. the actual multiplication: dashboard row count WITH vs WITHOUT that join
 *
 * Usage (in the tallybackend folder):   node diagnose_duplicates.js
 */

require('dotenv').config();
const pool = require('./db/pool');

async function show(label, sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    console.log(`\n── ${label}`);
    if (rows.length) console.table(rows); else console.log('   (no rows)');
  } catch (err) {
    console.log(`\n❌ ${label} FAILED: ${err.message}`);
  }
}

async function main() {
  const SALES = `(LOWER(v.vch_type) LIKE 'sales%' OR LOWER(v.vch_type) LIKE 'credit note%') AND v.is_cancelled = false`;

  await show('1. vouchers: total vs distinct (voucher no, type, date) per company',
    `SELECT company_id, COUNT(*) AS vouchers, COUNT(DISTINCT (vch_no, vch_type, date)) AS distinct_vouchers
     FROM vouchers GROUP BY 1 ORDER BY 1`);

  await show('2a. item lines: total vs distinct (voucher, item, qty, rate, amount) per company',
    `SELECT v.company_id, COUNT(*) AS item_rows,
            COUNT(DISTINCT (e.voucher_id, e.item_name, e.quantity, e.rate, e.amount)) AS distinct_rows
     FROM voucher_inventory_entries e JOIN vouchers v ON v.id = e.voucher_id GROUP BY 1 ORDER BY 1`);

  await show('2b. ledger lines: total vs distinct (voucher, ledger, amount) per company',
    `SELECT v.company_id, COUNT(*) AS ledger_rows,
            COUNT(DISTINCT (e.voucher_id, e.ledger_name, e.amount)) AS distinct_rows
     FROM voucher_ledger_entries e JOIN vouchers v ON v.id = e.voucher_id GROUP BY 1 ORDER BY 1`);

  await show('3a. bills_receivable: rows vs distinct bills (party + bill_ref) per company',
    `SELECT company_id, COUNT(*) AS rows, COUNT(DISTINCT (party_name, bill_ref)) AS distinct_bills
     FROM bills_receivable GROUP BY 1 ORDER BY 1`);

  await show('3b. bills with MORE than one row (top 10)',
    `SELECT company_id, party_name, bill_ref, COUNT(*) AS copies
     FROM bills_receivable GROUP BY 1, 2, 3 HAVING COUNT(*) > 1 ORDER BY copies DESC LIMIT 10`);

  await show('4. dashboard rows WITH vs WITHOUT the bills_receivable join (Sales + Credit Note vouchers)',
    `SELECT w.company_id, w.with_join, wo.without_join, w.with_join - wo.without_join AS extra_rows_from_join
     FROM (SELECT v.company_id, COUNT(*) AS with_join
           FROM vouchers v LEFT JOIN voucher_inventory_entries vie ON vie.voucher_id = v.id
           LEFT JOIN bills_receivable br ON br.company_id = v.company_id AND br.party_name = v.party_name AND br.bill_ref = v.vch_no
           WHERE ${SALES} GROUP BY 1) w
     JOIN (SELECT v.company_id, COUNT(*) AS without_join
           FROM vouchers v LEFT JOIN voucher_inventory_entries vie ON vie.voucher_id = v.id
           WHERE ${SALES} GROUP BY 1) wo USING (company_id)
     ORDER BY 1`);

  console.log('\nHow to read: every "distinct" should equal its "total" (a few item/ledger repeats can be real).');
  console.log('If 3b lists bills or 4 shows extra_rows_from_join > 0, the join is inflating sales. Paste this ENTIRE output back.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
