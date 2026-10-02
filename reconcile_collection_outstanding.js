'use strict';
/**
 * reconcile_collection_outstanding.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, DB only (pm2 can keep running). Two things the client wants matched
 * to Tally (besides Sales, already matched):
 *
 *  PART 1  COLLECTION — Tally mobile "Collection" per month / FY. Computes it three
 *          ways from Receipt vouchers and sets each next to the mobile figures, so
 *          the right definition is whichever lands on them:
 *            A  Σ voucher total (party line, abs)
 *            B  Σ credits to the party ledgers (is_party_ledger lines, abs)
 *            C  Σ debits to Bank / Cash ledgers
 *          Mobile (company …-2025-26): Apr-26 70,81,477 | May 80,19,766 | Jun 91,34,590 |
 *          Jul 84,31,175 | Aug 75,44,941 | Sep (to 19th) 32,50,481 | FY 25-26 10,63,13,978.
 *
 *  PART 2  OUTSTANDING — what is stored and how it adds up, so the dashboard's
 *          "Outstanding" can be pointed at Tally's real receivables:
 *            • bills_receivable per company (count, total, overdue, by bill year)
 *            • Trial Balance debtors-type groups Tally reported
 *            • the dashboard's current figure (sum of finalOutstanding over its rows)
 *
 * Usage (in the tallybackend folder):   node reconcile_collection_outstanding.js 25-26
 */

require('dotenv').config();
const pool = require('./db/pool');
const { buildSalesRecordsSql } = require('./utils/salesRecordsSql');

const MOBILE = {
  '2026-04': 7081477, '2026-05': 8019766, '2026-06': 9134590,
  '2026-07': 8431175, '2026-08': 7544941, '2026-09': 3250481,   // Sep = up to 19 Sep only
};
const MOBILE_FY_25_26 = 106313978;

const arg = process.argv[2];
if (!arg) { console.error('Usage: node reconcile_collection_outstanding.js <company e.g. 25-26>'); process.exit(1); }
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');

async function show(label, sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    console.log(`\n── ${label}`);
    if (rows.length) console.table(rows); else console.log('   (no rows)');
    return rows;
  } catch (err) { console.log(`\n❌ ${label} FAILED: ${err.message}`); return []; }
}

