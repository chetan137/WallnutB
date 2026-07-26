'use strict';
/**
 * debug_pl_compare.js
 * Compares P&L XML from Tally:
 *   A) WITHOUT date params (like original debug_pl_report.js — returns correct data)
 *   B) WITH date params   (like syncProfitAndLoss — returns 0s)
 * Run: node debug_pl_compare.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');

const co = config.companies.find(c => c.isHistorical) || config.companies[0];
console.log(`Company: ${co.tallyName}\n`);

function xmlWithoutDates(company) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>Profit and Loss</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

function xmlWithDates(company, from, to) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>Profit and Loss</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
      <SVFROMDATE>${from.replace(/-/g,'')}</SVFROMDATE>
      <SVTODATE>${to.replace(/-/g,'')}</SVTODATE>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

function extractAmounts(raw, label) {
  const results = [];
  const blockRegex = /<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>[\s\S]*?<PLSUBAMT>([^<]*)<\/PLSUBAMT>[\s\S]*?<BSMAINAMT>([^<]*)<\/BSMAINAMT>/g;
  let m;
  while ((m = blockRegex.exec(raw)) !== null) {
    const name = m[1].trim();
    const sub  = parseFloat(m[2]) || 0;
    const main = parseFloat(m[3]) || 0;
    if (main !== 0 || sub !== 0) results.push({ name, sub, main });
  }
  console.log(`\n[${label}] ${raw.length} bytes → ${results.length} non-zero items:`);
  results.slice(0,8).forEach(r =>
    console.log(`  ${r.name.padEnd(35)} main=${r.main.toFixed(2).padStart(15)}  sub=${r.sub.toFixed(2).padStart(15)}`)
  );
  // Show first 1000 chars of raw to inspect tags
  console.log(`\n  --- First 800 chars ---`);
  console.log(raw.slice(0, 800));
}

async function main() {
  console.log('=== A) WITHOUT date params ===');
  const rawA = await tallyClient.request(xmlWithoutDates(co.tallyName));
  extractAmounts(rawA, 'NO DATES');

  console.log('\n=== B) WITH date params (2024-04-01 to 2025-03-31) ===');
  const rawB = await tallyClient.request(xmlWithDates(co.tallyName, '2024-04-01', '2025-03-31'));
  extractAmounts(rawB, 'WITH DATES');

  console.log('\n=== C) Tags present in A but NOT in B ===');
  const tagsA = new Set([...rawA.matchAll(/<([A-Z][A-Z0-9_]*)[>\s/]/g)].map(m=>m[1]));
  const tagsB = new Set([...rawB.matchAll(/<([A-Z][A-Z0-9_]*)[>\s/]/g)].map(m=>m[1]));
  const onlyA = [...tagsA].filter(t=>!tagsB.has(t));
  const onlyB = [...tagsB].filter(t=>!tagsA.has(t));
  console.log('  Only in NO-DATES:', onlyA.join(', ') || 'none');
  console.log('  Only in WITH-DATES:', onlyB.join(', ') || 'none');
}

main().catch(console.error);
