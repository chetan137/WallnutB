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
 *   node backfill_progress.js 25-26            one-off table
 *   node backfill_progress.js 25-26 --watch    re-checks every 60 s, prints one line each time with
 *                                              how far the backfill got, an ETA, and says READY when a
 *                                              month is complete and can be reconciled (Ctrl+C to stop)
 */

require('dotenv').config();
const pool = require('./db/pool');

const arg = process.argv[2];
const watch = process.argv.includes('--watch');
if (!arg) { console.error('Usage: node backfill_progress.js <company, e.g. 25-26> [--watch]'); process.exit(1); }

async function loadMonths(coId) {
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
    GROUP BY 1 ORDER BY 1`, [coId]);
  return rows.map((r) => {
    const total = Number(r.sales_cn_vouchers), withL = Number(r.with_sales_ledger);
    // Some credit notes legitimately post to no sales ledger, so allow a margin.
    const ratio = total ? withL / total : 0;
    return { ...r, total, withL, status: ratio >= 0.7 ? 'NEW' : ratio > 0.15 ? 'partial' : 'old' };
  });
}

// The backfill walks forward from 2025-04-01 in date order, so what it has
// re-fetched is the CONTIGUOUS run of NEW/partial months from the start. Months
// further on that merely look partly "ledgered" (a few old vouchers already had a
// sales ledger entry) must not count — the run stops at the first "old" month.
function touchedRun(months) {
  const run = [];
  for (const m of months) {
    if (m.status === 'old') { if (run.length) break; continue; }
    run.push(m);
  }
  return run;
}

function frontierOf(months) {
  const run = touchedRun(months);
  return run.length ? run[run.length - 1] : null;
}

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

async function main() {
  const { rows: cos } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (cos.length !== 1) { console.log(`"${arg}" matched ${cos.length} companies — need exactly 1.`); return; }
  const co = cos[0];
  console.log(`Company: ${co.name} (id ${co.id})\n`);

  if (!watch) {
    const months = await loadMonths(co.id);
    console.log('month     sales+CN vouchers   with sales ledger   status     last voucher date');
    for (const r of months) {
      console.log(`${r.month}  ${String(r.total).padStart(15)}   ${String(r.withL).padStart(17)}   ${r.status.padEnd(8)}   ${r.last_voucher_date}`);
    }
    const f = frontierOf(months);
    console.log(`\nBackfill has reached: ${f ? f.last_voucher_date : '(nothing re-fetched yet)'}`);
    console.log('A month is safe to reconcile once it is NEW AND the next month has started (the backfill moved past it).');
    console.log('Then:  node reconcile_sales_ledgers.js ' + arg + ' YYYY-MM      (or use --watch to be told when)');
    return;
  }

  // ── watch mode ──────────────────────────────────────────────────────────
  const target = new Date().toISOString().slice(0, 10);
  let startFrontier = null;
  const announced = new Set();
  console.log('Watching every 60 s (Ctrl+C to stop). The backfill goes forward from 2025-04-01 to today.\n');
  for (;;) {
    const months = await loadMonths(co.id);
    const f = frontierOf(months);
    const stamp = new Date().toLocaleTimeString('en-GB');
    if (!f) {
      console.log(`[${stamp}] nothing re-fetched yet…`);
    } else {
      if (!startFrontier) startFrontier = { date: f.last_voucher_date, t: Date.now() };
      const mins = (Date.now() - startFrontier.t) / 60000;
      const days = daysBetween(startFrontier.date, f.last_voucher_date);
      let eta = 'measuring speed…';
      if (mins >= 2 && days > 0) {
        const perMin = days / mins;
        const left = Math.max(0, daysBetween(f.last_voucher_date, target));
        eta = `~${perMin.toFixed(1)} days/min, about ${Math.round(left / perMin)} min left`;
      }
      console.log(`[${stamp}] reached ${f.last_voucher_date}  (month ${f.month}: ${f.status})  |  ${eta}`);
      // A month is complete once a LATER month has started (NEW or partial).
      const touched = touchedRun(months);
      for (let i = 0; i < touched.length - 1; i++) {
        const m = touched[i].month;
        if (!announced.has(m) && touched[i].status === 'NEW') {
          announced.add(m);
          console.log(`   ✅ READY: ${m} is complete →  node reconcile_sales_ledgers.js ${arg} ${m}`);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

main()
  .catch((err) => { console.error('FATAL:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
