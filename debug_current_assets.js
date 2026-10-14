'use strict';
/**
 * debug_current_assets.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Website "Current Assets" (Financials page) = 4,03,15,795, Tally Balance Sheet = 4,22,48,728.47
 * (difference 19,32,933). Where does the gap come from?
 *
 *   Step 1 (DB only, pm2 can keep running)  node debug_current_assets.js 25-26
 *     - the snapshots of trial_balance_groups in the DB: which dates, when they were synced,
 *       and the "Current Assets" group + every group under it, next to the Tally figures,
 *     - how the website turns that into its number.
 *
 *   Step 2 (asks Tally, stop tallybackend first: pm2 stop tally-sync, company must be open)
 *                                           node debug_current_assets.js 25-26 --tally
 *     - asks Tally for the Trial Balance right now (the sync gets "157 bytes / no groups" lately):
 *       prints the raw reply if it is short, else the Current Assets groups it returns.
 *     READ-ONLY.
 */
require('dotenv').config();
const pool = require('./db/pool');

const arg = process.argv[2];
const withTally = process.argv.includes('--tally');
if (!arg) { console.error('Usage: node debug_current_assets.js <company e.g. 25-26> [--tally]'); process.exit(1); }

const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// What the Tally Balance Sheet screenshot shows (Current Assets, total 4,22,48,728.47)
const TALLY = [
  ['Closing Stock', 15813097.84], ['Deposits (Asset)', 60000], ['Sundry Debtors', 22883583.97], ['Cash-in-hand', 14165],
  ['Bank Accounts', 740488.32], ['Fixed Deposit- One Year', 2685548.59], ['Prepaid Exp', -0.29], ['TDS Receivable AY 2026-27', 51845.04],
];

async function dbPart(co) {
  console.log(`\nCompany: ${co.name} (id ${co.id})`);
  const { rows: snaps } = await pool.query(
    `SELECT period_from::text AS period_from, period_to::text AS period_to, COUNT(*) AS groups, MAX(synced_at)::text AS synced_at
     FROM trial_balance_groups WHERE company_id = $1 GROUP BY 1, 2 ORDER BY 2 DESC LIMIT 8`, [co.id]);
  console.log('\n── Snapshots of the Trial Balance in the DB (the website uses the newest period_to)');
  console.table(snaps);
  if (!snaps.length) return;

  const latest = snaps[0];
  const { rows: groups } = await pool.query(
    `SELECT group_name, dr_amount, cr_amount, net_balance, synced_at::text AS synced_at
     FROM trial_balance_groups WHERE company_id = $1 AND period_to = $2 ORDER BY ABS(net_balance) DESC`, [co.id, latest.period_to]);
  console.log(`\n── All groups of the newest snapshot (period ${latest.period_from} → ${latest.period_to})`);
  console.table(groups.map((g) => ({ group: g.group_name, dr: fmt(g.dr_amount), cr: fmt(g.cr_amount), net: fmt(g.net_balance), synced_at: g.synced_at.slice(0, 19) })));

  const ca = groups.find((g) => g.group_name === 'Current Assets');
  console.log(`\nWebsite figure = |net_balance of "Current Assets"| = ${ca ? fmt(Math.abs(ca.net_balance)) : '(group missing)'}`);
  console.log(`Tally Balance Sheet (screenshot)                  = ${fmt(TALLY.reduce((s, [, v]) => s + v, 0))}`);
  if (ca) console.log(`Difference                                        = ${fmt(TALLY.reduce((s, [, v]) => s + v, 0) - Math.abs(ca.net_balance))}`);

  console.log('\n── Tally components (screenshot) vs the DB group of the same name');
  console.table(TALLY.map(([name, v]) => {
    const g = groups.find((x) => x.group_name.toLowerCase() === name.toLowerCase());
    return { tally_item: name, tally: fmt(v), db_group: g ? g.group_name : '-', db_net: g ? fmt(Math.abs(g.net_balance)) : '-' };
  }));
  // Stock: the Trial Balance carries the Stock-in-Hand LEDGER (usually the opening stock); the Tally
  // Balance Sheet uses the calculated CLOSING stock (= the sum of the stock items' closing values).
  const { rows: stockLedgers } = await pool.query(
    `SELECT name, parent_group, opening_balance, closing_balance FROM ledgers
     WHERE company_id = $1 AND (parent_group ILIKE 'stock%' OR name ILIKE '%stock-in-hand%' OR name ILIKE 'closing stock%' OR name ILIKE 'opening stock%')
     ORDER BY ABS(opening_balance) DESC LIMIT 10`, [co.id]);
  console.log('\n── Stock ledgers (what the Trial Balance can carry)');
  console.table(stockLedgers.map((r) => ({ ledger: r.name, group: r.parent_group, opening_balance: fmt(r.opening_balance), closing_balance: fmt(r.closing_balance) })));
  const { rows: [st] } = await pool.query(
    'SELECT COUNT(*) AS items, COALESCE(SUM(closing_value), 0) AS closing_value, MAX(synced_at)::text AS synced_at FROM stock_items WHERE company_id = $1', [co.id]);
  console.log(`\nStock items in the DB: ${st.items} | sum of closing_value = ${fmt(st.closing_value)} (synced ${String(st.synced_at).slice(0, 19)})`);
  console.log(`Tally Balance Sheet "Closing Stock"                 = ${fmt(15813097.84)}`);
  if (ca) {
    const gap = TALLY.reduce((s, [, v]) => s + v, 0) - Math.abs(ca.net_balance);
    console.log(`Gap to explain (Tally - website)                    = ${fmt(gap)}`);
    console.log(`Closing stock (DB) minus website gap check          : if the Trial Balance holds opening stock S, then`);
    console.log(`   website + (closing stock - S) should equal Tally. Closing stock - gap = ${fmt(Number(st.closing_value) - gap)}  <- the stock figure inside the Trial Balance if that holds`);
  }

  console.log('\nHow to read: if the newest period_to is OLDER than the date of your Tally figure, the website is');
  console.log('showing an old snapshot (the Trial Balance sync is not updating). If the dates match, the gap is');
  console.log('in how Tally and the Trial Balance count Closing Stock — compare the Stock-in-Hand line above.');
}