async function main() {
  const { rows: cos } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (cos.length !== 1) { console.log(`"${arg}" matched ${cos.length} companies — need exactly 1.`); return; }
  const co = cos[0];
  console.log(`Company: ${co.name} (id ${co.id})`);

  // ── PART 1 ───────────────────────────────────────────────────────────────
  console.log('\n══ PART 1 — COLLECTION (Receipt vouchers) ══');
  const { rows: months } = await pool.query(`
    SELECT to_char(v.date, 'YYYY-MM') AS month,
           COUNT(*)                                                    AS receipts,
           SUM(v.total_amount)                                         AS a_voucher_total,
           SUM(pe.party_abs)                                           AS b_party_credits,
           SUM(be.bank_dr)                                             AS c_bank_cash_debits
    FROM vouchers v
    LEFT JOIN LATERAL (SELECT SUM(ABS(e.amount)) AS party_abs FROM voucher_ledger_entries e
                       WHERE e.voucher_id = v.id AND e.is_party_ledger = true) pe ON true
    LEFT JOIN LATERAL (SELECT SUM(ABS(e.amount)) AS bank_dr
                       FROM voucher_ledger_entries e JOIN ledgers l ON l.company_id = v.company_id AND l.name = e.ledger_name
                       WHERE e.voucher_id = v.id AND (l.parent_group ILIKE '%bank%' OR l.parent_group ILIKE 'cash%')) be ON true
    WHERE v.company_id = $1 AND v.is_cancelled = false AND LOWER(v.vch_type) = 'receipt'
    GROUP BY 1 ORDER BY 1`, [co.id]);

  console.log('month     receipts   A voucher total   B party credits   C bank/cash debits   MOBILE        best vs mobile');
  let fyA = 0, fyB = 0, fyC = 0;
  for (const r of months) {
    const a = Number(r.a_voucher_total || 0), b = Number(r.b_party_credits || 0), c = Number(r.c_bank_cash_debits || 0);
    if (r.month >= '2025-04' && r.month <= '2026-03') { fyA += a; fyB += b; fyC += c; }
    const mob = MOBILE[r.month];
    const best = mob ? [['A', a], ['B', b], ['C', c]].sort((x, y) => Math.abs(x[1] - mob) - Math.abs(y[1] - mob))[0] : null;
    console.log(`${r.month}  ${String(r.receipts).padStart(8)}  ${fmt(a).padStart(15)}  ${fmt(b).padStart(15)}  ${fmt(c).padStart(18)}   ${(mob ? fmt(mob) : '-').padStart(11)}   ${best ? `${best[0]} (diff ${fmt(best[1] - mob)})` : ''}`);
  }
  console.log(`\nFY 25-26 (Apr-25 … Mar-26):  A ${fmt(fyA)}   B ${fmt(fyB)}   C ${fmt(fyC)}   | MOBILE ${fmt(MOBILE_FY_25_26)}`);

  await show('Receipt voucher types present (to be sure none is missed)',
    `SELECT vch_type, COUNT(*) AS vouchers, ROUND(SUM(total_amount)) AS total FROM vouchers
     WHERE company_id = $1 AND is_cancelled = false AND vch_type ILIKE '%receipt%' GROUP BY 1 ORDER BY 2 DESC`, [co.id]);

  // ── PART 2 ───────────────────────────────────────────────────────────────
  console.log('\n══ PART 2 — OUTSTANDING ══');
  await show("bills_receivable per company (Tally's pending customer bills as last synced)",
    `SELECT b.company_id, c.name, COUNT(*) AS bills, ROUND(SUM(b.amount)) AS total_pending,
            ROUND(SUM(b.amount) FILTER (WHERE b.overdue_days > 0)) AS overdue_part,
            MIN(b.bill_date)::text AS oldest_bill, MAX(b.bill_date)::text AS newest_bill,
            MAX(b.synced_at)::text AS last_synced
     FROM bills_receivable b JOIN companies c ON c.id = b.company_id GROUP BY 1, 2 ORDER BY 1`);

  await show(`pending bills of ${co.name} by the Financial Year the bill was raised in`,
    `SELECT CASE WHEN EXTRACT(MONTH FROM bill_date) >= 4
                 THEN to_char(bill_date, 'YY') || '-' || to_char(bill_date + interval '1 year', 'YY')
                 ELSE to_char(bill_date - interval '1 year', 'YY') || '-' || to_char(bill_date, 'YY') END AS bill_fy,
            COUNT(*) AS bills, ROUND(SUM(amount)) AS pending
     FROM bills_receivable WHERE company_id = $1 GROUP BY 1 ORDER BY 1`, [co.id]);

  await show('Trial Balance groups Tally reported that look like receivables / debtors (latest snapshot)',
    `SELECT company_id, group_name, ROUND(dr_amount) AS dr, ROUND(cr_amount) AS cr, ROUND(net_balance) AS net,
            period_from::text AS period_from, period_to::text AS period_to
     FROM trial_balance_groups WHERE company_id = $1 AND (group_name ILIKE '%debtor%' OR group_name ILIKE '%receivable%')
     ORDER BY group_name`, [co.id]);

  await show('outstanding table (collection-based snapshot) per company',
    `SELECT company_id, COUNT(*) AS parties, ROUND(SUM(total_outstanding)) AS total FROM outstanding GROUP BY 1 ORDER BY 1`);

  // what the dashboard shows today
  const { rows } = await pool.query(buildSalesRecordsSql({ companyFilter: ' AND v.company_id = $1' }), [co.id]);
  const byFy = {};
  for (const r of rows) {
    const d = new Date(r.date), m = d.getMonth() + 1;
    const start = m >= 4 ? d.getFullYear() : d.getFullYear() - 1;
    const fy = `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
    byFy[fy] = (byFy[fy] || 0) + (Number(r.finalOutstanding) || 0);
  }
  console.log('\n── Dashboard\'s current "Outstanding" (sum of finalOutstanding over its rows) by FY of the invoice:');
  let tot = 0;
  for (const fy of Object.keys(byFy).sort()) { tot += byFy[fy]; console.log(`   FY ${fy}: ${fmt(byFy[fy])}`); }
  console.log(`   total: ${fmt(tot)}`);

  console.log('\nHow to read: PART 1 — the column (A/B/C) whose diff is ~0 for Apr–Aug 2026 AND whose FY total is near the');
  console.log("mobile 10,63,13,978 is Tally's \"Collection\". PART 2 — compare the bills_receivable / Trial Balance totals with");
  console.log('the "Receivables" figure on the Tally mobile app (send me that screenshot) and with the dashboard total above.');
  console.log('Paste this ENTIRE output back.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); process.exitCode = 1; })
  .finally(() => pool.end());
