'use strict';
/**
 * debug_safe_2425.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal, SAFE-ONLY diagnostic — does NOT run anything that has crashed
 * Tally before (no ledger/inventory compound-field fetches, no unfiltered
 * full-history pulls). Only exercises the historical company ("24-25").
 *
 * Run: node debug_safe_2425.js
 * Read-only — only EXPORTs from Tally, never writes, never touches Postgres.
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const parsers     = require('./tally/parsers');
const config      = require('./config');
const { isoToTally, todayIso, dbDateToIso, escapeXml } = require('./utils/helpers');

function endOfFiscalYear(fromDate) {
  const d = new Date(fromDate);
  const endYear = d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();
  return `${endYear}-03-31`;
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

function buildScalarVoucherXml(companyName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>SafeVoucherCount</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="SafeVoucherCount" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

function buildFilteredVoucherXml(companyName, fromIso, toIso) {
  const from = isoToTally(fromIso);
  const to   = isoToTally(toIso);
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>FilteredVoucherCount</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        <SVFROMDATE>${from}</SVFROMDATE>
        <SVTODATE>${to}</SVTODATE>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="FilteredVoucherCount" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FILTER>WallnutDateFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
        <TDLMESSAGE>
          <SYSTEM TYPE="Formula" NAME="WallnutDateFilter">$Date &gt;= ##SVFROMDATE AND $Date &lt;= ##SVTODATE</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

async function main() {
  console.log('⚠️  Reminder: tallybackend\'s own process (pm2 tally-sync / node index.js)');
  console.log('   should be STOPPED right now, and Tally should have "Wallnut Building');
  console.log('   Solutions India Pvt Ltd-2024-25" as the current/focused company.\n');

  const historical = config.companies.find((c) => c.isHistorical);
  if (!historical) {
    console.log('No historical company (24-25) configured — nothing to test.');
    return;
  }
  console.log(`Company: ${historical.name} (Tally: "${historical.tallyName}")`);

  // ── STEP A — safe scalar-only count, whole history, no filter ───────────
  await safely('STEP A', async () => {
    section('STEP A — Safe scalar-only voucher count (no ledger/inventory, no filter)');
    const t0 = Date.now();
    const raw = await tallyClient.request(buildScalarVoucherXml(historical.tallyName));
    const count = countTag(raw, 'VOUCHER');
    console.log(`  → ${raw.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${count}`);
    if (count < 5) {
      console.log('  First 600 chars:');
      console.log('  ' + raw.slice(0, 600).replace(/\n/g, '\n  '));
    }
    console.log('\nVERDICT: this is the real total voucher count for 24-25 — safe, no ledger/inventory involved.');
  });

  // ── STEP B — does an explicit FILTER formula actually narrow the count? ──
  await safely('STEP B', async () => {
    section('STEP B — Does an explicit FILTER formula narrow the count by date?');

    const fromDate = dbDateToIso(historical.fiscalYearFrom) || historical.fiscalYearFrom;
    const narrowTo  = `${fromDate.slice(0, 8)}07`; // first week of the fiscal year month
    const wideTo    = endOfFiscalYear(fromDate);

    console.log(`\nNARROW window: ${fromDate} → ${narrowTo} (first week)`);
    const t0 = Date.now();
    const rawNarrow = await tallyClient.request(buildFilteredVoucherXml(historical.tallyName, fromDate, narrowTo));
    const narrowCount = countTag(rawNarrow, 'VOUCHER');
    console.log(`  → ${rawNarrow.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${narrowCount}`);
    if (narrowCount < 5) {
      console.log('  First 600 chars:');
      console.log('  ' + rawNarrow.slice(0, 600).replace(/\n/g, '\n  '));
    }

    console.log(`\nWIDE window: ${fromDate} → ${wideTo} (full fiscal year)`);
    const t1 = Date.now();
    const rawWide = await tallyClient.request(buildFilteredVoucherXml(historical.tallyName, fromDate, wideTo));
    const wideCount = countTag(rawWide, 'VOUCHER');
    console.log(`  → ${rawWide.length} bytes in ${Date.now() - t1}ms | <VOUCHER> tags: ${wideCount}`);

    console.log(`\nVERDICT: narrow=${narrowCount} vs wide=${wideCount}.`);
    console.log('         If narrow < wide, the FILTER genuinely scopes by date — voucher sync can be');
    console.log('         chunked into small date ranges (e.g. month by month) so no single request is');
    console.log('         ever big enough to crash Tally again.');
  });

  // ── STEP C — does the FILTER mechanism work AT ALL (blunt always-false),
  // and does filtering by VOUCHER TYPE (a simple string comparison) work
  // where a date comparison formula apparently didn't? Both scalar-only —
  // safe regardless of the outcome.
  await safely('STEP C', async () => {
    section('STEP C — Is <FILTER> honored at all? (always-false, then VoucherTypeName)');

    const alwaysFalseXml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>NoneCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(historical.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="NoneCollection" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FILTER>AlwaysFalse</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
        <TDLMESSAGE>
          <SYSTEM TYPE="Formula" NAME="AlwaysFalse">0</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    console.log('\nAlways-false filter (formula literal 0) — expect 0 vouchers if FILTER is honored at all:');
    const t0 = Date.now();
    const rawFalse = await tallyClient.request(alwaysFalseXml);
    const falseCount = countTag(rawFalse, 'VOUCHER');
    console.log(`  → ${rawFalse.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${falseCount}`);

    const typeFilterXml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>TypeCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(historical.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="TypeCollection" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FILTER>OnlyJournal</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
        <TDLMESSAGE>
          <SYSTEM TYPE="Formula" NAME="OnlyJournal">$VoucherTypeName = "Journal"</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    console.log('\nVoucherTypeName = "Journal" filter — expect a SUBSET of the 10,689 total if this dimension works:');
    const t1 = Date.now();
    const rawType = await tallyClient.request(typeFilterXml);
    const typeCount = countTag(rawType, 'VOUCHER');
    console.log(`  → ${rawType.length} bytes in ${Date.now() - t1}ms | <VOUCHER> tags: ${typeCount}`);

    console.log(`\nVERDICT: always-false=${falseCount} (want 0), Journal-only=${typeCount} (want < 10689).`);
    console.log('         If always-false stays 10689, <FILTER> is not being honored at all for this');
    console.log('         collection type in this Tally version — need a different chunking dimension');
    console.log('         entirely (not TDL FILTER-based).');
  });

  // ── STEP D — STEP C proved <FILTER> genuinely works (string equality on
  // $VoucherTypeName narrowed 10,689 → 809). So the date FILTER in STEP B
  // was fine as a mechanism but wrong as a FORMULA — referencing
  // ##SVFROMDATE/##SVTODATE apparently doesn't resolve inside a Voucher
  // collection's FILTER formula the way it does in a report. This tries a
  // literal Tally date value embedded directly in the formula instead
  // (the same way the literal string "Journal" worked), using Tally's
  // native short-date format (D-Mon-YYYY).
  await safely('STEP D', async () => {
    section('STEP D — Literal date value in the FILTER formula (no ##SV reference)');

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function toTallyLiteralDate(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      return `${d}-${MONTHS[m - 1]}-${y}`;
    }

    const fromDate  = dbDateToIso(historical.fiscalYearFrom) || historical.fiscalYearFrom;
    const narrowTo  = `${fromDate.slice(0, 8)}07`;
    const fromLit   = toTallyLiteralDate(fromDate);
    const toLit     = toTallyLiteralDate(narrowTo);

    function buildLiteralDateFilterXml(companyName, fromLiteral, toLiteral) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>LiteralDateCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="LiteralDateCollection" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FILTER>LiteralDateFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
        <TDLMESSAGE>
          <SYSTEM TYPE="Formula" NAME="LiteralDateFilter">$Date &gt;= $$Date:'${fromLiteral}' AND $Date &lt;= $$Date:'${toLiteral}'</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    }

    console.log(`\nNARROW window (literal dates): ${fromLit} → ${toLit}`);
    const t0 = Date.now();
    const rawNarrow = await tallyClient.request(buildLiteralDateFilterXml(historical.tallyName, fromLit, toLit));
    const narrowCount = countTag(rawNarrow, 'VOUCHER');
    console.log(`  → ${rawNarrow.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${narrowCount}`);
    if (narrowCount < 5) {
      console.log('  First 700 chars:');
      console.log('  ' + rawNarrow.slice(0, 700).replace(/\n/g, '\n  '));
    }

    console.log(`\nVERDICT: narrow (1 week, literal dates) = ${narrowCount} vs full total = 10689.`);
    console.log('         If this is meaningfully less than 10689 (and > 0), literal date values in the');
    console.log('         formula work — voucher sync can chunk by real calendar date ranges.');
  });

  // ── STEP E — the ACTUAL production request (templates.buildAllVouchersRequest,
  // now date-chunked + literal-date FILTER + trimmed ledger/inventory FETCH),
  // for ONE real month, on the company that has 10,689 total vouchers and
  // has crashed Tally before. This is the final check before trusting pm2's
  // automated cycle with it.
  await safely('STEP E', async () => {
    section(`STEP E — Production buildAllVouchersRequest() for ONE month chunk (company: "${historical.name}")`);

    const fromDate = dbDateToIso(historical.fiscalYearFrom) || historical.fiscalYearFrom;
    const toDate   = `${fromDate.slice(0, 8)}30`; // April has 30 days
    console.log(`\nOne real production month chunk: ${fromDate} → ${toDate}`);

    const t0 = Date.now();
    const xml = templates.buildAllVouchersRequest(historical.tallyName, fromDate, toDate);
    const raw = await tallyClient.request(xml);
    console.log(`  → ${raw.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${countTag(raw, 'VOUCHER')}`);

    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseVouchers(parsed, 1);
    console.log(`  parsed ${records.length} voucher records`);
    if (records.length > 0) {
      const withInv = records.find((r) => r.inventoryEntries.length > 0);
      const sample  = withInv || records[0];
      console.log('  Sample parsed record:');
      console.log('   ', JSON.stringify({
        vchNo: sample.vchNo, date: sample.date, vchType: sample.vchType,
        partyName: sample.partyName, totalAmount: sample.totalAmount,
        ledgerEntries: sample.ledgerEntries.length,
        inventoryEntries: sample.inventoryEntries.map((i) => ({ item: i.itemName, qty: i.quantity, rate: i.rate, amount: i.amount })),
      }, null, 2).replace(/\n/g, '\n    '));
    }

    console.log('\nVERDICT: if this completes quickly with real amounts/items and no crash, one month');
    console.log('         chunks are safe — pm2 can be trusted with the full chunked sync now.');
  });

  section('DONE — copy this whole output back to Claude for analysis.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