async function tallyPart(co) {
  const tallyClient = require('./tally/client');
  const templates = require('./tally/xmlTemplates');
  const from = (co.fiscal_year_from instanceof Date ? co.fiscal_year_from.toISOString() : String(co.fiscal_year_from || '2025-04-01')).slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  console.log(`\n── Asking Tally for the Trial Balance of "${co.tally_name}" ${from} → ${to}`);
  const raw = await tallyClient.request(templates.buildTrialBalanceRequest(co.tally_name, from, to), 1);
  console.log(`reply: ${raw.length} bytes`);
  if (raw.length < 1500) { console.log('RAW REPLY:\n' + raw); return; }
  const names = [...raw.matchAll(/<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>/g)].map((m) => m[1].trim());
  const drs = [...raw.matchAll(/<DSPCLDRAMTA>([^<]*)<\/DSPCLDRAMTA>/g)].map((m) => parseFloat(m[1]) || 0);
  const crs = [...raw.matchAll(/<DSPCLCRAMTA>([^<]*)<\/DSPCLCRAMTA>/g)].map((m) => parseFloat(m[1]) || 0);
  console.table(names.map((n, i) => ({ group: n, net: fmt((crs[i] || 0) + (drs[i] || 0)) })));
  const i = names.indexOf('Current Assets');
  console.log(i >= 0 ? `Tally Trial Balance "Current Assets" now = ${fmt(Math.abs((crs[i] || 0) + (drs[i] || 0)))}` : 'No "Current Assets" group in the reply.');
}

(async () => {
  const { rows } = await pool.query('SELECT * FROM companies WHERE name ILIKE $1', [`%${arg}%`]);
  if (rows.length !== 1) { console.log(`"${arg}" matched ${rows.length} companies — need exactly 1.`); return; }
  await dbPart(rows[0]);
  if (withTally) await tallyPart(rows[0]);
  else console.log('\n(Step 2 asks Tally: stop tally-sync, then run again with --tally.)');
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
