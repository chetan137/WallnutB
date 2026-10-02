'use strict';
/**
 * debug_voucher_access.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY. Finds a way to get the 25-26 company's real vouchers out of Tally.
 *
 * Proven so far (debug_check_months_2526.js + debug_check_pl_months_2526.js):
 *   • P&L REPORT respects the period and has real data (Sales Accounts
 *     78,06,115.89 for Apr-2025 …) — so the VM's Tally holds the company's data.
 *   • The Voucher COLLECTION returns the same 54 vouchers (all dated
 *     1-Apr-2025) for every requested period, and 0 with no period.
 *
 * PART 1  P&L Sales per month, parsed correctly (value is <BSMAINAMT>, not
 *         DSPCLDRAMTA) — compare with the Tally mobile app figures.
 * PART 2  For ONE month (default Sep-2026) try several ways to list vouchers
 *         and print how many each returns + the date range they cover:
 *           1 Day Book report              2 Voucher Register report
 *         3 Sales Register (exploded)      4 Collection, SV dates as D-Mon-YYYY
 *         5 Collection, SV dates + SVCURRENTDATE
 *         The way that returns vouchers dated in the requested month wins.
 *
 * Same rules as the other debug scripts: stop tallybackend first
 * (pm2 stop tally-sync), only the focused company is reachable. Requests are
 * small (one month, scalar/summary shapes) — safe for Tally.
 *
 * Usage:
 *   node debug_voucher_access_2526.js [YYYY-MM-test-month] > access_2526.txt
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const config      = require('./config');
const { isoToTally, isoToTallyLiteral, escapeXml } = require('./utils/helpers');

const [, , companyArg, testMonthArg] = process.argv;
const co = companyArg
  ? config.companies.find((c) => c.name.toLowerCase().includes(companyArg.toLowerCase()) ||
                                 c.tallyName.toLowerCase().includes(companyArg.toLowerCase()))
  : config.companies.find((c) => !c.isHistorical) || config.companies[0];

if (!co) {
  console.error(`No configured company matches "${companyArg}".`);
  process.exit(1);
}

const testMonth = testMonthArg || '2026-09';
const pause = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const inr = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
function section(title) { console.log('\n' + '═'.repeat(78)); console.log(title); console.log('═'.repeat(78)); }
async function safely(label, fn) { try { await fn(); } catch (err) { console.log(`\n❌ ${label} FAILED: ${err.message}`); } }

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, '0');
    out.push({ label: `${y}-${mm}`, from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// DSPACCNAME block followed by its PLAMT block: value is BSMAINAMT (group
// totals) or PLSUBAMT (sub-lines) — whichever is filled.
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

function summarize(raw) {
  const vch  = (raw.match(/<VOUCHER[ >]/g) || []).length;
  const dsp  = (raw.match(/<DSPVCHDATE>/g) || []).length;
  const dates = [
    ...[...raw.matchAll(/<DATE[^>]*>(\d{8})<\/DATE>/g)].map((m) => m[1]),
    ...[...raw.matchAll(/<DSPVCHDATE>([^<]*)<\/DSPVCHDATE>/g)].map((m) => m[1]),
  ].sort();
  console.log(`  ${raw.length} bytes | <VOUCHER> tags: ${vch} | <DSPVCHDATE> rows: ${dsp} | dates: ${dates.length ? `${dates[0]} … ${dates[dates.length - 1]}` : '(none)'}`);
  if (!vch && !dsp) console.log('  First 500 chars:\n  ' + raw.slice(0, 500).replace(/\n/g, '\n  '));
}

function reportXml(reportName, fromIso, toIso, extra = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>${reportName}</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
      <SVFROMDATE>${isoToTally(fromIso)}</SVFROMDATE>
      <SVTODATE>${isoToTally(toIso)}</SVTODATE>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      ${extra}
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

function collectionXml(id, staticVars) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>${id}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${staticVars}
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="${id}" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME</FETCH>
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

  // ── PART 1 ───────────────────────────────────────────────────────────────
  section('PART 1 — P&L "Sales Accounts" / "Branch Trf-Sales" per month (parsed correctly)');
  console.log('Tally mobile app: Apr-26 36,73,216 | May 67,54,724 | Jun 75,33,440 | Jul 66,20,484 | Aug 80,04,362 | Sep(to 19th) 30,39,911\n');
  console.log('  month     Sales Accounts      Branch Trf-Sales    Revenue From Ops');
  for (const mo of monthsBetween('2025-04', '2026-10')) {
    try {
      const raw  = await tallyClient.request(templates.buildProfitAndLossRequest(co.tallyName, mo.from, mo.to));
      const rows = plRows(raw);
      const get  = (n) => rows.find((r) => r.name.toLowerCase() === n.toLowerCase());
      const s = get('Sales Accounts'), b = get('Branch Trf-Sales'), r = get('Revenue From Operations');
      console.log(`  ${mo.label}   ${inr(s ? s.val : 0).padStart(16)}   ${inr(b ? b.val : 0).padStart(16)}   ${inr(r ? r.val : 0).padStart(12)}`);
    } catch (err) {
      console.log(`  ${mo.label}   ❌ ${err.message}`);
    }
    await pause(400);
  }

  // ── PART 2 ───────────────────────────────────────────────────────────────
  const [mo] = monthsBetween(testMonth, testMonth);
  section(`PART 2 — ways to list vouchers for ${mo.label} (${mo.from} → ${mo.to})`);

  await safely('1 Day Book', async () => {
    console.log('\n[1] REPORT "Day Book":');
    summarize(await tallyClient.request(reportXml('Day Book', mo.from, mo.to)));
  });
  await pause();

  await safely('2 Voucher Register', async () => {
    console.log('\n[2] REPORT "Voucher Register":');
    summarize(await tallyClient.request(reportXml('Voucher Register', mo.from, mo.to)));
  });
  await pause();

  await safely('3 Sales Register', async () => {
    console.log('\n[3] REPORT "Sales Register" (exploded):');
    summarize(await tallyClient.request(reportXml('Sales Register', mo.from, mo.to, '<EXPLODEFLAG>Yes</EXPLODEFLAG>')));
  });
  await pause();

  await safely('4 Collection D-Mon-YYYY', async () => {
    console.log('\n[4] COLLECTION, SVFROMDATE/SVTODATE as D-Mon-YYYY:');
    const vars = `<SVFROMDATE>${isoToTallyLiteral(mo.from)}</SVFROMDATE><SVTODATE>${isoToTallyLiteral(mo.to)}</SVTODATE>`;
    summarize(await tallyClient.request(collectionXml('AccessLiteral', vars)));
  });
  await pause();

  await safely('5 Collection + SVCURRENTDATE', async () => {
    console.log('\n[5] COLLECTION, SV dates (YYYYMMDD) + SVCURRENTDATE:');
    const vars = `<SVFROMDATE>${isoToTally(mo.from)}</SVFROMDATE><SVTODATE>${isoToTally(mo.to)}</SVTODATE><SVCURRENTDATE>${isoToTally(mo.to)}</SVCURRENTDATE>`;
    summarize(await tallyClient.request(collectionXml('AccessCurrentDate', vars)));
  });

  console.log('\nVERDICT: PART 1 should match the mobile figures (Branch Trf-Sales shows how much of');
  console.log('         Sales is branch transfer). In PART 2, the way whose dates fall inside the');
  console.log('         requested month is the one the sync must use for vouchers.');
  console.log('\nPaste this ENTIRE output back.');
}

main().catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); });
