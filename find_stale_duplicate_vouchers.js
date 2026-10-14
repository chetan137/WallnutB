'use strict';
/**
 * find_stale_duplicate_vouchers.js  (DB only, READ-ONLY; pm2 can keep running)
 * Nuvoni WBSI-003/24-25 and Singh Marble WBSI-102/24-25 each exist twice in the DB: same number, date, party
 * and amount, different voucher type (Sales-Bhiwandi / Sales-Maharashtra). The Bhiwandi row is an old copy
 * (saved 5 Sep, before the full re-read of 3 Oct, missing its main sales posting); the Maharashtra row is the
 * current voucher. This finds EVERY such group, says which row looks stale, and how much each one adds to Net Sales.
 *
 * A group = same company + voucher number + date + party + total, more than one voucher type.
 * "Stale" = a row that was NOT refreshed by the latest full re-read, i.e. its synced_at is older than the
 * newest row of the group.
 *
 *   node find_stale_duplicate_vouchers.js
 */
require('dotenv').config();
const pool = require('./db/pool');

const inr = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');

(async () => {
  const { rows } = await pool.query(`
    WITH base AS (
      SELECT v.id, v.company_id, c.name AS company, v.vch_no, v.vch_type, v.date, v.party_name, v.total_amount, v.synced_at,
             COALESCE((SELECT SUM(e.amount) FROM voucher_ledger_entries e
                       JOIN ledgers l ON l.company_id = v.company_id AND l.name = e.ledger_name
                       WHERE e.voucher_id = v.id AND l.parent_group = 'Sales Accounts'), 0) AS sales_posting
      FROM vouchers v JOIN companies c ON c.id = v.company_id
      WHERE v.is_cancelled = false
        AND ((LOWER(v.vch_type) LIKE 'sales%' AND LOWER(v.vch_type) NOT LIKE 'sales order%') OR LOWER(v.vch_type) LIKE 'credit note%' OR LOWER(v.vch_type) LIKE 'debit note%')
    ), grp AS (
      SELECT *, COUNT(*) OVER w AS n, (MIN(vch_type) OVER w <> MAX(vch_type) OVER w) AS multi_type, MAX(synced_at) OVER w AS newest
      FROM base WINDOW w AS (PARTITION BY company_id, vch_no, date, party_name, total_amount)
    )
    SELECT company, vch_no, vch_type, date::text AS date, party_name, total_amount, sales_posting, synced_at::text AS synced_at,
           (synced_at < newest) AS stale, fy_start(date) AS fy
    FROM grp WHERE n > 1 AND multi_type
    ORDER BY date, vch_no, synced_at`);

  const stale = rows.filter((r) => r.stale);
  const groups = new Set(rows.map((r) => `${r.company}|${r.vch_no}|${r.date}|${r.party_name}`));
  console.log(`Groups with the same voucher shown under two or more types: ${groups.size}`);
  console.log(`Rows that look stale (older than the newest row of their group): ${stale.length}`);

  const byFy = {};
  stale.forEach((r) => { const k = `${String(r.fy).slice(2)}-${String(Number(r.fy) + 1).slice(2)}`; byFy[k] = byFy[k] || { fy: k, stale_rows: 0, sales_counted_now: 0 }; byFy[k].stale_rows++; byFy[k].sales_counted_now += Number(r.sales_posting); });
  console.log('\nWhat the stale rows add to Net Sales today, per Financial Year:');
  console.table(Object.values(byFy).map((x) => ({ ...x, sales_counted_now: inr(x.sales_counted_now) })));

  console.log('\nThe first 40 groups (STALE rows are the ones that would be left out):');
  console.table(rows.slice(0, 80).map((r) => ({
    company: r.company.replace(/^Wallnut\s*/i, ''), vch_no: r.vch_no, type: r.vch_type, date: r.date, party: (r.party_name || '').slice(0, 24),
    total: inr(r.total_amount), sales_posting: inr(r.sales_posting), synced_at: r.synced_at.slice(0, 19), verdict: r.stale ? 'STALE' : 'current',
  })));
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
