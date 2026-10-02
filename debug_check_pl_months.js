'use strict';
/**
 * debug_check_pl_months.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY. Tally REPORTS (Profit and Loss) respect SVFROMDATE/SVTODATE —
 * unlike the Voucher collection, which debug_check_months_2526.js proved is
 * stuck on 54 vouchers dated 1-Apr-2025 whatever period is requested.
 *
 * This asks Tally's P&L for ONE MONTH AT A TIME and prints every line that
 * looks like Sales, so we can compare with Tally's own mobile dashboard:
 *   Apr-2026 36,73,216 | May 67,54,724 | Jun 75,33,440 | Jul 66,20,484
 *   Aug 80,04,362 | Sep (to 19-Sep) 30,39,911   (company "…-2025-26")
 *
 *   • Sales ≈ those numbers  → the VM's Tally DOES hold Apr-Sep 2026; only the
 *     Voucher collection is limited, and the sync needs another way in.
 *   • Sales = 0 for 2026     → the VM's Tally copy of this company does NOT hold
 *     that data (the mobile app is reading a different/newer copy).
 *
 * Same rules as the other debug scripts: stop tallybackend first
 * (pm2 stop tally-sync), only the focused company is reachable.
 *
 * Usage:
 *   node debug_check_pl_months.js [companyNameContains] [fromYYYY-MM] [toYYYY-MM]
 *     defaults: current company, 2025-04 → 2026-10
 *   FY 24-25 total:  node debug_check_pl_months.js 24-25 2024-04 2025-03
 *   node debug_check_pl_months_2526.js > pl_months_2526.txt
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const config      = require('./config');

const [, , companyArg, fromArg, toArg] = process.argv;
const co = companyArg
  ? config.companies.find((c) => c.name.toLowerCase().includes(companyArg.toLowerCase()) ||
                                 c.tallyName.toLowerCase().includes(companyArg.toLowerCase()))
  : config.companies.find((c) => !c.isHistorical) || config.companies[0];

if (!co) {
  console.error(`No configured company matches "${companyArg}". Configured companies:`);
  config.companies.forEach((c) => console.error(`  - ${c.name} (Tally: "${c.tallyName}")`));
  process.exit(1);
}

const fromMonth = fromArg || '2025-04';
const toMonth   = toArg   || '2026-10';
const pause = (ms = 500) => new Promise((r) => setTimeout(r, ms));
const inr = (n) => Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, '0');
    out.push({ label: `${y}-${mm}`, from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// P&L rows: <DSPDISPNAME> followed by its <PLAMT> block. The amount is
// <BSMAINAMT> for group totals (Sales Accounts, …) or <PLSUBAMT> for sub-lines.
// (An earlier version read <DSPCLDRAMTA>, which this report never contains, so
// every month showed 0 — verified against the raw XML.)
function plRows(raw) {
  const rows = [];
  const re = /<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>[\s\S]*?<PLSUBAMT>([^<]*)<\/PLSUBAMT>\s*<BSMAINAMT>([^<]*)<\/BSMAINAMT>/g;
  let m;
  while ((m = re.exec(raw))) {
    const val = parseFloat(m[3]) || parseFloat(m[2]) || 0;
    rows.push({ name: m[1].trim().replace(/&#13;&#10;/g, ' ').replace(/&amp;/g, '&'), val });
  }
  return rows;
}

async function main() {
  console.log('⚠️  tallybackend (pm2 tally-sync / node index.js) should be STOPPED right now.');
  console.log(`Company: ${co.name} (Tally: "${co.tallyName}")`);
  console.log(`Months:  ${fromMonth} → ${toMonth} (P&L report, period = that month)`);
  console.log('\nTally mobile app (same company): Apr-26 36,73,216 | May 67,54,724 | Jun 75,33,440 | Jul 66,20,484 | Aug 80,04,362 | Sep(to 19th) 30,39,911\n');

  let firstRaw = null;
  let yearTotal = 0;
  for (const mo of monthsBetween(fromMonth, toMonth)) {
    try {
      const raw = await tallyClient.request(templates.buildProfitAndLossRequest(co.tallyName, mo.from, mo.to));
      if (!firstRaw) firstRaw = raw;
      const rows = plRows(raw);
      const hits = rows.filter((r) => /^(sales accounts|branch trf-sales)$/i.test(r.name)).map((r) => `${r.name} = ${inr(r.val)}`);
      yearTotal += (rows.find((r) => /^sales accounts$/i.test(r.name)) || { val: 0 }).val;
      console.log(`${mo.label}  ${hits.length ? hits.join(' ; ') : '(no Sales Accounts row)'}`);
    } catch (err) {
      console.log(`${mo.label}  ❌ ${err.message}`);
    }
    await pause();
  }

  console.log(`
Sum of "Sales Accounts" over these months: ${inr(yearTotal)}`);

  if (firstRaw) {
    console.log('\n── Raw P&L XML of the FIRST month (first 3000 chars) so the row layout is visible:');
    console.log(firstRaw.slice(0, 3000));
  }

  console.log('\nVERDICT: compare each month\'s Sales with the mobile-app figures above.');
  console.log('         Match → VM Tally has the data. 0 / far off → check which copy holds it.');
  console.log('\nPaste this ENTIRE output back.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
