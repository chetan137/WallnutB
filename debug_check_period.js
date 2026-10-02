'use strict';
/**
 * debug_check_period.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, Tally XML only, SCALAR fields only (DATE, VOUCHERNUMBER,
 * VOUCHERTYPENAME — the same safe shape as debug_safe_2425.js STEP A, which
 * never crashed Tally even for ~10k vouchers).
 *
 * Why: Tally's own mobile app shows the "2025-26" company holding real sales
 * for Apr-Sep 2026 (Apr 36.7L, May 67.5L, Jun 75.3L, Jul 66.2L, Aug 80.0L,
 * Sep 30.4L), yet debug_find_branch_sample_2526.js got 0 vouchers for
 * 2026-09-01 → 2026-09-15 (an empty 1511-byte envelope), and the dashboard
 * is missing that data. This finds out WHICH months Tally actually returns
 * for the company, and whether passing SVFROMDATE/SVTODATE (the company's
 * "period") changes it — the likely cause being that the voucher collection
 * only covers the company's current period (Apr-2025 → Mar-2026) by default.
 *
 *   STEP A  Company master: books-from / FY-start / period fields.
 *   STEP B  ALL vouchers, no period set        → vouchers per month.
 *   STEP C  ALL vouchers, period = from → to   → vouchers per month.
 *   Compare B and C: months that only show up in C = outside the default period.
 *
 * Same rules as the other debug scripts: stop tallybackend first
 * (pm2 stop tally-sync), only the company Tally has focused is reachable.
 *
 * Usage:
 *   node debug_check_period.js [companyNameContains] [fromDate] [toDate]
 *     defaults: current company, 2025-04-01 → today
 *   node debug_check_period_2526.js > period_2526.txt   (wrapper, one per company)
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { todayIso, isoToTally, escapeXml } = require('./utils/helpers');

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

const fromDate = fromArg || '2025-04-01';
const toDate   = toArg   || todayIso();

function section(title) {
  console.log('\n' + '═'.repeat(78));
  console.log(title);
  console.log('═'.repeat(78));
}
async function safely(label, fn) {
  try { await fn(); } catch (err) { console.log(`\n❌ ${label} FAILED: ${err.message}`); }
}
const pause = () => new Promise((r) => setTimeout(r, 1000));

function scalarVoucherXml(withPeriod) {
  const period = withPeriod
    ? `<SVFROMDATE>${isoToTally(fromDate)}</SVFROMDATE>
        <SVTODATE>${isoToTally(toDate)}</SVTODATE>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>PeriodCheck${withPeriod ? 'P' : 'N'}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${period}
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="PeriodCheck${withPeriod ? 'P' : 'N'}" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
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
    <ID>PeriodCheckCompany</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="PeriodCheckCompany" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Company</TYPE>
            <FETCH>Name, StartingFrom, BooksFrom, EndingAt, LastVoucherDate</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

function monthTable(raw) {
  const blocks = [...raw.matchAll(/<VOUCHER[ >][\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]).filter((b) => b.length > 30);
  const byMonth = {};
  const salesByMonth = {};
  for (const b of blocks) {
    const d    = (b.match(/<DATE[^>]*>(\d{8})<\/DATE>/) || [])[1] || '';
    const type = (b.match(/<VOUCHERTYPENAME>([^<]*)<\/VOUCHERTYPENAME>/) || [])[1] || '';
    const ym   = d ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : '(no date)';
    byMonth[ym] = (byMonth[ym] || 0) + 1;
    if (/^sales|^credit note/i.test(type)) salesByMonth[ym] = (salesByMonth[ym] || 0) + 1;
  }
  console.log(`  ${raw.length} bytes | ${blocks.length} vouchers`);
  console.log('  month      all vouchers   sales+credit-note');
  Object.keys(byMonth).sort().forEach((ym) =>
    console.log(`  ${ym}   ${String(byMonth[ym]).padStart(10)}   ${String(salesByMonth[ym] || 0).padStart(10)}`));
  if (!blocks.length) console.log('  Raw response (first 1500 chars):\n' + raw.slice(0, 1500));
  return blocks.length;
}

async function main() {
  console.log('⚠️  tallybackend (pm2 tally-sync / node index.js) should be STOPPED right now.');
  console.log(`Company: ${co.name} (Tally: "${co.tallyName}")`);
  console.log(`Period used in STEP C: ${fromDate} → ${toDate}`);
  console.log('Tally mobile app says this company has Apr-Sep 2026 sales — expect months 2026-04 … 2026-09 below.');

  await safely('STEP A', async () => {
    section('STEP A — Company master (period / books-from fields)');
    const raw = await tallyClient.request(companyXml());
    const blocks = [...raw.matchAll(/<COMPANY[ >][\s\S]*?<\/COMPANY>/g)].map((m) => m[0]);
    console.log(`  ${raw.length} bytes | ${blocks.length} companies loaded in Tally`);
    for (const b of blocks) {
      const name = (b.match(/\sNAME="([^"]*)"/) || [])[1] || (b.match(/<NAME[^>]*>([^<]*)<\/NAME>/) || [])[1] || '';
      const pick = (t) => (b.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)) || [])[1] || '';
      console.log(`  ${name}\n    STARTINGFROM=${pick('STARTINGFROM')}  BOOKSFROM=${pick('BOOKSFROM')}  ENDINGAT=${pick('ENDINGAT')}  LASTVOUCHERDATE=${pick('LASTVOUCHERDATE')}`);
    }
    if (!blocks.length) console.log('  First 1500 chars:\n' + raw.slice(0, 1500));
  });
  await pause();

  await safely('STEP B', async () => {
    section('STEP B — ALL vouchers, NO period set (what production sends today)');
    const t0 = Date.now();
    const raw = await tallyClient.request(scalarVoucherXml(false));
    console.log(`  fetched in ${Date.now() - t0}ms`);
    monthTable(raw);
  });
  await pause();

  await safely('STEP C', async () => {
    section(`STEP C — ALL vouchers WITH period SVFROMDATE=${fromDate} SVTODATE=${toDate}`);
    const t0 = Date.now();
    const raw = await tallyClient.request(scalarVoucherXml(true));
    console.log(`  fetched in ${Date.now() - t0}ms`);
    monthTable(raw);
  });

  console.log('\nVERDICT: months present in STEP C but missing from STEP B = Tally only serves the');
  console.log('         default period unless SVFROMDATE/SVTODATE are sent → fix is adding them to');
  console.log('         buildAllVouchersRequest. Months missing from BOTH = that data is not in this');
  console.log('         company at all (check which company holds Apr-Sep 2026).');
  console.log('\nPaste this ENTIRE output back.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
