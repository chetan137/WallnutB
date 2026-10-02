'use strict';
/**
 * diagnose_receipts.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, DB only (pm2 can keep running).
 *
 * reconcile_collection_outstanding.js found two things in the Receipt vouchers of
 * the 25-26 company:
 *   • Apr-Aug 2025 hold only 1-5 receipts a month (Tally has ~100), ~Rs4.4Cr short
 *     of the mobile app's FY 25-26 Collection, while Sep-2025 onwards looks normal.
 *   • Apr-Aug 2026 are each ~Rs5,000 below the mobile figure.
 *
 * Suspect for the first: vouchers are keyed by (company, voucher number, type)
 * with no year in it, and Receipt numbers are plain integers that restart each
 * Financial Year — so FY 26-27 receipts (Apr 2026 →) re-using numbers 1..N
 * overwrote the FY 25-26 receipts that had the same numbers.
 *
 * PART 1  Receipt numbers per month: lowest / highest number, how many are numeric.
 *         If numbering restarted, Apr-2026 will start again near 1 while Sep-2025
 *         runs far higher — and the numbers 1..N of Apr-Aug 2025 will be "missing".
 * PART 2  Voucher numbers that appear in MORE THAN ONE financial year's date range
 *         is impossible in the DB today (that is the bug) — so instead show how many
 *         numbers below the Apr-2026 starting number are missing from the Receipt series.
 * PART 3  Vouchers of ~Rs5,000 in Apr-Sep 2026 (any type) — the monthly shortfall.
 *
 * Usage (in the tallybackend folder):   node diagnose_receipts.js 25-26
 */

require('dotenv').config();
const pool = require('./db/pool');

const arg = process.argv[2];
if (!arg) { console.error('Usage: node diagnose_receipts.js <company e.g. 25-26>'); process.exit(1); }

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

  await show('PART 1 — Receipt voucher numbers per month (numeric part)',
    `SELECT to_char(date, 'YYYY-MM') AS month, COUNT(*) AS receipts,
            MIN(NULLIF(regexp_replace(vch_no, '\\D', '', 'g'), '')::bigint) AS lowest_no,
            MAX(NULLIF(regexp_replace(vch_no, '\\D', '', 'g'), '')::bigint) AS highest_no,
            MIN(vch_no) AS first_text, MAX(vch_no) AS last_text
     FROM vouchers WHERE company_id = $1 AND is_cancelled = false AND LOWER(vch_type) = 'receipt'
     GROUP BY 1 ORDER BY 1`, [co.id]);

  await show('PART 2 — gaps in the Receipt number series (numbers between 1 and the highest that are NOT in the DB)',
    `WITH nums AS (
       SELECT DISTINCT NULLIF(regexp_replace(vch_no, '\\D', '', 'g'), '')::bigint AS n
       FROM vouchers WHERE company_id = $1 AND LOWER(vch_type) = 'receipt' AND vch_no ~ '^[0-9]+$'
     ), mx AS (SELECT MAX(n) AS m, COUNT(*) AS present FROM nums)
     SELECT mx.m AS highest_number, mx.present AS numbers_present, mx.m - mx.present AS numbers_missing_below_highest
     FROM mx`, [co.id]);

  await show('PART 3 — vouchers of about Rs5,000 (any type), Apr-Sep 2026 — the monthly shortfall',
    `SELECT date::text AS date, vch_type, vch_no, party_name, total_amount, is_cancelled
     FROM vouchers WHERE company_id = $1 AND date >= '2026-04-01' AND date < '2026-10-01'
       AND total_amount BETWEEN 4999 AND 5001 ORDER BY date LIMIT 40`, [co.id]);

  await show('PART 4 — all voucher types per month, Apr-Sep 2025 (to see what is there instead)',
    `SELECT to_char(date, 'YYYY-MM') AS month, vch_type, COUNT(*) AS vouchers, ROUND(SUM(total_amount)) AS total
     FROM vouchers WHERE company_id = $1 AND date >= '2025-04-01' AND date < '2025-10-01'
       AND vch_type !~* '^(sales|credit note|purchase|stock journal|manufacturing)' GROUP BY 1, 2 ORDER BY 1, 3 DESC`, [co.id]);

  console.log('\nHow to read: if PART 1 shows Apr-2026 numbers starting near 1 (and Apr-Aug 2025 numbers absent / only a few)');
  console.log('and PART 2 shows many numbers missing, the numbers restart every FY and later vouchers overwrote earlier ones.');
  console.log('Paste this ENTIRE output back.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); process.exitCode = 1; })
  .finally(() => pool.end());
