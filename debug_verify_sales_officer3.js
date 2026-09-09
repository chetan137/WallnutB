'use strict';
/**
 * debug_verify_sales_officer3.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this ONLY while Tally currently has "Wallnut 25-26" connected/focused —
 * only one company is reachable at a time, and the target vouchers below
 * belong to this company specifically.
 *
 * sales_officer is STILL showing 0% populated in the DB even for real Sales
 * vouchers synced by the latest code (confirmed via hsn_code being present
 * on the same rows, which only the newest deploy can write). This script
 * dumps the FULL raw XML for a few real, recent Sales vouchers using the
 * EXACT same production fetch shape (bare ALLLEDGERENTRIES.LIST) to see
 * whether Cost Centre data genuinely exists in Tally for them at all, and
 * if so, in what exact shape — the earlier fix only covers two known
 * shapes (direct on ledger entry, or nested one level inside
 * INVENTORYALLOCATIONS.LIST).
 *
 * Run: node debug_verify_sales_officer3.js
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { escapeXml, isoToTallyLiteral } = require('./utils/helpers');

const co = config.companies.find((c) => !c.isHistorical) || config.companies[0];

// Real, recent Sales vouchers confirmed in the DB with sales_officer = '' —
// all synced by the latest (HSN-capable) code, so this checks the CURRENT
// production fetch shape against real Tally data.
const TARGET_VOUCHER_NUMBERS = ['WBSIMK-353/26-27', 'WBSIMK-350/26-27', 'WBSIGJ-090/26-27'];

async function main() {
  console.log(`Company: ${co.name} (Tally: "${co.tallyName}")`);

  const voucherClause = TARGET_VOUCHER_NUMBERS.map((vn) => `$VoucherNumber = "${vn}"`).join(' OR ');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>SalesOfficerTest3</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="SalesOfficerTest3" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FILTER>SalesOfficerTest3Filter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME</FETCH>
            <FETCH>ALLLEDGERENTRIES.LIST</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
        <TDLMESSAGE>
          <SYSTEM TYPE="Formula" NAME="SalesOfficerTest3Filter">${voucherClause}</SYSTEM>
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
  console.log('\nPaste this ENTIRE output back.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
