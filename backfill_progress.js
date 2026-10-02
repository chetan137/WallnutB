'use strict';
/**
 * backfill_progress.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, DB only. Shows how far the voucher backfill has got, month by
 * month, so a month can be checked against Tally as soon as it is complete
 * (without waiting for all 275 chunks).
 *
 * A month is "NEW" when its Sales/Credit Note vouchers carry the sales ledger
 * (e.g. "Net Sales GST 18%") as a ledger entry — what the Voucher Register +
 * the parser fix writes. "old" = still the data synced earlier through the
 * ad-hoc collection (no sales ledger entries); "partial" = a mix, i.e. the
 * backfill is in the middle of that month.
 *
 * Usage (in the tallybackend folder):
 *   node backfill_progress.js 25-26
 */

require('dotenv').config();
const pool = require('./db/pool');

const arg = process.argv[2];
if (!arg) { console.error('Usage: node backfill_progress.js <company, e.g. 25-26>'); process.exit(1); }

async function main() {
  const { rows: cos } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (cos.length !== 1) { console.log(`"${arg}" matched ${cos.length} companies — need exactly 1.`); return; }
  const co = cos[0];
  console.log(`Company: ${co.name} (id ${co.id})\n`);

  const { rows } = await pool.query(`
    SELECT to_char(v.date, 'YYYY-MM') AS month,
           COUNT(*)                                         AS sales_cn_vouchers,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM voucher_ledger_entries e
             JOIN ledgers l ON l.company_id = v.company_id AND l.name = e.ledger_name
             WHERE e.voucher_id = v.id
               AND (l.parent_group = 'Sales Accounts' OR l.parent_group ILIKE 'Branch Trf%Sales%')
               AND e.ledger_name !~* '(transit insurance|freight)'
           ))                                               AS with_sales_ledger,
           MAX(v.date)::text                                AS last_voucher_date
    FROM vouchers v
    WHERE v.company_id = $1 AND v.is_cancelled = false
      AND (v.vch_type ILIKE 'sales%' OR v.vch_type ILIKE 'credit note%')
    GROUP BY 1 ORDER BY 1`, [co.id]);

  console.log('month     sales+CN vouchers   with sales ledger   status     last voucher date');
  let lastNew = null;
  for (const r of rows) {
    const total = Number(r.sales_cn_vouchers), withL = Number(r.with_sales_ledger);
    // Some credit notes legitimately post to no sales ledger, so allow a margin.
    const ratio = total ? withL / total : 0;
    const status = ratio >= 0.7 ? 'NEW' : ratio > 0.05 ? 'partial' : 'old';
    if (status === 'NEW') lastNew = r.month;
    console.log(`${r.month}  ${String(total).padStart(15)}   ${String(withL).padStart(17)}   ${status.padEnd(8)}   ${r.last_voucher_date}`);
  }
  console.log(`\nLatest month already re-fetched with the new parser: ${lastNew || '(none yet)'}`);
  console.log('A month is safe to reconcile against Tally once it is NEW AND the next month has started');
  console.log('(i.e. the backfill has moved past it). Then:  node reconcile_sales_ledgers.js ' + arg + ' YYYY-MM');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
