'use strict';
/**
 * debug_investigation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot diagnostic script — runs ON the VM (so it can reach Tally directly
 * on localhost:9000, no firewall changes needed). Investigates 4 open
 * questions from the current sync bug hunt:
 *
 *  TEST 1 — Company 2 (active): does a WIDE date range (fiscal-year-start to
 *           today) really return fewer/zero vouchers than a NARROW range
 *           covering a subset of that same period? (It did in production —
 *           full sync fetched 0, but 941 rows already exist from a narrower
 *           incremental sync.) This checks whether Tally silently caps/limits
 *           very wide Day Book exports.
 *
 *  TEST 2 — Company 1 (historical): are the raw <DATE> tags in Tally's own
 *           response actually all identical (a Tally/company behavior), or
 *           are there real varied dates that the parser is somehow losing
 *           (a parsing bug)? Prints every raw date tag found.
 *
 *  TEST 3 — Can a custom TDL <COLLECTION> with an explicit <FETCH> list pull
 *           PER-ITEM cost fields (ClosingRate, ClosingValue, StandardCost)
 *           from the STOCKITEM collection? tallybackend's current
 *           parseStockItems() only gets GROUP-level rollups via the "Stock
 *           Summary" report — this tests whether a proper item-level export
 *           is actually possible (needed for real gross-margin/ABC-by-value).
 *
 *  TEST 4 — Does this company have Tally Budgets configured at all? Tries a
 *           few likely REPORTNAME variants for the Budget Variance report.
 *
 * Run on the VM:  node debug_investigation.js
 * Safe to run any time — this only EXPORTS data, never writes to Tally or Postgres.
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { isoToTally, subtractDays, todayIso, dbDateToIso } = require('./utils/helpers');

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
      <SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY>
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
      if (countTag(wideRaw, 'VOUCHER') === 0) {
        console.log('  First 1500 chars of WIDE response (to see if it is an error/empty envelope):');
        console.log('  ' + wideRaw.slice(0, 1500).replace(/\n/g, '\n  '));
      }

      const narrowFrom = subtractDays(today, 60);
      console.log(`\nNARROW request: ${narrowFrom} → ${today} (last 60 days)`);
      const t1 = Date.now();
      const narrowRaw = await tallyClient.request(buildDayBookXml(active.tallyName, isoToTally(narrowFrom), isoToTally(today)));
      console.log(`  → ${narrowRaw.length} bytes in ${Date.now() - t1}ms | <VOUCHER> tags: ${countTag(narrowRaw, 'VOUCHER')} | <TALLYMESSAGE> tags: ${countTag(narrowRaw, 'TALLYMESSAGE')}`);

      console.log('\nVERDICT: if WIDE found ~0 vouchers but NARROW found hundreds, Tally is capping/limiting very wide Day Book exports for this company.');
    });
  } else {
    console.log('\n(No active/non-historical company configured — skipping TEST 1)');
  }

  // ── TEST 2 — raw DATE tags for the HISTORICAL company ────────────────────
  if (historical) {
    await safely('TEST 2', async () => {
      section(`TEST 2 — Historical company "${historical.name}": raw <DATE> tag values`);

      const fromDate = dbDateToIso(historical.fiscalYearFrom) || historical.fiscalYearFrom;
      const toDate = endOfFiscalYear(fromDate);
      console.log(`\nRequest: ${fromDate} → ${toDate} (fiscal year bounds)`);
      const raw = await tallyClient.request(buildDayBookXml(historical.tallyName, isoToTally(fromDate), isoToTally(toDate)));
      console.log(`  → ${raw.length} bytes | <VOUCHER> tags: ${countTag(raw, 'VOUCHER')}`);

      const dates = [...raw.matchAll(/<DATE>([^<]*)<\/DATE>/g)].map((m) => m[1]);
      const distinct = [...new Set(dates)];
      console.log(`\nTotal <DATE> tags found: ${dates.length}`);
      console.log(`Distinct date values: ${distinct.length}`);
      console.log(`All distinct values: ${distinct.join(', ')}`);
      console.log(`First 15 raw (in document order): ${dates.slice(0, 15).join(', ')}`);

      // Also check VOUCHERNUMBER alongside DATE to see if different vouchers really share one date
      const pairs = [...raw.matchAll(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>[\s\S]{0,400}?<DATE>([^<]*)<\/DATE>/g)]
        .slice(0, 10)
        .map((m) => `${m[1]} → ${m[2]}`);
      console.log('\nFirst 10 (VOUCHERNUMBER → DATE) pairs found near each other in the raw XML:');
      pairs.forEach((p) => console.log('  ' + p));

      console.log('\nVERDICT: if distinct date values > 1, the parser is losing real dates (parsing bug — fixable).');
      console.log('         if distinct date values === 1, Tally itself reports this closed company\'s entries under one date (needs a different sync strategy, not a parser fix).');
    });
  } else {
    console.log('\n(No historical company configured — skipping TEST 2)');
  }

  // ── TEST 3 — per-item stock cost via custom TDL Collection ───────────────
  await safely('TEST 3', async () => {
    const co = active || historical;
    section(`TEST 3 — Per-item stock cost via custom TDL Collection (company: "${co.name}")`);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>StockItemCostCollection</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${co.tallyName}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
  <TDL>
    <TDLMESSAGE>
      <COLLECTION NAME="StockItemCostCollection" ISINITIALIZE="Yes">
        <TYPE>StockItem</TYPE>
        <FETCH>Name, ClosingBalance, ClosingValue, ClosingRate, StandardCost, CostingMethod, BaseUnits</FETCH>
      </COLLECTION>
    </TDLMESSAGE>
  </TDL>
</ENVELOPE>`;

    const raw = await tallyClient.request(xml);
    console.log(`\nResponse: ${raw.length} bytes | <STOCKITEM> tags: ${countTag(raw, 'STOCKITEM')}`);
    console.log('\nAll unique tags in response:');
    const tags = new Set([...raw.matchAll(/<([A-Z][A-Z0-9_.]*)[>\s/]/g)].map((m) => m[1]));
    console.log('  ' + [...tags].sort().join(', '));
    console.log('\nFirst 2500 chars:');
    console.log(raw.slice(0, 2500));

    console.log('\nVERDICT: if <STOCKITEM> tags > 0 with real item names + ClosingRate/StandardCost values, this custom-collection approach works and can replace the group-level Stock Summary fallback.');
  });

  // ── TEST 4 — does this company have Tally Budgets configured? ────────────
  await safely('TEST 4', async () => {
    const co = active || historical;
    section(`TEST 4 — Budget data (company: "${co.name}")`);

    const today = todayIso();
    const fromDate = dbDateToIso(co.fiscalYearFrom) || co.fiscalYearFrom;
    const toDate = co.isHistorical ? endOfFiscalYear(fromDate) : today;

    const candidates = ['Group Budget Variances', 'Budget Variance', 'Group Budget Variance'];
    for (const reportName of candidates) {
      console.log(`\nTrying REPORTNAME="${reportName}" (${fromDate} → ${toDate})...`);
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>${reportName}</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${co.tallyName}</SVCURRENTCOMPANY>
      <SVFROMDATE>${isoToTally(fromDate)}</SVFROMDATE>
      <SVTODATE>${isoToTally(toDate)}</SVTODATE>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
      try {
        const raw = await tallyClient.request(xml);
        const hasLine = /<LINEERROR>|Unknown Report|does not exist/i.test(raw);
        console.log(`  → ${raw.length} bytes${hasLine ? '  [Tally reports an error / unknown report]' : ''}`);
        if (!hasLine && raw.length > 200) {
          console.log('  First 1000 chars:');
          console.log('  ' + raw.slice(0, 1000).replace(/\n/g, '\n  '));
        }
      } catch (err) {
        console.log(`  → request failed: ${err.message}`);
      }
    }
    console.log('\nVERDICT: a real, non-error response with BDMAINAMT/similar budget-amount tags means budgets ARE configured and syncable. An error/empty response for all 3 names means no budgets are set up in Tally — nothing to sync.');
  });

  section('DONE — copy this whole output back to Claude for analysis.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
