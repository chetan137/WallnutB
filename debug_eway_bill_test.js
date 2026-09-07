'use strict';
/**
 * debug_eway_bill_test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE-SHOT investigation for a brand-new data source: e-Way Bill compliance
 * data (GST Reports > Exchange Reports > e-Way Bill in Tally's menu). Never
 * touched in this codebase before — this is the only round-trip needed
 * before writing the real sync module, same rigor as the cost-centre work.
 *
 * Targets 3 REAL, already-synced vouchers confirmed to have e-Way Bill data
 * generated (from the screenshots, 5-Sep-2026): WBSIGJ-088/26-27 (Atul Ltd,
 * Rs1,72,397), WBSIGJ-089/26-27 (Heer Enterprise, Rs1,99,767),
 * WBSIMK-348/26-27 (NIRMAN CERAMIC, Rs1,70,740) — all 3 already exist in the
 * `vouchers` table for company 2. Filtering to exactly these 3 keeps the
 * request tiny regardless of field bloat.
 *
 * Tries a broad set of guessed field/list names in one FETCH (Tally quietly
 * omits whatever doesn't exist rather than erroring) — safer than multiple
 * separate round-trips of guesses. Prints the COMPLETE raw response for
 * inspection since 3 vouchers is trivially small either way.
 *
 * Run: node debug_eway_bill_test.js
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { escapeXml } = require('./utils/helpers');

const TARGET_VOUCHER_NUMBERS = ['WBSIGJ-088/26-27', 'WBSIGJ-089/26-27', 'WBSIMK-348/26-27'];

// Broad guess list — scalar fields AND compound lists, mixing plausible
// Tally-native e-way-bill/e-invoice field names. Unknown ones are just
// silently ignored by Tally rather than causing an error.
const GUESS_FIELDS = [
  'EWAYBILLNO', 'EWAYBILLDATE', 'EWAYBILLVALIDUPTO', 'EWAYBILLDISTANCE',
  'IRN', 'IRNDATE', 'ACKNO', 'ACKDATE',
  'PARTYGSTIN', 'CONSIGNEEGSTIN', 'VOUCHERGSTREGISTRATIONNUMBER',
  'EWAYBILLDETAILS.LIST', 'GSTDETAILS.LIST', 'STATUTORYDETAILS.LIST',
  'IRNDETAILS.LIST', 'EINVOICEDETAILS.LIST', 'GSTEWAYBILLDETAILS.LIST',
];

async function tryCompany(co) {
  console.log(`\n=== Company: ${co.name} (Tally: "${co.tallyName}") ===`);

  const voucherClause = TARGET_VOUCHER_NUMBERS.map((vn) => `$VoucherNumber = "${vn}"`).join(' OR ');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>EwayBillTest</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="EwayBillTest" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FILTER>EwayBillVoucherFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME</FETCH>
            <FETCH>${GUESS_FIELDS.join(', ')}</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
        <TDLMESSAGE>
          <SYSTEM TYPE="Formula" NAME="EwayBillVoucherFilter">${voucherClause}</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

  const t0 = Date.now();
  const raw = await tallyClient.request(xml);
  const voucherCount = (raw.match(/<VOUCHER[ >]/g) || []).length;
  console.log(`→ ${raw.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${voucherCount}`);
  console.log('--- FULL raw response ---');
  console.log(raw);
  console.log('--- end raw response ---');

  return voucherCount > 0;
}

async function tryReportNameVariant(co, reportName) {
  console.log(`\n=== Company: ${co.name} | REPORTNAME="${reportName}" ===`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${escapeXml(reportName)}</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
          <SVFROMDATE>20260905</SVFROMDATE>
          <SVTODATE>20260905</SVTODATE>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
  try {
    const t0 = Date.now();
    const raw = await tallyClient.request(xml);
    console.log(`→ ${raw.length} bytes in ${Date.now() - t0}ms`);
    console.log(raw.slice(0, 3000));
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
  }
}

async function main() {
  for (const co of config.companies) {
    await tryCompany(co).catch((err) => {
      console.error(`  ERROR for ${co.name}: ${err.message}`);
    });
  }

  console.log('\n─────────────────────────────────────────');
  console.log('Also trying REPORTNAME-based export (Tally\'s native "Voucher Register" /');
  console.log('e-Way Bill report may be exposed this way instead) — for company 2 / 5-Sep-2026 only.');
  const co2 = config.companies.find((c) => !c.isHistorical) || config.companies[0];
  for (const reportName of ['e-Way Bill', 'Voucher Register', 'e-Way Bill Register', 'GST e-Way Bill']) {
    await tryReportNameVariant(co2, reportName);
  }

  console.log('\n─────────────────────────────────────────');
  console.log('Paste this ENTIRE output back. Look for any tag/value matching real e-way');
  console.log('bill numbers/dates from the screenshots for these 3 vouchers.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
