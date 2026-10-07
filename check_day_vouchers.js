'use strict';
/**
 * check_day_vouchers.js  (DB only, pm2 can keep running)
 * "Tally shows 3 vouchers today, the dashboard shows 2" - find out why.
 * For one day it lists every voucher in the DB (all companies, all types) with
 *   - how the dashboard classifies it (sale / branch_transfer / sample / other = not counted),
 *   - its postings to the Sales Accounts / Branch Trf-Sales ledgers,
 *   - when it was synced, and when the sync last ran,
 * then compares with the vouchers you give from Tally.
 *
 * Usage (tallybackend folder):
 *   node check_day_vouchers.js 2026-10-07
 *   node check_day_vouchers.js 2026-10-07 WBSIMK-419/26-27 WBSIMK-420/26-27 WBSIMK-421/26-27
 */
require('dotenv').config();
const pool = require('./db/pool');
const { buildSalesRecordsSql } = require('./utils/salesRecordsSql');

const [, , day, ...tallyNos] = process.argv;
if (!day) { console.error('Usage: node check_day_vouchers.js <YYYY-MM-DD> [voucher numbers shown in Tally]'); process.exit(1); }
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');

(async () => {
  const { rows: v } = await pool.query(
    `SELECT v.id, c.name AS company, v.vch_no, v.vch_type, v.party_name, v.total_amount, v.is_cancelled,
            v.synced_at::text AS synced_at,
            ROUND(SUM(e.amount) FILTER (WHERE l.parent_group = 'Sales Accounts'))        AS sales_posting,
            ROUND(SUM(e.amount) FILTER (WHERE l.parent_group ILIKE 'Branch Trf%Sales%')) AS branch_posting,
            (SELECT COUNT(*) FROM voucher_inventory_entries x WHERE x.voucher_id = v.id)  AS item_lines
     FROM vouchers v
     JOIN companies c ON c.id = v.company_id
     LEFT JOIN voucher_ledger_entries e ON e.voucher_id = v.id
     LEFT JOIN ledgers l ON l.company_id = v.company_id AND l.name = e.ledger_name
     WHERE v.date = $1
     GROUP BY v.id, c.name
     ORDER BY v.vch_type, v.vch_no`, [day]);

  const { rows: dash } = await pool.query(buildSalesRecordsSql({ dateFilter: ' AND v.date = $1' }), [day]);
  const cat = new Map();
  dash.forEach((r) => { const k = `${r.vchNo}|${r.vchType}`; if (!cat.has(k)) cat.set(k, { category: r.invoiceCategory, amount: 0 }); cat.get(k).amount += Number(r.amount) || 0; });

  console.log(`\n${day}: ${v.length} vouchers in the DB`);
  console.table(v.map((r) => {
    const c = cat.get(`${r.vch_no}|${r.vch_type}`);
    return {
      company: r.company.replace(/^Wallnut\s*/i, ''), vch_no: r.vch_no, type: r.vch_type, party: (r.party_name || '').slice(0, 28),
      total: fmt(r.total_amount), sales_posting: fmt(r.sales_posting), branch_posting: fmt(r.branch_posting), items: r.item_lines,
      cancelled: r.is_cancelled, dashboard_as: c ? c.category : '(not read: type not Sales/Credit/Debit)',
      dashboard_net: c ? fmt(c.amount) : '-', synced_at: r.synced_at.slice(0, 19),
    };
  }));

  if (tallyNos.length) {
    const have = new Set(v.map((r) => r.vch_no));
    console.log('\nVouchers you see in Tally:');
    console.table(tallyNos.map((n) => ({ vch_no: n, in_db: have.has(n) ? 'yes' : 'NO - not synced yet' })));
  }

  const { rows: last } = await pool.query(
    `SELECT c.name AS company, s.data_type, s.status, s.last_synced_date::text AS synced_up_to, s.completed_at::text AS completed_at, s.error_message
     FROM sync_logs s JOIN companies c ON c.id = s.company_id
     WHERE s.data_type IN ('vouchers', 'vouchers_backfill') ORDER BY s.completed_at DESC NULLS LAST LIMIT 6`);
  console.log('\nLast voucher syncs (now is ' + new Date().toISOString() + '):');
  console.table(last);
  console.log('How to read: a Tally voucher with in_db "NO" is just not synced yet (the sync runs every 10 minutes).');
  console.log('If it IS in the DB but dashboard_as is "other", it has no Sales Accounts posting; "sample" / "branch_transfer" are shown in their own table.');
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
