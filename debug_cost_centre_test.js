'use strict';
/**
 * debug_cost_centre_test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Real Tally printouts show a "Cost Centre/Classes" field per voucher (e.g.
 * "Mr. Vaibhav Pawar", "Mr. Nikhil") — this looks like exactly the Sales
 * Officer/Manager data previously confirmed unavailable (narration parsing
 * only ever matched the old demo format; real narrations are free text with
 * nothing structured in them). Cost Centre is a SEPARATE Tally mechanism
 * (per-ledger-entry cost allocation), not narration — worth checking on its
 * own via the ad-hoc TDL Collection technique already proven for vouchers.
 *
 * Deliberately targets the two exact vouchers shown in the screenshots
 * (WBSIMK-602/25-26, dated 2-Mar-26; WBSIMK-607/25-26, dated 4-Mar-26) with
 * BOTH a date-literal filter AND a voucher-number filter, so the request
 * stays tiny regardless of how many vouchers this company's Tally period
 * currently exposes — safe against the memory-crash risk BUG FIX 3 in
 * xmlTemplates.js documents for large unbounded fetches.
 *
 * Fetches the BARE ALLLEDGERENTRIES.LIST (Tally's full native schema) rather
 * than a guessed dot-path — for just 1-2 vouchers the bloat is trivial, and
 * this shows the TRUE nesting Tally uses here instead of guessing between
 * the two common shapes (COSTCENTREALLOCATIONS.LIST directly under a ledger
 * entry, vs nested one level deeper inside CATEGORYALLOCATIONS.LIST).
 *
 * Run: node debug_cost_centre_test.js
 * (Tries every configured company — Tally must have whichever company/period
 * covers March 2026 currently open/focused for that company's attempt to
 * find anything; if neither currently exposes that period, expect 0 matches
 * for both, which itself would be useful confirmation of the known FY25-26
 * sync gap rather than a new problem.)
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { escapeXml } = require('./utils/helpers');

const TARGET_VOUCHER_NUMBERS = ['WBSIMK-602/25-26', 'WBSIMK-607/25-26'];
const WINDOW_FROM = '1-Mar-2026';
const WINDOW_TO   = '5-Mar-2026';

async function tryCompany(co) {
  console.log(`\n=== Trying company: ${co.name} (Tally: "${co.tallyName}") ===`);

  const voucherClause = TARGET_VOUCHER_NUMBERS.map((vn) => `$VoucherNumber = "${vn}"`).join(' OR ');
  const filterFormula = `($Date &gt;= $$Date:'${WINDOW_FROM}' AND $Date &lt;= $$Date:'${WINDOW_TO}') AND (${voucherClause})`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CostCentreTest</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CostCentreTest" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FILTER>CostCentreVoucherFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME</FETCH>
            <FETCH>ALLLEDGERENTRIES.LIST</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
        <TDLMESSAGE>
          <SYSTEM TYPE="Formula" NAME="CostCentreVoucherFilter">${filterFormula}</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

  const t0 = Date.now();
  const raw = await tallyClient.request(xml);
  console.log(`→ ${raw.length} bytes in ${Date.now() - t0}ms`);

  const voucherCount = (raw.match(/<VOUCHER[ >]/g) || []).length;
  console.log(`<VOUCHER> tags found: ${voucherCount}`);

  if (voucherCount === 0) {
    console.log('No matching vouchers in this company — first 1200 chars of response:');
    console.log(raw.slice(0, 1200));
    return false;
  }

  const vIdx = raw.indexOf('<VOUCHER');
  const vEnd = raw.indexOf('</VOUCHER>', vIdx) + '</VOUCHER>'.length;
  console.log('\n--- Full <VOUCHER> block (first match) ---');
  console.log(raw.slice(vIdx, vEnd));

  const costCentreMatches = [...raw.matchAll(/<COSTCENTREALLOCATIONS\.LIST>[\s\S]*?<\/COSTCENTREALLOCATIONS\.LIST>/g)];
  console.log(`\nCOSTCENTREALLOCATIONS.LIST blocks found: ${costCentreMatches.length}`);
  costCentreMatches.forEach((m, i) => console.log(`  [${i}] ${m[0].replace(/\s+/g, ' ').trim()}`));

  const categoryMatches = [...raw.matchAll(/<CATEGORYALLOCATIONS\.LIST>[\s\S]*?<\/CATEGORYALLOCATIONS\.LIST>/g)];
  console.log(`\nCATEGORYALLOCATIONS.LIST blocks found: ${categoryMatches.length}`);
  categoryMatches.forEach((m, i) => console.log(`  [${i}] ${m[0].replace(/\s+/g, ' ').trim()}`));

  return true;
}

async function main() {
  let foundAny = false;
  for (const co of config.companies) {
    const found = await tryCompany(co).catch((err) => {
      console.error(`  ERROR for ${co.name}: ${err.message}`);
      return false;
    });
    foundAny = foundAny || found;
  }

  console.log('\n─────────────────────────────────────────');
  if (!foundAny) {
    console.log('VERDICT: 0 matches in every company. Either neither company currently has');
    console.log('         March 2026 reachable in its Tally-focused period (consistent with the');
    console.log('         known FY25-26 sync gap), or the exact vch_no/date differ from the');
    console.log('         screenshot slightly. Try widening WINDOW_FROM/WINDOW_TO in this file.');
  } else {
    console.log('VERDICT: look at the printed <VOUCHER> block above. If you see a tag like');
    console.log('         <COSTCENTREALLOCATIONS.LIST><NAME>Mr. Nikhil</NAME>...</COSTCENTREALLOCATIONS.LIST>');
    console.log('         (either directly under a ledger entry, or nested inside a');
    console.log('         CATEGORYALLOCATIONS.LIST), that confirms the real field path to use');
    console.log('         for Sales Officer/Manager — paste this whole output back.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
