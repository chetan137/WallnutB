'use strict';
/**
 * debug_trial_balance_detailed.js
 * Tests different Tally variables to get per-LEDGER trial balance
 * Run: node debug_trial_balance_detailed.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const { escapeXml, isoToTally } = require('./utils/helpers');

const COMPANY = 'Wallnut Building Solutions India Pvt Ltd-2024-25';
const FROM    = '2024-04-01';
const TO      = '2025-03-31';

async function tryRequest(label, extraVars) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Trial Balance</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(COMPANY)}</SVCURRENTCOMPANY>
          <SVFROMDATE>${isoToTally(FROM)}</SVFROMDATE>
          <SVTODATE>${isoToTally(TO)}</SVTODATE>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          ${extraVars}
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

  const stream = await tallyClient.requestStream(xml);
  let chunks = [], total = 0;
  const MAX = 150 * 1024;

  await new Promise((resolve, reject) => {
    stream.on('data', c => { if (total < MAX) { chunks.push(c); total += c.length; } else { stream.destroy(); resolve(); } });
    stream.on('end', resolve);
    stream.on('error', reject);
    stream.on('close', resolve);
  });

  const raw = Buffer.concat(chunks).toString('utf8');

  // Count DSPACCNAME occurrences = number of rows
  const rows = (raw.match(/<DSPDISPNAME>/g) || []).length;
  const hasHDFC = raw.includes('HDFC');
  const hasCash = raw.includes('Cash');

  // Check if HDFC Bank or Cash balance is there
  const hdfcIdx = raw.indexOf('HDFC Bank');
  let hdfcBalance = 'not found';
  if (hdfcIdx >= 0) {
    hdfcBalance = raw.slice(hdfcIdx - 10, hdfcIdx + 300);
  }

  console.log(`\n[${label}]`);
  console.log(`  Size: ${(total/1024).toFixed(1)} KB | Rows: ${rows} | HDFC: ${hasHDFC} | Cash: ${hasCash}`);
  if (hasHDFC) console.log(`  HDFC context:\n${hdfcBalance}`);
  if (rows > 0 && rows !== 12) console.log(`  → rows=${rows} (not just groups!)`);
  return rows;
}

async function main() {
  console.log('Testing Trial Balance variants...\n');

  // Test 1: Group level only (baseline)
  await tryRequest('BASELINE (no extras)', '');

  // Test 2: Detailed mode
  await tryRequest('SVDETAILED=Yes', '<SVDETAILED>Yes</SVDETAILED>');

  // Test 3: Expand all
  await tryRequest('EXPANDALTINFO=Yes', '<EXPANDALTINFO>Yes</EXPANDALTINFO>');

  // Test 4: Show leaves
  await tryRequest('SVSHOWLEAVES=Yes', '<SVSHOWLEAVES>Yes</SVSHOWLEAVES>');

  // Test 5: COMPUTEVAR detail
  await tryRequest('SVEXPANDLEAVES=Yes', '<SVEXPANDLEAVES>Yes</SVEXPANDLEAVES>');

  // Test 6: Try "Ledger" report instead
  const xmlLedger = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Ledger</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(COMPANY)}</SVCURRENTCOMPANY>
          <SVFROMDATE>${isoToTally(FROM)}</SVFROMDATE>
          <SVTODATE>${isoToTally(TO)}</SVTODATE>
          <SVLEDGERNAME>HDFC Bank</SVLEDGERNAME>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
  const streamL = await tallyClient.requestStream(xmlLedger);
  let cl = [], tl = 0;
  await new Promise((res, rej) => {
    streamL.on('data', c => { if (tl < 50*1024) { cl.push(c); tl += c.length; } else { streamL.destroy(); res(); } });
    streamL.on('end', res); streamL.on('error', rej); streamL.on('close', res);
  });
  const rawL = Buffer.concat(cl).toString('utf8');
  console.log('\n[Ledger report for HDFC Bank]');
  console.log(`  Size: ${(tl/1024).toFixed(1)} KB`);
  console.log(`  First 1000 chars:\n${rawL.slice(0, 1000)}`);
}

main().catch(console.error);
