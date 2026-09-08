'use strict';
/**
 * debug_verify_sales_officer2.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Follow-up to debug_verify_sales_officer.js (deleted after the honorific-
 * prefix bug was fixed in commit 5360078). That fix was verified offline
 * against a hand-typed synthetic XML snippet reproducing the confirmed real
 * shape — but a FRESH live production sync (43 vouchers, 2026-09-05 to
 * 2026-09-08, run with the fixed + pm2-reloaded code) STILL shows 0/43 with
 * a populated sales_officer, even though the raw XML for this exact company/
 * window was independently confirmed (before the fix) to contain 58 real
 * COSTCENTREALLOCATIONS.LIST blocks.
 *
 * This runs the CURRENT parseVouchers against the SAME real window one more
 * time, end to end, and if it still finds nothing, dumps the FULL raw XML
 * for the first voucher that has a COSTCENTREALLOCATIONS.LIST block (not a
 * 200-char snippet) so the exact structure can be inspected byte for byte —
 * something in the full path (fetch, XML parsing, or the extraction
 * function) still doesn't match what's actually happening.
 *
 * Run: node debug_verify_sales_officer2.js
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const parsers     = require('./tally/parsers');
const config      = require('./config');
const { todayIso, subtractDays } = require('./utils/helpers');

const co = config.companies.find((c) => !c.isHistorical) || config.companies[0];

async function main() {
  console.log(`=== Company: ${co.name} (Tally: "${co.tallyName}") ===`);

  const toDate = todayIso();
  const fromDate = subtractDays(toDate, 7);
  console.log(`Window: ${fromDate} -> ${toDate}`);

  const xml = templates.buildAllVouchersRequest(co.tallyName, fromDate, toDate);
  const raw = await tallyClient.request(xml);
  console.log(`-> ${raw.length} bytes`);

  const costCentreMatches = [...raw.matchAll(/<COSTCENTREALLOCATIONS\.LIST>[\s\S]*?<\/COSTCENTREALLOCATIONS\.LIST>/g)];
  console.log(`Raw XML contains ${costCentreMatches.length} <COSTCENTREALLOCATIONS.LIST> block(s)`);

  const parsed = tallyClient.parseXml(raw);
  const records = parsers.parseVouchers(parsed, co.id || 0);
  const withOfficer = records.filter((r) => r.inventoryEntries.some((ie) => ie.salesOfficer));
  console.log(`parseVouchers() returned ${records.length} vouchers, ${withOfficer.length} with a non-empty salesOfficer`);

  if (withOfficer.length > 0) {
    console.log('SUCCESS. Sample:', JSON.stringify({
      vchNo: withOfficer[0].vchNo,
      salesOfficer: withOfficer[0].inventoryEntries.find((ie) => ie.salesOfficer)?.salesOfficer,
    }));
    return;
  }

  console.log('\nSTILL 0 MATCHES — dumping full raw XML for the first voucher containing a real cost centre block.');

  if (costCentreMatches.length === 0) {
    console.log('(No cost centre blocks in THIS run\'s raw XML at all — different from the earlier check, worth noting.)');
    return;
  }

  // Find which <VOUCHER>...</VOUCHER> block contains the first cost-centre match.
  const firstMatchIdx = costCentreMatches[0].index;
  const voucherStarts = [...raw.matchAll(/<VOUCHER[ >]/g)].map((m) => m.index);
  let containingStart = voucherStarts[0];
  for (const idx of voucherStarts) {
    if (idx <= firstMatchIdx) containingStart = idx;
    else break;
  }
  const voucherEnd = raw.indexOf('</VOUCHER>', firstMatchIdx) + '</VOUCHER>'.length;
  console.log('\n--- FULL raw <VOUCHER> block containing the cost centre data ---');
  console.log(raw.slice(containingStart, voucherEnd));
  console.log('--- end voucher block ---');

  // Also show exactly what parseVouchers extracted for THIS specific voucher.
  const vchNoMatch = raw.slice(containingStart, voucherEnd).match(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/);
  const targetVchNo = vchNoMatch ? vchNoMatch[1] : null;
  const parsedRecord = records.find((r) => r.vchNo === targetVchNo);
  console.log(`\nparseVouchers() result for voucher "${targetVchNo}":`);
  console.log(JSON.stringify(parsedRecord, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
