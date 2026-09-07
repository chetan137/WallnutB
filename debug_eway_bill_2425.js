'use strict';
/**
 * debug_eway_bill_2425.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this ONLY while Tally currently has "Wallnut 24-25" connected/focused —
 * only one company is reachable at a time. See debug_eway_bill_2526.js for
 * the other company (which is where the 3 known e-way-bill vouchers from
 * the screenshots actually live).
 *
 * This company's own e-way-bill data (if any) is unknown, so this just tries
 * the same REPORTNAME variants against whatever this company has for
 * 5-Sep-2026 (won't be much — this company's real data doesn't reach that
 * date at all, per earlier verification — the point here is purely to see
 * whether the REPORTNAME resolves sensibly at all in this installation, not
 * to find a specific voucher).
 *
 * Run: node debug_eway_bill_2425.js
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { escapeXml } = require('./utils/helpers');

const co = config.companies.find((c) => c.isHistorical) || config.companies[0];

async function tryReportNameVariant(reportName) {
  console.log(`\n=== REPORTNAME="${reportName}" | Company: ${co.name} (Tally: "${co.tallyName}") ===`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${escapeXml(reportName)}</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
          <SVFROMDATE>20250301</SVFROMDATE>
          <SVTODATE>20250331</SVTODATE>
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
