'use strict';
/**
 * debug_voucher_flags.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Dashboard Net Sales for Sep-2026 is ₹40 lakh ABOVE Tally's P&L (every other month,
 * Apr-2025 … Aug-2026, matches). Suspect: the Voucher Register also returns CANCELLED /
 * OPTIONAL / deleted vouchers (flags ISCANCELLED, ISOPTIONAL, ISDELETED …) which Tally's
 * P&L ignores, and the sync never reads those flags (vouchers.is_cancelled stays false).
 *
 * For each day given it asks Tally for that day's Voucher Register (ONE small request per
 * day), reads the voucher-level flags of every voucher, and looks the same vouchers up in
 * the DB to show how much sales posting the flagged ones carry.
 *
 * ⚠️ Tally is queried: stop tallybackend first (pm2 stop tally-sync), the company must be the
 *    one open in Tally. Read-only.
 *
 * Usage:
 *   node debug_voucher_flags.js 25-26 2026-09-30 [2026-09-26 …]
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const config      = require('./config');
const pool        = require('./db/pool');

const [, , companyArg, ...days] = process.argv;
if (!companyArg || !days.length) {
  console.error('Usage: node debug_voucher_flags.js <company e.g. 25-26> <YYYY-MM-DD> [more days]');
  process.exit(1);
}
const co = config.companies.find((c) => c.name.toLowerCase().includes(companyArg.toLowerCase()) ||
                                        c.tallyName.toLowerCase().includes(companyArg.toLowerCase()));
if (!co) { console.error(`No configured company matches "${companyArg}".`); process.exit(1); }

const FLAGS = ['ISCANCELLED', 'ISOPTIONAL', 'ISDELETED', 'ISPOSTDATED', 'ISVOID', 'ISCANCELED'];
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-IN');
const first = (block, tag) => { const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : ''; };

async function main() {
  console.log('⚠️  tallybackend should be STOPPED (pm2 stop tally-sync) and the company open in Tally.');
  console.log(`Company: ${co.name} (Tally: "${co.tallyName}")\n`);
  const { rows: cr } = await pool.query('SELECT id FROM companies WHERE name ILIKE $1', [`%${companyArg}%`]);
  const companyId = cr[0] && cr[0].id;

  for (const day of days) {
    const raw = await tallyClient.request(templates.buildVoucherRegisterRequest(co.tallyName, day, day));
    const blocks = [...raw.matchAll(/<VOUCHER[ >][\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]).filter((b) => b.length > 30);

    // DB side: sales-group posting per voucher number/type for the day
    const { rows: db } = await pool.query(
      `SELECT v.vch_no, v.vch_type,
              ROUND(SUM(e.amount) FILTER (WHERE l.parent_group = 'Sales Accounts'))        AS sales_posting,
              ROUND(SUM(e.amount) FILTER (WHERE l.parent_group ILIKE 'Branch Trf%Sales%')) AS branch_posting
       FROM vouchers v
       LEFT JOIN voucher_ledger_entries e ON e.voucher_id = v.id
       LEFT JOIN ledgers l ON l.company_id = v.company_id AND l.name = e.ledger_name
       WHERE v.company_id = $1 AND v.date = $2 GROUP BY v.id`, [companyId, day]);
    const dbBy = new Map(db.map((r) => [`${r.vch_no}|${r.vch_type}`, r]));

    console.log('═'.repeat(78));
    console.log(`${day}: ${blocks.length} vouchers in Tally's Register, ${db.length} in the DB`);
    const counts = {};
    const rows = blocks.map((b) => {
      const o = {
        no: first(b, 'VOUCHERNUMBER'), type: first(b, 'VOUCHERTYPENAME'), party: first(b, 'PARTYLEDGERNAME'),
        action: (b.match(/<VOUCHER[^>]*\sACTION="([^"]*)"/) || [])[1] || '',
      };
      o.flags = FLAGS.filter((f) => /^yes$/i.test(first(b, f)));
      o.flags.forEach((f) => { counts[f] = (counts[f] || 0) + 1; });
      const d = dbBy.get(`${o.no}|${o.type}`);
      o.sales = d ? Number(d.sales_posting || 0) : 0;
      o.branch = d ? Number(d.branch_posting || 0) : 0;
      o.inDb = Boolean(d);
      return o;
    });
    console.log('flag = Yes counts:', Object.keys(counts).length ? JSON.stringify(counts) : '(none)');

    const flagged = rows.filter((r) => r.flags.length);
    const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);
    console.log(`Sales-group posting in the DB:  all ${fmt(sum(rows, 'sales'))}  |  of FLAGGED vouchers ${fmt(sum(flagged, 'sales'))}  |  of the rest ${fmt(sum(rows.filter((r) => !r.flags.length), 'sales'))}`);
    if (flagged.length) {
      console.log('\nFlagged vouchers:');
      console.table(flagged.slice(0, 30).map((r) => ({ no: r.no, type: r.type, party: r.party.slice(0, 28), flags: r.flags.join(','), sales_in_db: Math.round(r.sales), in_db: r.inDb })));
    }
    const missing = rows.filter((r) => !r.inDb).length;
    if (missing) console.log(`(${missing} voucher(s) of this day in Tally's response are not in the DB)`);
    console.log('\nBiggest sales-posting vouchers of the day (DB), with their flags:');
    console.table([...rows].sort((a, b) => Math.abs(b.sales) - Math.abs(a.sales)).slice(0, 8)
      .map((r) => ({ no: r.no, type: r.type, party: r.party.slice(0, 28), sales_in_db: Math.round(r.sales), flags: r.flags.join(',') || '-', action: r.action })));
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log('\nHow to read: if the flagged vouchers carry about the missing 40 lakh for Sep (spread over the days of the');
  console.log('month), the sync must skip cancelled/optional vouchers. Paste this ENTIRE output back.');
}

main()
  .catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); process.exitCode = 1; })
  .finally(() => pool.end());
