'use strict';
/**
 * debug_trial_balance.js
 * Fetches Trial Balance XML and shows its structure.
 * Run: node debug_trial_balance.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const { escapeXml, isoToTally } = require('./utils/helpers');

const COMPANY = 'Wallnut Building Solutions India Pvt Ltd-2024-25';
const FROM    = '2024-04-01';
const TO      = '2025-03-31';

function buildTrialBalanceRequest(companyName, fromDate, toDate) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Trial Balance</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
          <SVFROMDATE>${isoToTally(fromDate)}</SVFROMDATE>
          <SVTODATE>${isoToTally(toDate)}</SVTODATE>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

async function main() {
  console.log(`Requesting Trial Balance: ${FROM} → ${TO}\nCompany: ${COMPANY}\n`);

  const xml    = buildTrialBalanceRequest(COMPANY, FROM, TO);
  const stream = await tallyClient.requestStream(xml);

  // Collect first 100KB only
  const MAX_BYTES = 100 * 1024;
  let chunks = [], total = 0;

  await new Promise((resolve, reject) => {
    stream.on('data', chunk => {
      if (total < MAX_BYTES) {
        chunks.push(chunk);
        total += chunk.length;
      } else {
        stream.destroy();
        resolve();
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
    stream.on('close', resolve);
  });

  const raw = Buffer.concat(chunks).toString('utf8');
  console.log(`Captured: ${(total/1024).toFixed(1)} KB\n`);

  // Show first 3000 chars of raw XML
  console.log('=== RAW XML (first 3000 chars) ===');
  console.log(raw.slice(0, 3000));
  console.log('\n...\n');

  // Find all unique XML tags in response
  const tags = [...raw.matchAll(/<([A-Z][A-Z0-9_.]*)[>\s]/g)].map(m => m[1]);
  const unique = [...new Set(tags)];
  console.log(`=== All XML tags found (${unique.length}) ===`);
  console.log(unique.join(', '));

  // Look for key patterns
  console.log('\n=== Patterns: ===');
  const hasLedger    = raw.includes('<LEDGER');
  const hasDspAcc    = raw.includes('DSPACCNAME');
  const hasDspDr     = raw.includes('DSPDR');
  const hasDspCr     = raw.includes('DSPCR');
  const hasDspBal    = raw.includes('DSPBAL');
  const hasAmt       = raw.includes('AMOUNT');
  const hasClBal     = raw.includes('CLOSINGBALANCE');
  console.log(`LEDGER tag:        ${hasLedger}`);
  console.log(`DSPACCNAME:        ${hasDspAcc}`);
  console.log(`DSPDR* tags:       ${hasDspDr}`);
  console.log(`DSPCR* tags:       ${hasDspCr}`);
  console.log(`DSPBAL* tags:      ${hasDspBal}`);
  console.log(`AMOUNT:            ${hasAmt}`);
  console.log(`CLOSINGBALANCE:    ${hasClBal}`);

  // Show any DSP tags
  const dspTags = unique.filter(t => t.startsWith('DSP'));
  console.log(`\nAll DSP tags: ${dspTags.join(', ')}`);
}

main().catch(console.error);
