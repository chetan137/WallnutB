'use strict';
/**
 * debug_ledger_fields.js
 * Downloads FULL List of Accounts response and finds all balance-related fields.
 * Run: node debug_ledger_fields.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');

const COMPANY = 'Wallnut Building Solutions India Pvt Ltd-2024-25';
const FROM    = '2024-04-01';
const TO      = '2025-03-31';

async function main() {
  console.log('Downloading FULL List of Accounts (1.3MB)...\n');

  const xml    = templates.buildLedgerMasterRequest(COMPANY, FROM, TO);
  const stream = await tallyClient.requestStream(xml);

  let chunks = [], total = 0;
  await new Promise((resolve, reject) => {
    stream.on('data', c => { chunks.push(c); total += c.length; });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  const raw = Buffer.concat(chunks).toString('utf8');
  console.log(`Downloaded: ${(total/1024).toFixed(1)} KB\n`);

  // Search for balance-related field names
  const balanceFields = [
    'CLOSINGBALANCE', 'OPENINGBALANCE', 'CLOSINGVALUE',
    'LEDGERBALANCE', 'BALANCE', 'AMOUNT', 'DRCR',
    'DEBIT', 'CREDIT', 'LEDGERCLOSINGBALANCE',
    'CLOSINGBALANCEAMOUNT', 'CBAMOUNT',
  ];

  console.log('=== BALANCE-RELATED FIELD SEARCH ===');
  for (const field of balanceFields) {
    const count = (raw.match(new RegExp(`<${field}[>/]`, 'g')) || []).length;
    if (count > 0) {
      const firstIdx = raw.indexOf(`<${field}`);
      const firstVal = raw.slice(firstIdx, firstIdx + 100);
      console.log(`  ${field}: ${count} occurrences | First: ${firstVal.replace(/\n/g,' ')}`);
    } else {
      console.log(`  ${field}: NOT FOUND`);
    }
  }

  // Find HDFC Bank ledger block and show ALL its fields
  console.log('\n=== HDFC Bank LEDGER block ===');
  const hdfcAttrIdx = raw.indexOf('NAME="HDFC Bank"');
  const hdfcNameIdx = raw.indexOf('>HDFC Bank<');
  const startIdx    = hdfcAttrIdx >= 0 ? hdfcAttrIdx : hdfcNameIdx;

  if (startIdx >= 0) {
    // Find the <LEDGER> open tag before this
    const ledgerOpen = raw.lastIndexOf('<LEDGER', startIdx);
    // Find the </LEDGER> close tag after
    const ledgerClose = raw.indexOf('</LEDGER>', startIdx);
    if (ledgerOpen >= 0 && ledgerClose >= 0) {
      const block = raw.slice(ledgerOpen, ledgerClose + 9);
      console.log(`Block length: ${block.length} chars`);
      console.log(block);
    } else {
      console.log('Could not find full LEDGER block for HDFC Bank');
      console.log('Context around HDFC:', raw.slice(startIdx - 50, startIdx + 500));
    }
  } else {
    // Try Cash (shorter, easier to find)
    console.log('HDFC Bank not found by attribute. Trying Cash...');
    const cashIdx = raw.indexOf('NAME="Cash"');
    if (cashIdx >= 0) {
      const ledgerOpen  = raw.lastIndexOf('<LEDGER', cashIdx);
      const ledgerClose = raw.indexOf('</LEDGER>', cashIdx);
      if (ledgerOpen >= 0 && ledgerClose >= 0) {
        const block = raw.slice(ledgerOpen, ledgerClose + 9);
        console.log(`Cash LEDGER block (${block.length} chars):`);
        console.log(block.slice(0, 2000));
      }
    } else {
      // Show ALL unique tags found inside any LEDGER block
      const firstLedger = raw.indexOf('<LEDGER');
      if (firstLedger >= 0) {
        const firstClose = raw.indexOf('</LEDGER>', firstLedger);
        if (firstClose >= 0) {
          const block = raw.slice(firstLedger, firstClose + 9);
          const tags = [...block.matchAll(/<([A-Z][A-Z0-9_.]*)[\s>/]/g)].map(m => m[1]);
          const unique = [...new Set(tags)].filter(t => t !== 'LEDGER');
          console.log(`First LEDGER block tags (${unique.length}):`);
          console.log(unique.join(', '));
          console.log('\nFirst LEDGER block (first 1500 chars):');
          console.log(block.slice(0, 1500));
        }
      }
    }
  }
}

main().catch(console.error);
