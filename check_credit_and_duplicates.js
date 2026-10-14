'use strict';
/**
 * check_credit_and_duplicates.js  (DB only, READ-ONLY; pm2 can keep running)
 * Helps with three Tally checks:
 *   - Nuvoni Corp LLP, WBSI-003/24-25 (18-Apr-2024)       : 1 voucher or 2? which type is right?
 *   - Singh Marble & Tiles, WBSI-102/24-25 (06-Dec-2024)  : same question
 *   - INDORA ASSOCIATES WBSIMK-364/26-27 and Atul Ltd. WBSIGJ-107/26-27 : credit period
 * For every voucher it prints what the DB holds, so the vouchers of a pair can be compared with each
 * other and with Tally's Day Book / Bill Allocations.
 *
 *   node check_credit_and_duplicates.js
 *   node check_credit_and_duplicates.js "WBSI-003/24-25" "WBSIMK-364/26-27"     (own voucher numbers)
 */
require('dotenv').config();
const pool = require('./db/pool');

const DEFAULT = ['WBSI-003/24-25', 'WBSI-102/24-25', 'WBSIMK-364/26-27', 'WBSIGJ-107/26-27'];
const numbers = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const inr = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  for (const no of numbers) {
    const { rows: vs } = await pool.query(
      `SELECT v.id, c.name AS company, v.vch_type, v.date::text AS date, v.party_name, v.total_amount, v.is_cancelled,
              v.credit_period_label, v.credit_period_days, v.narration, v.synced_at::text AS synced_at,
              (SELECT COUNT(*) FROM voucher_inventory_entries x WHERE x.voucher_id = v.id) AS item_lines
       FROM vouchers v JOIN companies c ON c.id = v.company_id
       WHERE v.vch_no = $1 ORDER BY v.date, v.vch_type`, [no]);
    console.log('\n' + '═'.repeat(90));
    console.log(`${no}: ${vs.length} voucher(s) in the DB`);
    if (!vs.length) continue;

    console.table(vs.map((v) => ({
      company: v.company.replace(/^Wallnut\s*/i, ''), type: v.vch_type, date: v.date, party: (v.party_name || '').slice(0, 30),
      total: inr(v.total_amount), cancelled: v.is_cancelled, items: v.item_lines,
      credit_period: v.credit_period_label || (v.credit_period_days != null ? `${v.credit_period_days} days` : '-'),
      synced_at: v.synced_at.slice(0, 19),
    })));

    for (const v of vs) {
      const { rows: led } = await pool.query(
        `SELECT e.ledger_name, l.parent_group, e.amount FROM voucher_ledger_entries e
         LEFT JOIN ledgers l ON l.company_id = $2 AND l.name = e.ledger_name
         WHERE e.voucher_id = $1 ORDER BY ABS(e.amount) DESC`, [v.id, (await pool.query('SELECT company_id FROM vouchers WHERE id=$1', [v.id])).rows[0].company_id]);
      console.log(`   postings of the ${v.vch_type} voucher (${v.company.replace(/^Wallnut\s*/i, '')}):`);
      console.table(led.map((r) => ({ ledger: r.ledger_name, group: r.parent_group || '-', amount: inr(r.amount) })));
      if (v.narration) console.log(`   narration: ${String(v.narration).slice(0, 120)}`);
    }

    const { rows: bills } = await pool.query(
      `SELECT c.name AS company, b.bill_ref, b.bill_date::text AS bill_date, b.due_date::text AS due_date, b.amount, b.overdue_days
       FROM bills_receivable b JOIN companies c ON c.id = b.company_id WHERE b.bill_ref = $1`, [no]);
    console.log('   bill rows in the DB (what Tally reported as pending at the last sync):');
    console.table(bills.map((b) => ({ company: b.company.replace(/^Wallnut\s*/i, ''), bill: b.bill_ref, bill_date: b.bill_date, due_date: b.due_date,
      days_between_bill_and_due: b.bill_date && b.due_date ? Math.round((new Date(b.due_date) - new Date(b.bill_date)) / 86400000) : '-', amount: inr(b.amount) })));
  }
  console.log('\nHow to read: for a pair with the same number, date, party and amount but different types, open both in');
  console.log("Tally (Day Book -> the date). The real one carries the bill reference under Bill Allocations (New Ref).");
  console.log('"days_between_bill_and_due" is the credit period Tally used for that bill.');
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
