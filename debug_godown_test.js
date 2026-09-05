'use strict';
/**
 * debug_godown_test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Safe, narrow-window check: can we fetch each inventory line's Godown
 * (warehouse/location) via the ad-hoc TDL Collection, to use as the real
 * "Area/District" instead of the narration-parsed field (which is always
 * blank for real Tally data — confirmed live, 0/36330 populated).
 *
 * Raw Tally XML shows GODOWNNAME nested inside a per-item
 * BATCHALLOCATIONS.LIST, not directly on the inventory entry — this tests
 * both the direct dot-path and the nested one, since only one level of
 * dot-notation has been proven to work so far (ALLLEDGERENTRIES.AMOUNT etc).
 *
 * Run: node debug_godown_test.js   (whichever company Tally currently has
 * focused — this only reads a handful of days, small and fast either way)
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { isoToTallyLiteral, todayIso, subtractDays, escapeXml } = require('./utils/helpers');

function countTag(raw, tag) {
  const re = new RegExp(`<${tag}[ >]`, 'g');
  return (raw.match(re) || []).length;
}

async function main() {
  const co = config.companies.find((c) => !c.isHistorical) || config.companies[0];
  console.log(`Company: ${co.name} (Tally: "${co.tallyName}")`);

  const toDate   = todayIso();
  const fromDate = subtractDays(toDate, 5);
  const fromLit  = isoToTallyLiteral(fromDate);
  const toLit    = isoToTallyLiteral(toDate);
  console.log(`Window: ${fromDate} → ${toDate}\n`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>GodownTest</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="GodownTest" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FILTER>GodownDateFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME</FETCH>
            <FETCH>ALLINVENTORYENTRIES.STOCKITEMNAME, ALLINVENTORYENTRIES.GODOWNNAME</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BATCHALLOCATIONS.GODOWNNAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
        <TDLMESSAGE>
          <SYSTEM TYPE="Formula" NAME="GodownDateFilter">$Date &gt;= $$Date:'${fromLit}' AND $Date &lt;= $$Date:'${toLit}'</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

  const t0 = Date.now();
  const raw = await tallyClient.request(xml);
  console.log(`→ ${raw.length} bytes in ${Date.now() - t0}ms | <VOUCHER> tags: ${countTag(raw, 'VOUCHER')}`);
  console.log(`<GODOWNNAME> tags found: ${countTag(raw, 'GODOWNNAME')}`);

  const godownMatches = [...raw.matchAll(/<GODOWNNAME[^>]*>([^<]*)<\/GODOWNNAME>/g)].map((m) => m[1]).filter(Boolean);
  const distinctGodowns = [...new Set(godownMatches)];
  console.log(`Non-empty GODOWNNAME values found: ${godownMatches.length}`);
  console.log(`Distinct godowns: ${distinctGodowns.join(', ') || '(none)'}`);

  if (godownMatches.length === 0) {
    console.log('\nFirst 2000 chars (to see the actual response shape):');
    console.log(raw.slice(0, 2000));
  } else {
    // Show one real inventory entry in context so we can see exactly where
    // GODOWNNAME sits relative to STOCKITEMNAME (direct vs nested).
    const idx = raw.indexOf('GODOWNNAME');
    console.log('\nContext around the first real GODOWNNAME (800 chars before/after):');
    console.log(raw.slice(Math.max(0, idx - 800), idx + 200));
  }

  console.log('\nVERDICT: if distinct godowns show real warehouse/location names, we can use');
  console.log('         Godown as the real Area/District field instead of narration parsing.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
