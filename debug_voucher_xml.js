'use strict';
/**
 * debug_voucher_xml.js
 * Fetches ONE day of vouchers and prints the raw parsed structure.
 * Run: node debug_voucher_xml.js
 * This reveals why total_amount=0 and what fields actually exist.
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');

const COMPANY = 'Wallnut Building Solutions India Pvt Ltd-2024-25';
// Use a date we know has vouchers
const FROM = '2025-03-31';
const TO   = '2025-03-31';

async function main() {
  console.log(`Fetching Day Book: ${FROM} → ${TO}\nCompany: ${COMPANY}\n`);

  const xml    = templates.buildAllVouchersRequest(COMPANY, FROM, TO);
  const raw    = await tallyClient.request(xml);
  console.log(`Response size: ${raw.length} bytes`);

  // Save raw XML for inspection
  const fs = require('fs');
  fs.writeFileSync('debug_raw_vouchers.xml', raw, 'utf8');
  console.log('Raw XML saved to: debug_raw_vouchers.xml');

  const parsed = tallyClient.parseXml(raw);
  const env    = parsed?.ENVELOPE;
  const body   = env?.BODY;

  // Navigate both response structures
  const importData  = body?.IMPORTDATA;
  const exportData  = body?.EXPORTDATA || body?.DATA;

  console.log('\n=== Response Structure ===');
  console.log('Has IMPORTDATA:', !!importData);
  console.log('Has EXPORTDATA/DATA:', !!exportData);

  // Get TALLYMESSAGE array
  const msgs = importData?.REQUESTDATA?.TALLYMESSAGE;
  if (msgs) {
    const msgArr = Array.isArray(msgs) ? msgs : [msgs];
    console.log(`\nTALLYMESSAGE count: ${msgArr.length}`);

    // Find first with VOUCHER
    const withVoucher = msgArr.find(m => m.VOUCHER);
    if (withVoucher) {
      const v = Array.isArray(withVoucher.VOUCHER) ? withVoucher.VOUCHER[0] : withVoucher.VOUCHER;
      console.log('\n=== FIRST VOUCHER — ALL KEYS ===');
      console.log(Object.keys(v).join('\n'));

      console.log('\n=== KEY FIELDS ===');
      console.log('VOUCHERNUMBER:', v.VOUCHERNUMBER);
      console.log('VOUCHERTYPENAME:', v.VOUCHERTYPENAME);
      console.log('DATE:', v.DATE);
      console.log('PARTYLEDGERNAME:', v.PARTYLEDGERNAME);
      console.log('NARRATION:', v.NARRATION);
      console.log('GROSSAMOUNT:', v.GROSSAMOUNT);
      console.log('AMOUNT:', v.AMOUNT);

      // Ledger entries
      const le = v['ALLLEDGERENTRIES.LIST'];
      console.log('\n=== ALLLEDGERENTRIES.LIST ===');
      console.log('Type:', typeof le, '| IsArray:', Array.isArray(le));
      console.log('Count:', Array.isArray(le) ? le.length : (le ? 1 : 0));
      if (le) {
        const first = Array.isArray(le) ? le[0] : le;
        console.log('First entry keys:', Object.keys(first));
        console.log('LEDGERNAME:', first.LEDGERNAME);
        console.log('AMOUNT:', first.AMOUNT);
        console.log('ISPARTYLEDGER:', first.ISPARTYLEDGER);
        console.log('ISDEEMEDPOSITIVE:', first.ISDEEMEDPOSITIVE);
        console.log('\nAll entries:');
        (Array.isArray(le) ? le : [le]).forEach((e, i) => {
          console.log(`  [${i}] ${e.LEDGERNAME} | AMOUNT: ${e.AMOUNT} | IsParty: ${e.ISPARTYLEDGER}`);
        });
      }

      // Inventory entries
      const ie = v['ALLINVENTORYENTRIES.LIST'];
      console.log('\n=== ALLINVENTORYENTRIES.LIST ===');
      console.log('Count:', Array.isArray(ie) ? ie.length : (ie ? 1 : 0));
      if (ie) {
        const first = Array.isArray(ie) ? ie[0] : ie;
        console.log('First entry keys:', Object.keys(first));
        console.log('STOCKITEMNAME:', first.STOCKITEMNAME);
        console.log('ACTUALQTY:', first.ACTUALQTY);
        console.log('RATE:', first.RATE);
        console.log('AMOUNT:', first.AMOUNT);
      }
    } else {
      console.log('No VOUCHER found in TALLYMESSAGE');
      console.log('Available keys in first TALLYMESSAGE:', Object.keys(msgArr[0] || {}));
    }
  }

  // Also print collection structure if EXPORTDATA
  if (exportData) {
    const col = exportData.COLLECTION || exportData?.COLLECTION;
    if (col?.VOUCHER) {
      const v = Array.isArray(col.VOUCHER) ? col.VOUCHER[0] : col.VOUCHER;
      console.log('\n=== EXPORTDATA VOUCHER KEYS ===');
      console.log(Object.keys(v).join('\n'));
    }
  }
}

main().catch(console.error);
