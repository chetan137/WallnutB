'use strict';
/**
 * debug_payables.js
 * Inspect raw XML from Tally's Outstanding Payables report.
 * Run: node debug_payables.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const config      = require('./config');

async function main() {
  for (const co of config.companies) {
    console.log(`\n=== Outstanding Payables: ${co.tallyName} ===`);
    const xml = templates.buildOutstandingPayablesRequest(co.tallyName);
    const raw = await tallyClient.request(xml);
    console.log(`Response: ${raw.length} bytes\n`);
    console.log('--- First 3000 chars ---');
    console.log(raw.slice(0, 3000));

    // Check what tags are present
    const tags = ['LEDGER', 'NAME', 'CLOSINGBALANCE', 'OUTSTANDINGAMOUNT',
                  'BILLDATE', 'BILLNO', 'AMOUNT', 'LEDGERNAME', 'PARTYNAME',
                  'DSPDISPNAME', 'BSMAINAMT', 'PLSUBAMT'];
    console.log('\n--- Tag presence ---');
    for (const t of tags) {
      const found = raw.includes(`<${t}`);
      if (found) {
        const idx = raw.indexOf(`<${t}`);
        console.log(`  <${t}>  ← FOUND | sample: ${raw.slice(idx, idx + 120).replace(/\n/g,' ')}`);
      }
    }
  }
}

main().catch(console.error);
