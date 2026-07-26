'use strict';
/**
 * debug_rp_report.js
 * Shows raw XML from Receipts & Payments report for Co1
 * Run: node debug_rp_report.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');

const co = config.companies.find(c => c.isHistorical) || config.companies[0];
console.log(`Company: ${co.tallyName}\n`);

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>Receipts and Payments</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${co.tallyName}</SVCURRENTCOMPANY>
      <SVFROMDATE>20240401</SVFROMDATE>
      <SVTODATE>20250331</SVTODATE>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;

async function main() {
  const raw = await tallyClient.request(xml);
  console.log(`Response: ${raw.length} bytes\n`);

  // Show ALL unique XML tags
  const tags = new Set([...raw.matchAll(/<([A-Z][A-Z0-9_]*)[>\s/]/g)].map(m => m[1]));
  console.log('=== ALL TAGS IN RESPONSE ===');
  console.log([...tags].sort().join(', '));

  // Show first 3000 chars
  console.log('\n=== FIRST 3000 CHARS ===');
  console.log(raw.slice(0, 3000));

  // Show RPMAINAMT values
  console.log('\n=== ALL RPMAINAMT VALUES ===');
  const rp = [...raw.matchAll(/<RPMAINAMT>([^<]*)<\/RPMAINAMT>/g)].map(m => m[1]);
  console.log(rp.filter(v => v.trim() !== '').join(', '));

  // Show RPSUBAMT values
  console.log('\n=== ALL RPSUBAMT VALUES ===');
  const rs = [...raw.matchAll(/<RPSUBAMT>([^<]*)<\/RPSUBAMT>/g)].map(m => m[1]);
  console.log(rs.filter(v => v.trim() !== '').join(', '));

  // Show DSPDISPNAME + amounts paired
  console.log('\n=== PARSED ITEMS (DSPDISPNAME + RPMAINAMT non-zero) ===');
  const blockRegex = /<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>[\s\S]*?<RPSUBAMT>([^<]*)<\/RPSUBAMT>[\s\S]*?<RPMAINAMT>([^<]*)<\/RPMAINAMT>/g;
  let m;
  while ((m = blockRegex.exec(raw)) !== null) {
    const name = m[1].trim();
    const sub  = parseFloat(m[2]) || 0;
    const main = parseFloat(m[3]) || 0;
    if (main !== 0 || sub !== 0) {
      console.log(`  ${name.padEnd(45)} main=${main.toFixed(0).padStart(15)}  sub=${sub.toFixed(0).padStart(15)}`);
    }
  }
}

main().catch(console.error);
