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
 * v3 — only one Tally company is ever connected at a time, and right now
 * that's "Wallnut 24-25" (not the company the original screenshots came
 * from), so this no longer targets specific voucher numbers from a
 * different company. Instead it samples a small REAL window inside 24-25's
 * own confirmed date range (Mar 2025 — real invoices confirmed to exist
 * there earlier this session, e.g. ESS JAY EMPORIUM bills dated Jan-Mar
 * 2025) and inspects whatever it gets back, same technique as
 * debug_godown_test.js used for GODOWNNAME.
 *
 * v2 bugs (fixed here too): raw.indexOf('<VOUCHER') also matches
 * <VOUCHERTYPE>/<VOUCHERNUMBERSERIES> etc. earlier in the response, so
 * slicing "the voucher block" that way grabs the wrong chunk — this prints
 * the complete raw response instead, no slicing.
 *
 * Run: node debug_cost_centre_test.js
 * (Loops every configured company — whichever one Tally doesn't currently
 * have connected will just get 0 real vouchers back, which is expected and
 * fine; only the currently-connected company's attempt matters right now.)
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');
const { escapeXml } = require('./utils/helpers');

// A window confirmed to have real vouchers in "Wallnut 24-25" specifically
// (its actual data range is 2024-04-01 to 2025-03-31) — near the FY end,
// where bills_receivable showed real Jan-Mar 2025 invoices for real parties.
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
            <FILTER>CostCentreDateFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME</FETCH>
            <FETCH>ALLLEDGERENTRIES.LIST</FETCH>
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
    return false;
  }

  const costCentreMatches = [...raw.matchAll(/<COSTCENTREALLOCATIONS\.LIST>[\s\S]*?<\/COSTCENTREALLOCATIONS\.LIST>/g)];
  const categoryMatches   = [...raw.matchAll(/<CATEGORYALLOCATIONS\.LIST>[\s\S]*?<\/CATEGORYALLOCATIONS\.LIST>/g)];
  console.log(`COSTCENTREALLOCATIONS.LIST blocks: ${costCentreMatches.length} | CATEGORYALLOCATIONS.LIST blocks: ${categoryMatches.length}`);

  if (costCentreMatches.length === 0 && categoryMatches.length === 0) {
    console.log('Neither tag found in this response — no cost centre data came back for this window.');
    return true;
  }

  console.log('\n--- COSTCENTREALLOCATIONS.LIST blocks ---');
  costCentreMatches.forEach((m, i) => console.log(`[${i}] ${m[0].replace(/\s+/g, ' ').trim()}`));
  console.log('\n--- CATEGORYALLOCATIONS.LIST blocks ---');
  categoryMatches.forEach((m, i) => console.log(`[${i}] ${m[0].replace(/\s+/g, ' ').trim()}`));

  return true;
}

async function main() {
  for (const co of config.companies) {
    await tryCompany(co).catch((err) => {
      console.error(`  ERROR for ${co.name}: ${err.message}`);
    });
  }
  console.log('\n─────────────────────────────────────────');
  console.log('Paste this ENTIRE output back. Whichever company is currently connected in');
  console.log('Tally should show real <VOUCHER> tags > 0 with real dates/party names — that');
  console.log('one\'s COSTCENTREALLOCATIONS/CATEGORYALLOCATIONS result (or lack of one) is');
  console.log('what tells us whether Cost Centre is reachable this way.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
