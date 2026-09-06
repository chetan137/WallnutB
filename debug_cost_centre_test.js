'use strict';
/**
 * debug_cost_centre_test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * v4 — CONFIRMED (v3 output): Cost Centre allocations are real and reachable.
 * A window of 20-31 Mar 2025 in "Wallnut 24-25" returned 78 real allocations —
 * <ALLLEDGERENTRIES.LIST><CATEGORYALLOCATIONS.LIST><CATEGORY>Primary Cost
 * Category</CATEGORY><COSTCENTREALLOCATIONS.LIST><NAME>Mr. Kamlesh
 * Dave</NAME><AMOUNT>...</AMOUNT></COSTCENTREALLOCATIONS.LIST>
 * </CATEGORYALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST> — real names: Mr.
 * Kamlesh Dave, Mr. Hemant Jain, Mr. Vaibhav Pawar (plus non-salesperson
 * entries like "Account" and "Branch Transfer - Sales" that aren't real
 * officers and would need filtering out later).
 *
 * BUT that test fetched the BARE ALLLEDGERENTRIES.LIST (Tally's entire
 * native schema per entry, same bloat BUG FIX 4 in xmlTemplates.js already
 * fixed once) — 9.8 MB for just 540 vouchers / 11 days. Unusable across a
 * whole company's voucher history in production.
 *
 * This tests whether the TRIMMED 3-level dot-path — ALLLEDGERENTRIES.
 * CATEGORYALLOCATIONS.CATEGORY and ALLLEDGERENTRIES.CATEGORYALLOCATIONS.
 * COSTCENTREALLOCATIONS.NAME — still returns the real cost-centre names
 * without the bloat. Established so far: 1-level dot-notation
 * (ALLLEDGERENTRIES.AMOUNT etc.) works reliably; this is 2-3 levels deep,
 * unverified until now.
 *
 * Run: node debug_cost_centre_test.js
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { escapeXml } = require('./utils/helpers');

// Same window as the confirmed-working v3 test, for a direct before/after
// byte-size and content comparison.
const WINDOW_FROM = '20-Mar-2025';
const WINDOW_TO   = '31-Mar-2025';

async function tryCompany(co) {
  console.log(`\n=== Company: ${co.name} (Tally: "${co.tallyName}") | window ${WINDOW_FROM} → ${WINDOW_TO} ===`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CostCentreTrimmedTest</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CostCentreTrimmedTest" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FILTER>CostCentreDateFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME</FETCH>
            <FETCH>ALLLEDGERENTRIES.LEDGERNAME, ALLLEDGERENTRIES.AMOUNT</FETCH>
            <FETCH>ALLLEDGERENTRIES.CATEGORYALLOCATIONS.CATEGORY</FETCH>
            <FETCH>ALLLEDGERENTRIES.CATEGORYALLOCATIONS.COSTCENTREALLOCATIONS.NAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
        <TDLMESSAGE>
          <SYSTEM TYPE="Formula" NAME="CostCentreDateFilter">$Date &gt;= $$Date:'${WINDOW_FROM}' AND $Date &lt;= $$Date:'${WINDOW_TO}'</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

  const t0 = Date.now();
  const raw = await tallyClient.request(xml);
  const voucherCount = (raw.match(/<VOUCHER[ >]/g) || []).length;
  console.log(`→ ${raw.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${voucherCount}`);

  if (voucherCount === 0) {
    console.log('0 vouchers — first 800 chars of response:');
    console.log(raw.slice(0, 800));
    return;
  }

  const nameMatches = [...raw.matchAll(/<NAME[^>]*>([^<]*)<\/NAME>/g)].map((m) => m[1]).filter(Boolean);
  const distinctNames = [...new Set(nameMatches)];
  console.log(`<NAME> tags found: ${nameMatches.length} | distinct values: ${distinctNames.join(', ') || '(none)'}`);

  console.log('\nFirst 2500 chars of response (to see the actual trimmed shape):');
  console.log(raw.slice(0, 2500));
}

async function main() {
  for (const co of config.companies) {
    await tryCompany(co).catch((err) => {
      console.error(`  ERROR for ${co.name}: ${err.message}`);
    });
  }
  console.log('\n─────────────────────────────────────────');
  console.log('Compare byte size against v3\'s 9,818,089 bytes for the same window.');
  console.log('If distinct names above include real people (Mr. Kamlesh Dave / Mr. Hemant');
  console.log('Jain / Mr. Vaibhav Pawar) at a MUCH smaller byte size, the trimmed dot-path');
  console.log('works and is safe to wire into the real sync.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
