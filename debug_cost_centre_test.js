'use strict';
/**
 * debug_cost_centre_test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Real Tally voucher printouts show a "Cost Centre/Classes" field per line
 * (e.g. "Mr. Nikhil", "Mr. Vaibhav Pawar") — this looks like exactly the
 * Sales Officer/Manager data previously confirmed unavailable (narration
 * parsing only ever matched the old demo format; real narrations are free
 * text with nothing structured in them). Cost Centre is a separate Tally
 * mechanism (per-ledger-entry cost allocation), worth checking on its own.
 *
 * v2 — simplified after v1's compound date+voucher-number filter produced a
 * confusing 1-record "match" in the WRONG company (Wallnut 24-25, whose real
 * data doesn't reach March 2026 at all) with garbage-looking content. That
 * was two bugs in the debug script itself, not a Tally finding:
 *   1. The printed "voucher block" used raw.indexOf('<VOUCHER') to find the
 *      start — but that substring also matches <VOUCHERTYPE>, <VOUCHERNUMBER-
 *      SERIES> etc. anywhere earlier in the response, so it sliced the wrong
 *      chunk (some unrelated all-zero classification-ID fields).
 *   2. The compound (date range) AND (voucher A OR voucher B) formula may not
 *      have evaluated the way a simple single-clause filter reliably does —
 *      already-proven filters in this codebase (xmlTemplates.js) are always
 *      ONE clause, never a nested AND/OR combination like that.
 *
 * This version drops the date range (single-field FILTER already proven
 * reliable per earlier live testing — see xmlTemplates.js BUG FIX 3), tests
 * ONE voucher number at a time, and always prints the ENTIRE raw response
 * (it's tiny for a single-voucher match) instead of trying to slice out
 * "the voucher block" — no ambiguity about what Tally actually returned.
 *
 * Run: node debug_cost_centre_test.js
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { escapeXml } = require('./utils/helpers');

const TARGET_VOUCHER_NUMBERS = ['WBSIMK-602/25-26', 'WBSIMK-607/25-26'];

async function tryOne(co, voucherNumber) {
  console.log(`\n=== Company: ${co.name} (Tally: "${co.tallyName}") | Voucher: ${voucherNumber} ===`);

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
          <SYSTEM TYPE="Formula" NAME="CostCentreVoucherFilter">$VoucherNumber = "${voucherNumber}"</SYSTEM>
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

async function main() {
  let foundAny = false;
  for (const co of config.companies) {
    for (const vn of TARGET_VOUCHER_NUMBERS) {
      const found = await tryOne(co, vn).catch((err) => {
        console.error(`  ERROR for ${co.name} / ${vn}: ${err.message}`);
        return false;
      });
      foundAny = foundAny || found;
    }
  }

  console.log('\n─────────────────────────────────────────');
  console.log('Paste this ENTIRE output back — look for any tag containing "COSTCENTRE" or');
  console.log('"CATEGORYALLOCATIONS" in whichever attempt actually found a real voucher (real');
  console.log('DATE/PARTYLEDGERNAME/AMOUNT values present, not all-zero placeholder fields).');
  if (!foundAny) {
    console.log('0 matches everywhere — could mean neither company currently has this exact');
    console.log('voucher reachable in whatever period/company Tally has focused right now.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
