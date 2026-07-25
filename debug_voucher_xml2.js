'use strict';
/**
 * debug_voucher_xml2.js
 * Specifically examines LEDGERENTRIES.LIST and ALLINVENTORYENTRIES.LIST
 * Run: node debug_voucher_xml2.js
 */
require('dotenv').config();
const fs = require('fs');

// Parse the saved raw XML
const raw = fs.readFileSync('debug_raw_vouchers.xml', 'utf8');
const tallyClient = require('./tally/client');
const parsed = tallyClient.parseXml(raw);

const env  = parsed?.ENVELOPE;
const body = env?.BODY;
const msgs = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
const msgArr = Array.isArray(msgs) ? msgs : [msgs];

// Find a SALES voucher (not Stock Journal) that has ledger entries
const salesMsg = msgArr.find(m => {
  const v = m?.VOUCHER;
  if (!v) return false;
  const vch = Array.isArray(v) ? v[0] : v;
  const type = String(vch?.VOUCHERTYPENAME || '').toLowerCase();
  return type.includes('sales') || type.includes('credit') || type.includes('purchase');
});

if (!salesMsg) {
  console.log('No sales/credit/purchase voucher found');
  process.exit(1);
}

const vch = Array.isArray(salesMsg.VOUCHER) ? salesMsg.VOUCHER[0] : salesMsg.VOUCHER;
console.log(`\nVoucher: ${vch.VOUCHERNUMBER} | Type: ${vch.VOUCHERTYPENAME}`);
console.log(`Party: ${vch.PARTYLEDGERNAME}`);

// ── LEDGERENTRIES.LIST ───────────────────────────────────────────────────────
console.log('\n=== LEDGERENTRIES.LIST ===');
const le = vch['LEDGERENTRIES.LIST'];
console.log('Type:', typeof le, '| IsArray:', Array.isArray(le));
if (le) {
  const arr = Array.isArray(le) ? le : [le];
  console.log('Count:', arr.length);
  arr.forEach((e, i) => {
    console.log(`  [${i}] keys: ${Object.keys(e).join(', ')}`);
    console.log(`       LEDGERNAME: ${e.LEDGERNAME}`);
    console.log(`       AMOUNT: ${e.AMOUNT}`);
    console.log(`       ISPARTYLEDGER: ${e.ISPARTYLEDGER}`);
    console.log(`       ISDEEMEDPOSITIVE: ${e.ISDEEMEDPOSITIVE}`);
  });
} else {
  console.log('>>> UNDEFINED — not in this voucher');
}

// ── ALLLEDGERENTRIES.LIST ────────────────────────────────────────────────────
console.log('\n=== ALLLEDGERENTRIES.LIST ===');
const ale = vch['ALLLEDGERENTRIES.LIST'];
if (ale) {
  const arr = Array.isArray(ale) ? ale : [ale];
  console.log('Count:', arr.length);
  arr.slice(0, 3).forEach((e, i) => {
    console.log(`  [${i}] keys: ${Object.keys(e).join(', ')}`);
    console.log(`       LEDGERNAME: ${e.LEDGERNAME} | AMOUNT: ${e.AMOUNT}`);
  });
} else {
  console.log('>>> UNDEFINED');
}

// ── ALLINVENTORYENTRIES.LIST ─────────────────────────────────────────────────
console.log('\n=== ALLINVENTORYENTRIES.LIST ===');
const ie = vch['ALLINVENTORYENTRIES.LIST'];
if (ie) {
  const arr = Array.isArray(ie) ? ie : [ie];
  console.log('Count:', arr.length);
  arr.slice(0, 3).forEach((e, i) => {
    if (typeof e === 'object' && e !== null) {
      console.log(`  [${i}] keys: ${Object.keys(e).join(', ')}`);
      console.log(`       STOCKITEMNAME: ${e.STOCKITEMNAME}`);
      console.log(`       ACTUALQTY: ${e.ACTUALQTY} | BILLEDQTY: ${e.BILLEDQTY}`);
      console.log(`       RATE: ${e.RATE} | AMOUNT: ${e.AMOUNT}`);
      // Check nested
      const ba = e['BATCHALLOCATIONS.LIST'];
      if (ba) {
        const b = Array.isArray(ba) ? ba[0] : ba;
        console.log(`       BATCHALLOCATIONS[0]: ${JSON.stringify(b).slice(0,100)}`);
      }
    } else {
      console.log(`  [${i}] value: ${JSON.stringify(e)}`);
    }
  });
} else {
  console.log('>>> UNDEFINED');
}

// ── Now find a SALES voucher with inventory ──────────────────────────────────
console.log('\n=== LOOKING FOR VOUCHER WITH INVENTORY ENTRIES ===');
for (const m of msgArr) {
  const v = m?.VOUCHER;
  if (!v) continue;
  const vch2 = Array.isArray(v) ? v[0] : v;
  const ie2 = vch2['ALLINVENTORYENTRIES.LIST'];
  if (!ie2) continue;
  const arr2 = Array.isArray(ie2) ? ie2 : [ie2];
  // Find one with content
  const hasContent = arr2.some(e => typeof e === 'object' && Object.keys(e).length > 1);
  if (!hasContent) continue;

  console.log(`\nVoucher with inventory: ${vch2.VOUCHERNUMBER} | ${vch2.VOUCHERTYPENAME}`);
  arr2.slice(0, 2).forEach((e, i) => {
    if (typeof e === 'object') {
      console.log(`  [${i}] keys: ${Object.keys(e).join(', ')}`);
      console.log(`       STOCKITEMNAME: ${e.STOCKITEMNAME}`);
      console.log(`       ACTUALQTY: ${e.ACTUALQTY} | BILLEDQTY: ${e.BILLEDQTY}`);
      console.log(`       RATE: ${e.RATE} | AMOUNT: ${e.AMOUNT}`);
    }
  });
  break;
}
