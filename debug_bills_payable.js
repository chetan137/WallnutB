'use strict';
/**
 * debug_bills_payable.js
 * Inspect exact XML structure of Tally's "Bills Payable" report.
 * Run: node debug_bills_payable.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');

function buildXml(company) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Bills Payable</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

async function main() {
  for (const co of config.companies) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Company: ${co.tallyName}`);
    const raw = await tallyClient.request(buildXml(co.tallyName));
    console.log(`Size: ${raw.length} bytes\n`);

    // Show first 5000 chars to understand structure
    console.log('--- First 5000 chars ---');
    console.log(raw.slice(0, 5000));

    // Find ALL unique tag names used
    const tagMatches = [...raw.matchAll(/<([A-Z][A-Z0-9_.]*)[>\s/]/g)];
    const uniqueTags = [...new Set(tagMatches.map(m => m[1]))];
    console.log(`\n--- Unique tags (${uniqueTags.length}) ---`);
    console.log(uniqueTags.join(', '));

    // Show one complete vendor block (find first BILLPARTY..next BILLPARTY)
    const firstParty = raw.indexOf('<BILLPARTY>');
    if (firstParty !== -1) {
      const secondParty = raw.indexOf('<BILLPARTY>', firstParty + 1);
      const end = secondParty !== -1 ? secondParty : firstParty + 2000;
      console.log('\n--- First vendor block ---');
      console.log(raw.slice(firstParty - 200, end));
    }

    // Count records
    const partyCount = (raw.match(/<BILLPARTY>/g) || []).length;
    const billCount  = (raw.match(/<BILLREF>/g)   || []).length;
    console.log(`\nTotal BILLPARTY entries: ${partyCount}`);
    console.log(`Total BILLREF entries:   ${billCount}`);
  }
}

main().catch(console.error);
