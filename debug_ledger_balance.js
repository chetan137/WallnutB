'use strict';
/**
 * debug_ledger_balance.js
 * Fetches the first 500KB of the ledger XML and finds CLOSINGBALANCE values.
 * Run: node debug_ledger_balance.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const config      = require('./config');

const COMPANY = 'Wallnut Building Solutions India Pvt Ltd-2024-25';
const FROM    = '2024-04-01';
const TO      = '2025-03-31';  // Use fiscal year end for 24-25

async function main() {
  console.log(`Requesting List of Accounts: ${FROM} → ${TO}\n`);

  const xml    = templates.buildLedgerMasterRequest(COMPANY, FROM, TO);
  const stream = await tallyClient.requestStream(xml);

  // Collect first 600KB then stop
  const MAX_BYTES = 600 * 1024;
  let chunks = [];
  let total  = 0;

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

  // Find all CLOSINGBALANCE values
  const cbMatches = [...raw.matchAll(/<CLOSINGBALANCE[^>]*>([^<]*)<\/CLOSINGBALANCE>/g)];
  console.log(`=== CLOSINGBALANCE occurrences (first 10): ===`);
  cbMatches.slice(0, 10).forEach((m, i) => {
    console.log(`  [${i}] raw value: "${m[1]}"`);
  });
  if (cbMatches.length === 0) {
    console.log('  >>> NONE FOUND in first 600KB!');
  }

  // Find HDFC Bank ledger context
  const hdfcIdx = raw.indexOf('HDFC Bank');
  if (hdfcIdx >= 0) {
    const snippet = raw.slice(Math.max(0, hdfcIdx - 50), hdfcIdx + 1000);
    console.log('\n=== HDFC Bank XML context (1000 chars) ===');
    console.log(snippet);
  } else {
    console.log('\n>>> HDFC Bank not found in first 600KB — searching for any LEDGER tag...');
    const ledgerIdx = raw.indexOf('<LEDGER');
    if (ledgerIdx >= 0) {
      console.log('\n=== First LEDGER tag context ===');
      console.log(raw.slice(ledgerIdx, ledgerIdx + 2000));
    }
  }

  // Show first PARENT occurrence to confirm we're in a ledger
  const parentMatches = [...raw.matchAll(/<PARENT>([^<]*)<\/PARENT>/g)];
  console.log(`\n=== PARENT field occurrences (first 5): ===`);
  parentMatches.slice(0, 5).forEach((m, i) => {
    console.log(`  [${i}] "${m[1]}"`);
  });

  // Show all unique tag names that appear INSIDE a LEDGER block
  const ledgerBlock = raw.match(/<LEDGER[^>]*>([\s\S]*?)<\/LEDGER>/);
  if (ledgerBlock) {
    const inner = ledgerBlock[1];
    const tags = [...inner.matchAll(/<([A-Z][A-Z0-9_.]*)[^/]?>/g)].map(m => m[1]);
    const unique = [...new Set(tags)];
    console.log(`\n=== Tags inside first LEDGER block (${unique.length} unique): ===`);
    console.log(unique.join(', '));
  }
}

main().catch(console.error);
