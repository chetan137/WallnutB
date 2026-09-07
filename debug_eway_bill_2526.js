'use strict';
/**
 * debug_eway_bill_2526.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this ONLY while Tally currently has "Wallnut 25-26" connected/focused —
 * only one company is reachable at a time, and the 3 target vouchers below
 * belong to this company specifically. See debug_eway_bill_2425.js for the
 * other company.
 *
 * Investigates e-Way Bill compliance data (GST Reports > Exchange Reports >
 * e-Way Bill in Tally's menu) — never touched in this codebase before.
 * Targets 3 REAL, already-synced vouchers confirmed from screenshots to have
 * e-Way Bill data generated (5-Sep-2026): WBSIGJ-088/26-27 (Atul Ltd,
 * Rs1,72,397), WBSIGJ-089/26-27 (Heer Enterprise, Rs1,99,767),
 * WBSIMK-348/26-27 (NIRMAN CERAMIC, Rs1,70,740).
 *
 * Tries a broad set of guessed field/list names in one FETCH (Tally quietly
 * omits whatever doesn't exist) plus several REPORTNAME variants.
 *
 * Run: node debug_eway_bill_2526.js
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { escapeXml } = require('./utils/helpers');

const co = config.companies.find((c) => !c.isHistorical) || config.companies[0];

const TARGET_VOUCHER_NUMBERS = ['WBSIGJ-088/26-27', 'WBSIGJ-089/26-27', 'WBSIMK-348/26-27'];

const GUESS_FIELDS = [
  'EWAYBILLNO', 'EWAYBILLDATE', 'EWAYBILLVALIDUPTO', 'EWAYBILLDISTANCE',
  'IRN', 'IRNDATE', 'ACKNO', 'ACKDATE',
  'PARTYGSTIN', 'CONSIGNEEGSTIN', 'VOUCHERGSTREGISTRATIONNUMBER',
  'EWAYBILLDETAILS.LIST', 'GSTDETAILS.LIST', 'STATUTORYDETAILS.LIST',
  'IRNDETAILS.LIST', 'EINVOICEDETAILS.LIST', 'GSTEWAYBILLDETAILS.LIST',
];

async function tryCollection() {
  console.log(`\n=== Collection test | Company: ${co.name} (Tally: "${co.tallyName}") ===`);

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
  console.log(`→ ${raw.length} bytes in ${Date.now() - t0}ms`);
  console.log('--- FULL raw response ---');
  console.log(raw);
  console.log('--- end raw response ---');
}

async function tryReportNameVariant(reportName) {
  console.log(`\n=== REPORTNAME="${reportName}" | Company: ${co.name} ===`);
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
  await tryCollection().catch((err) => console.error(`  ERROR: ${err.message}`));

  console.log('\n─────────────────────────────────────────');
  console.log('Now trying REPORTNAME-based export for 5-Sep-2026...');
  for (const reportName of ['e-Way Bill', 'Voucher Register', 'e-Way Bill Register', 'GST e-Way Bill']) {
    await tryReportNameVariant(reportName);
  }

  console.log('\n─────────────────────────────────────────');
  console.log('Paste this ENTIRE output back.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
