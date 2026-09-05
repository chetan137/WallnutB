'use strict';
/**
 * debug_investigation.js  (v2)
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  IMPORTANT — run this with tallybackend's own process FULLY STOPPED first
 *     (pm2 stop tally-sync, or Ctrl+C if running `node index.js` directly).
 *     Evidence from the first run: this script's requests got back a response
 *     that clearly belonged to something else entirely (an "All Masters"/
 *     REMOTECMPINFO company-info reply for a plain Day Book request) — that
 *     only makes sense if tallybackend's OWN process was mid-sync (index.js
 *     runs a full sync cycle immediately on startup) and both processes hit
 *     Tally's single-request XML server at the same time. Tally is not
 *     built to multiplex concurrent HTTP requests safely — running two
 *     Tally-querying tools at once can genuinely cross-wire responses. This
 *     may be a real contributor to the "some data right, some wrong"
 *     inconsistency reported across the whole sync system, independent of
 *     anything else this investigates.
 *
 * Run on the VM (with tallybackend stopped):  node debug_investigation.js
 * Read-only — only EXPORTs from Tally, never writes, never touches Postgres.
 *
 *  TEST 1 — Company 2 (active): wide vs narrow Day Book date range.
 *  TEST 2 — Company 1 (historical): raw <DATE> tags, AND checks whether
 *           duplicate (VOUCHERNUMBER, VCHTYPE) keys exist across the two
 *           dates already found in the raw XML — if so, tallybackend's
 *           ON CONFLICT (company_id, vch_no, vch_type) upsert would silently
 *           let one date's row overwrite the other's, explaining why the DB
 *           only ever shows one date despite Tally sending two.
 *  TEST 3 — Per-item stock cost via the PROVEN-working ad-hoc TDL Collection
 *           structure (Export/TYPE=Collection/ID + BODY>DESC>TDL — copied
 *           from backend/services/tallyFetchService.js's working voucher
 *           collection request, NOT the Export-Data/REPORTNAME pattern the
 *           first run of this script wrongly used, which just errored
 *           "Could not find Report").
 *  TEST 4 — Whether Budgets are configured in Tally at all.
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { isoToTally, subtractDays, todayIso, dbDateToIso, escapeXml } = require('./utils/helpers');

function endOfFiscalYear(fromDate) {
  const d = new Date(fromDate);
  const endYear = d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();
  return `${endYear}-03-31`;
}

function buildDayBookXml(companyName, fromTally, toTally) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>Day Book</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
      <SVFROMDATE>${fromTally}</SVFROMDATE>
      <SVTODATE>${toTally}</SVTODATE>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

function countTag(raw, tag) {
  const re = new RegExp(`<${tag}[ >]`, 'g');
  return (raw.match(re) || []).length;
}

function uniqueTags(raw) {
  return [...new Set([...raw.matchAll(/<([A-Z][A-Z0-9_.]*)[>\s/]/g)].map((m) => m[1]))].sort();
}

function section(title) {
  console.log('\n' + '═'.repeat(78));
  console.log(title);
  console.log('═'.repeat(78));
}

async function safely(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`\n❌ ${label} FAILED: ${err.message}`);
  }
}

async function main() {
  console.log('⚠️  Reminder: tallybackend\'s own process (pm2 tally-sync / node index.js)');
  console.log('   should be STOPPED right now — otherwise responses below may be unreliable.\n');

  const historical = config.companies.find((c) => c.isHistorical);
  const active     = config.companies.find((c) => !c.isHistorical);

  console.log('Companies configured:');
  config.companies.forEach((c) => console.log(`  - ${c.name} (Tally: "${c.tallyName}", historical: ${c.isHistorical}, FY from: ${c.fiscalYearFrom})`));

  // ── TEST 1 — wide vs narrow Day Book range for the ACTIVE company ────────
  if (active) {
    await safely('TEST 1', async () => {
      section(`TEST 1 — Active company "${active.name}": WIDE vs NARROW Day Book range`);

      const today = todayIso();
      const wideFrom = active.fiscalYearFrom;
      console.log(`\nWIDE request: ${wideFrom} → ${today}`);
      const t0 = Date.now();
      const wideRaw = await tallyClient.request(buildDayBookXml(active.tallyName, isoToTally(wideFrom), isoToTally(today)));
      console.log(`  → ${wideRaw.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${countTag(wideRaw, 'VOUCHER')} | <TALLYMESSAGE> tags: ${countTag(wideRaw, 'TALLYMESSAGE')}`);
      // A real Day Book response should have hundreds of <VOUCHER> tags for
      // this date range (DB already shows 941 real vouchers) — a low count
      // like 1-10 is as suspicious as 0, so dump full diagnostics whenever
      // it's implausibly low, not only when it's exactly zero.
      if (countTag(wideRaw, 'VOUCHER') < 50) {
        console.log('  Unique tags in WIDE response:');
        console.log('  ' + uniqueTags(wideRaw).join(', '));
        console.log('  First 2000 chars of WIDE response:');
        console.log('  ' + wideRaw.slice(0, 2000).replace(/\n/g, '\n  '));
      }

      // Small pause so this request is fully done before the next one — no overlap possible.
      await new Promise((r) => setTimeout(r, 1000));

      const narrowFrom = subtractDays(today, 60);
      console.log(`\nNARROW request: ${narrowFrom} → ${today} (last 60 days)`);
      const t1 = Date.now();
      const narrowRaw = await tallyClient.request(buildDayBookXml(active.tallyName, isoToTally(narrowFrom), isoToTally(today)));
      console.log(`  → ${narrowRaw.length} bytes in ${Date.now() - t1}ms | <VOUCHER> tags: ${countTag(narrowRaw, 'VOUCHER')} | <TALLYMESSAGE> tags: ${countTag(narrowRaw, 'TALLYMESSAGE')}`);
      if (countTag(narrowRaw, 'VOUCHER') < 50) {
        console.log('  Unique tags in NARROW response:');
        console.log('  ' + uniqueTags(narrowRaw).join(', '));
        console.log('  First 2000 chars of NARROW response:');
        console.log('  ' + narrowRaw.slice(0, 2000).replace(/\n/g, '\n  '));
      }
      console.log(`\n  WIDE and NARROW byte-identical: ${wideRaw.length === narrowRaw.length && wideRaw === narrowRaw}`);

      console.log('\nVERDICT: if both now show real <VOUCHER> counts (hundreds), last run\'s empty/wrong');
      console.log('         responses were caused by tallybackend\'s own process running concurrently.');
      console.log('         If WIDE is still 0 while NARROW has hundreds, Tally itself is capping wide exports.');
    });
  } else {
    console.log('\n(No active/non-historical company configured — skipping TEST 1)');
  }

  // ── TEST 2 — raw DATE tags + duplicate-key check for the HISTORICAL company
  if (historical) {
    await safely('TEST 2', async () => {
      section(`TEST 2 — Historical company "${historical.name}": raw <DATE> tags + duplicate-key check`);

      const fromDate = dbDateToIso(historical.fiscalYearFrom) || historical.fiscalYearFrom;
      const toDate = endOfFiscalYear(fromDate);
      console.log(`\nRequest: ${fromDate} → ${toDate} (fiscal year bounds)`);
      const raw = await tallyClient.request(buildDayBookXml(historical.tallyName, isoToTally(fromDate), isoToTally(toDate)));
      console.log(`  → ${raw.length} bytes | <VOUCHER> tags: ${countTag(raw, 'VOUCHER')}`);
      if (countTag(raw, 'VOUCHER') === 0) {
        console.log('  Full raw response (small — printing all of it):');
        console.log('  ' + raw.replace(/\n/g, '\n  '));
      }

      const dates = [...raw.matchAll(/<DATE>([^<]*)<\/DATE>/g)].map((m) => m[1]);
      const distinct = [...new Set(dates)];
      console.log(`\nTotal <DATE> tags found: ${dates.length}`);
      console.log(`Distinct date values: ${distinct.length} — ${distinct.join(', ')}`);

      // Properly scope each <VOUCHER ...>...</VOUCHER> block and pull its own
      // VOUCHERNUMBER + VOUCHERTYPENAME + DATE — no cross-voucher spillover.
      const voucherBlocks = [...raw.matchAll(/<VOUCHER[ >][\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
      console.log(`\n<VOUCHER>...</VOUCHER> blocks found: ${voucherBlocks.length}`);

      const parsed = voucherBlocks.map((block) => {
        const vchNo  = (block.match(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/) || [])[1] || '';
        const vchTyp = (block.match(/<VOUCHERTYPENAME>([^<]*)<\/VOUCHERTYPENAME>/) || [])[1] || '';
        const date   = (block.match(/<DATE>([^<]*)<\/DATE>/) || [])[1] || '';
        return { vchNo, vchTyp, date };
      });

      console.log('\nFirst 10 (vchNo | vchType | date):');
      parsed.slice(0, 10).forEach((p) => console.log(`  ${p.vchNo.padEnd(20)} | ${p.vchTyp.padEnd(20)} | ${p.date}`));

      // Real date distribution across ALL 213 properly-scoped voucher blocks
      // (the duplicate-key check below turned out to be a red herring — none
      // of its duplicates actually span two different dates — so this is
      // the real answer to "does the DB's single-date result match Tally's
      // actual per-voucher dates, or is something being lost/miscounted").
      const dateCounts = {};
      for (const p of parsed) dateCounts[p.date] = (dateCounts[p.date] || 0) + 1;
      console.log('\nDate distribution across all 213 <VOUCHER> blocks:');
      Object.entries(dateCounts).sort((a, b) => b[1] - a[1]).forEach(([d, n]) => console.log(`  ${d}: ${n} vouchers`));

      const march1 = parsed.filter((p) => p.date === '20250301');
      console.log(`\nAll vouchers dated 20250301 (${march1.length}):`);
      march1.slice(0, 20).forEach((p) => console.log(`  ${p.vchNo.padEnd(20)} | ${p.vchTyp}`));

      // Duplicate-key check — this is what tallybackend's ON CONFLICT (company_id, vch_no, vch_type) upserts by.
      const byKey = {};
      for (const p of parsed) {
        const key = `${p.vchNo}::${p.vchTyp}`;
        if (!byKey[key]) byKey[key] = [];
        byKey[key].push(p.date);
      }
      const dupes = Object.entries(byKey).filter(([, dates]) => dates.length > 1);
      console.log(`\nDuplicate (vchNo, vchType) keys found: ${dupes.length} out of ${Object.keys(byKey).length} unique keys`);
      if (dupes.length > 0) {
        console.log('Sample duplicates (key → dates seen for that SAME key):');
        dupes.slice(0, 10).forEach(([key, ds]) => console.log(`  ${key}  →  ${ds.join(', ')}`));
        console.log('\n⚠️  If any of these show TWO DIFFERENT dates for the same key, that confirms the bug:');
        console.log('    tallybackend\'s UPSERT (ON CONFLICT company_id,vch_no,vch_type) lets whichever');
        console.log('    one gets processed LAST silently overwrite the other — one real voucher is lost.');
      }

      console.log('\nVERDICT: distinct dates > 1 in raw Tally data + duplicate keys spanning those dates');
      console.log('         = confirmed upsert-key collision bug, not a parsing bug and not "Tally reports one date".');
    });
  } else {
    console.log('\n(No historical company configured — skipping TEST 2)');
  }

  // ── TEST 3 — per-item stock cost via the PROVEN ad-hoc TDL Collection ────
  await safely('TEST 3', async () => {
    const co = active || historical;
    section(`TEST 3 — Per-item stock cost via ad-hoc TDL Collection (company: "${co.name}")`);

    // Structure copied from backend/services/tallyFetchService.js's
    // buildLiveSalesRequest(), which is the one proven working ad-hoc
    // collection request in this codebase (Export + TYPE=Collection + ID,
    // not Export Data + REPORTNAME — that pattern only resolves NAMED
    // built-in reports, which is why the last run errored "Could not find
    // Report 'StockItemCostCollection'").
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>StockItemCostCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="StockItemCostCollection" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>StockItem</TYPE>
            <FETCH>Name, ClosingBalance, ClosingValue, ClosingRate, StandardCost, CostingMethod, BaseUnits</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    const raw = await tallyClient.request(xml);
    console.log(`\nResponse: ${raw.length} bytes | <STOCKITEM> tags: ${countTag(raw, 'STOCKITEM')}`);
    console.log('\nAll unique tags in response:');
    const tags = new Set([...raw.matchAll(/<([A-Z][A-Z0-9_.]*)[>\s/]/g)].map((m) => m[1]));
    console.log('  ' + [...tags].sort().join(', '));
    console.log('\nFirst 3000 chars:');
    console.log(raw.slice(0, 3000));

    console.log('\nVERDICT: if <STOCKITEM> tags > 0 with real item names + ClosingRate/StandardCost values,');
    console.log('         this ad-hoc collection works and can replace the group-level Stock Summary fallback.');
  });

  // ── TEST 4 — does this company have Tally Budgets configured? ────────────
  await safely('TEST 4', async () => {
    const co = active || historical;
    section(`TEST 4 — Budget data (company: "${co.name}")`);

    const today = todayIso();
    const fromDate = dbDateToIso(co.fiscalYearFrom) || co.fiscalYearFrom;
    const toDate = co.isHistorical ? endOfFiscalYear(fromDate) : today;

    const candidates = ['Group Budget Variances', 'Budget Variance', 'Group Budget Variance', 'Cost Centre Budget Variance'];
    for (const reportName of candidates) {
      console.log(`\nTrying REPORTNAME="${reportName}" (${fromDate} → ${toDate})...`);
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>${reportName}</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
      <SVFROMDATE>${isoToTally(fromDate)}</SVFROMDATE>
      <SVTODATE>${isoToTally(toDate)}</SVTODATE>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
      try {
        const raw = await tallyClient.request(xml);
        const isError = /<LINEERROR>/i.test(raw);
        console.log(`  → ${raw.length} bytes${isError ? '  [Tally: ' + (raw.match(/<LINEERROR>([^<]*)<\/LINEERROR>/) || [,'error'])[1] + ']' : ''}`);
        if (!isError && raw.length > 200) {
          console.log('  First 1200 chars:');
          console.log('  ' + raw.slice(0, 1200).replace(/\n/g, '\n  '));
        }
      } catch (err) {
        console.log(`  → request failed: ${err.message}`);
      }
    }
    console.log('\nVERDICT: a real, non-error response with budget-amount tags means budgets ARE configured.');
    console.log('         "Could not find Report" for all names is inconclusive — could mean no budgets,');
    console.log('         or just that none of these 4 candidate names match this Tally version\'s internal name.');
  });

  // ── TEST 5 — does a NONSENSE report name for the SAME (focused) company ──
  // also return this "Import Data / All Masters" response? If yes, this
  // proves the response has nothing to do with "Day Book" resolution — the
  // focused company just returns this fixed/growing payload for ANY export
  // request, regardless of what's actually asked. If instead we get a clean
  // "Could not find Report" error (like TEST 3's first attempt did), that
  // proves "Day Book" specifically is being intercepted/redirected while
  // other report names resolve normally.
  await safely('TEST 5', async () => {
    const co = active || historical;
    section(`TEST 5 — Nonsense REPORTNAME for company "${co.name}" (should error if names resolve normally)`);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>ThisReportDoesNotExist12345</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;

    const raw = await tallyClient.request(xml);
    const isError = /<LINEERROR>/i.test(raw);
    console.log(`\n  → ${raw.length} bytes | <VOUCHER> tags: ${countTag(raw, 'VOUCHER')}${isError ? '  [Tally: ' + (raw.match(/<LINEERROR>([^<]*)<\/LINEERROR>/) || [, 'error'])[1] + ']' : ''}`);
    if (!isError) {
      console.log('  Not an error — first 800 chars:');
      console.log('  ' + raw.slice(0, 800).replace(/\n/g, '\n  '));
    }

    console.log('\nVERDICT: "Could not find Report" here = report names resolve normally, "Day Book" is');
    console.log('         specifically being redirected. Same All-Masters-style response here = this');
    console.log('         company returns a fixed/growing payload for ANY export request, unrelated to REPORTNAME.');
  });

  // ── TEST 6 — Vouchers via ad-hoc TDL Collection (bypasses "Day Book") ────
  // TEST 5 proved report names resolve normally and "Day Book" specifically
  // is being redirected (likely a TDL add-on hooking that exact report name
  // for its own purpose — e.g. a GST e-invoice/e-way-bill tool). Same fix
  // pattern as TEST 3's working StockItem collection: ask for a Voucher
  // COLLECTION via Export+TYPE=Collection instead of Export Data+REPORTNAME,
  // which sidesteps "Day Book" entirely. Voucher collections are period-
  // sensitive by default in Tally (unlike Ledger/StockItem collections),
  // so SVFROMDATE/SVTODATE should scope this without an explicit FILTER.
  await safely('TEST 6', async () => {
    const co = active || historical;
    section(`TEST 6 — Vouchers via ad-hoc TDL Collection, bypassing "Day Book" (company: "${co.name}")`);

    // Narrowed to last 30 days and SCALAR fields only (no LEDGERENTRIES.LIST /
    // ALLINVENTORYENTRIES.LIST yet) — TEST 6's first attempt requested those
    // compound/multi-row fields directly in FETCH, which Tally can't expand
    // without a proper nested PART/LINE definition, so it silently collapsed
    // every voucher to a bare "<VOUCHER>0</VOUCHER>" placeholder (105MB of
    // them). Proving scalar fields work first, on a small window, before
    // widening the range or adding the compound fields back properly.
    const today = todayIso();
    const fromDate = subtractDays(today, 30);
    console.log(`\nRequest: ${fromDate} → ${today} (last 30 days, scalar fields only)`);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>VoucherCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVFROMDATE>${isoToTally(fromDate)}</SVFROMDATE>
        <SVTODATE>${isoToTally(today)}</SVTODATE>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="VoucherCollection" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME, NARRATION</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    const t0 = Date.now();
    const raw = await tallyClient.request(xml);
    console.log(`  → ${raw.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${countTag(raw, 'VOUCHER')}`);

    const voucherBlocks = [...raw.matchAll(/<VOUCHER[ >][\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
    const realBlocks = voucherBlocks.filter((b) => b.length > 30); // skip bare "<VOUCHER>0</VOUCHER>" placeholders
    console.log(`  <VOUCHER> blocks: ${voucherBlocks.length} | non-placeholder blocks: ${realBlocks.length}`);

    if (realBlocks.length === 0) {
      console.log('  Unique tags in response:');
      console.log('  ' + uniqueTags(raw).join(', '));
      console.log('  First 2000 chars:');
      console.log('  ' + raw.slice(0, 2000).replace(/\n/g, '\n  '));
    } else {
      const dates = realBlocks.map((b) => (b.match(/<DATE>([^<]*)<\/DATE>/) || [])[1] || '');
      const dateCounts = {};
      for (const d of dates) dateCounts[d] = (dateCounts[d] || 0) + 1;
      console.log(`  distinct dates: ${Object.keys(dateCounts).length}`);
      console.log('  Date distribution (top 15):');
      Object.entries(dateCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([d, n]) => console.log(`    ${d}: ${n} vouchers`));
      console.log('\n  First real voucher block (first 800 chars):');
      console.log('  ' + realBlocks[0].slice(0, 800).replace(/\n/g, '\n  '));
    }

    console.log('\nVERDICT: real VOUCHER blocks with DATE/VOUCHERNUMBER/etc populated and dates spread');
    console.log('         across the last 30 days = scalar fields work via this collection. Next step');
    console.log('         would be adding ledger/inventory entries back with proper nested TDL parts.');
  });

  // ── TEST 7 — add LEDGERENTRIES.LIST / ALLINVENTORYENTRIES.LIST back in,
  // on a TINY date window (3 days) so a bad result is small enough to read
  // and a good result is small enough to be fast. Isolates whether compound
  // list fields are fundamentally unfetchable this way, or whether TEST 6's
  // first attempt broke because of the full-fiscal-year response size.
  await safely('TEST 7', async () => {
    const co = active || historical;
    section(`TEST 7 — Add ledger + inventory entries back, tiny 3-day window (company: "${co.name}")`);

    const today = todayIso();
    const fromDate = subtractDays(today, 3);
    console.log(`\nRequest: ${fromDate} → ${today} (last 3 days, scalar + LEDGERENTRIES.LIST + ALLINVENTORYENTRIES.LIST)`);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>VoucherCollection2</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVFROMDATE>${isoToTally(fromDate)}</SVFROMDATE>
        <SVTODATE>${isoToTally(today)}</SVTODATE>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="VoucherCollection2" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME, NARRATION</FETCH>
            <FETCH>LEDGERENTRIES.LIST</FETCH>
            <FETCH>ALLINVENTORYENTRIES.LIST</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    const t0 = Date.now();
    const raw = await tallyClient.request(xml);
    console.log(`  → ${raw.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${countTag(raw, 'VOUCHER')}`);
    console.log(`  <LEDGERENTRIES.LIST> tags: ${countTag(raw, 'LEDGERENTRIES\\.LIST')} | <ALLINVENTORYENTRIES.LIST> tags: ${countTag(raw, 'ALLINVENTORYENTRIES\\.LIST')}`);

    const voucherBlocks = [...raw.matchAll(/<VOUCHER[ >][\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
    const realBlocks = voucherBlocks.filter((b) => b.length > 30);
    console.log(`  <VOUCHER> blocks: ${voucherBlocks.length} | non-placeholder blocks: ${realBlocks.length}`);

    if (realBlocks.length > 0) {
      console.log('\n  First real voucher block (first 2500 chars):');
      console.log('  ' + realBlocks[0].slice(0, 2500).replace(/\n/g, '\n  '));
    } else {
      console.log('  Unique tags in response:');
      console.log('  ' + uniqueTags(raw).join(', '));
      console.log('  First 2000 chars:');
      console.log('  ' + raw.slice(0, 2000).replace(/\n/g, '\n  '));
    }

    console.log('\nVERDICT: if the voucher block shows real nested LEDGERENTRIES.LIST/ALLINVENTORYENTRIES.LIST');
    console.log('         with LEDGERNAME/AMOUNT/STOCKITEMNAME populated, this fetch shape can fully replace');
    console.log('         "Day Book". If it collapses to a placeholder again, compound fields need a');
    console.log('         different TDL structure (nested PART/LINE) regardless of response size.');
  });

  section('DONE — copy this whole output back to Claude for analysis.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
