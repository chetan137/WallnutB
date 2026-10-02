'use strict';
/**
 * debug_check_months.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, Tally XML only, SCALAR fields only (safe — same shape as
 * debug_check_period.js / debug_safe_2425.js).
 *
 * debug_check_period_2526.js showed: no period → 0 vouchers; period
 * 2025-04-01→2026-10-02 → only 54 vouchers, ALL in 2025-04, although the
 * company's own period is 2025-04-01 → 2026-10-31 and Tally's mobile app shows
 * real sales for Apr-Sep 2026. This asks Tally for ONE MONTH AT A TIME (period
 * = that month) and prints how many vouchers come back per month, so we can
 * see exactly which months the VM's Tally copy actually holds and serves.
 * It also dumps the raw block of any company whose name could not be parsed
 * (3 companies are loaded but one showed up with a blank name).
 *
 * Same rules as the other debug scripts: stop tallybackend first
 * (pm2 stop tally-sync), only the company Tally has focused is reachable.
 *
 * Usage:
 *   node debug_check_months.js [companyNameContains] [fromYYYY-MM] [toYYYY-MM]
 *     defaults: current company, 2025-04 → 2026-10
 *   node debug_check_months_2526.js > months_2526.txt
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { isoToTally, escapeXml } = require('./utils/helpers');

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

function section(title) {
  console.log('\n' + '═'.repeat(78));
  console.log(title);
  console.log('═'.repeat(78));
}
async function safely(label, fn) {
  try { await fn(); } catch (err) { console.log(`\n❌ ${label} FAILED: ${err.message}`); }
}
const pause = (ms = 500) => new Promise((r) => setTimeout(r, ms));

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

function monthVoucherXml(fromIso, toIso) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>MonthCheck</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE>${isoToTally(fromIso)}</SVFROMDATE>
        <SVTODATE>${isoToTally(toIso)}</SVTODATE>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="MonthCheck" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

function companyXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>MonthCheckCompany</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="MonthCheckCompany" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Company</TYPE>
            <FETCH>Name, StartingFrom, BooksFrom, EndingAt, GUID</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

async function main() {
  console.log('⚠️  tallybackend (pm2 tally-sync / node index.js) should be STOPPED right now.');
  console.log(`Company: ${co.name} (Tally: "${co.tallyName}")`);
  console.log(`Months:  ${fromMonth} → ${toMonth} (one request per month, period = that month)`);

  await safely('STEP A', async () => {
    section('STEP A — Raw company blocks loaded in Tally (to identify the blank-named one)');
    const raw = await tallyClient.request(companyXml());
    const blocks = [...raw.matchAll(/<COMPANY[ >][\s\S]*?<\/COMPANY>/g)].map((m) => m[0]);
    blocks.forEach((b, i) => console.log(`\n  [${i + 1}/${blocks.length}] ${b.replace(/\s+/g, ' ').slice(0, 600)}`));
    if (!blocks.length) console.log(raw.slice(0, 1500));
  });
  await pause(1000);

  await safely('STEP B', async () => {
    section('STEP B — Vouchers per month (period = that month, scalar fields only)');
    console.log('  month     vouchers   sales+credit-note   first date    last date');
    for (const mo of monthsBetween(fromMonth, toMonth)) {
      try {
        const raw = await tallyClient.request(monthVoucherXml(mo.from, mo.to));
        const blocks = [...raw.matchAll(/<VOUCHER[ >][\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]).filter((b) => b.length > 30);
        const dates = blocks.map((b) => (b.match(/<DATE[^>]*>(\d{8})<\/DATE>/) || [])[1] || '').filter(Boolean).sort();
        const sales = blocks.filter((b) => /<VOUCHERTYPENAME>(sales|credit note)/i.test(b)).length;
        console.log(`  ${mo.label}   ${String(blocks.length).padStart(8)}   ${String(sales).padStart(17)}   ${dates[0] || '-'}      ${dates[dates.length - 1] || '-'}`);
      } catch (err) {
        console.log(`  ${mo.label}   ❌ ${err.message}`);
      }
      await pause();
    }
  });

  console.log('\nVERDICT: a month with vouchers here but absent earlier = Tally serves it only when the');
  console.log('         period is narrowed to that month (sync can fetch month by month). Months at 0');
  console.log('         everywhere = the VM\'s Tally copy of this company does not hold that data.');
  console.log('\nPaste this ENTIRE output back.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
