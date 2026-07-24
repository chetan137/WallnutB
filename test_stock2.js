/**
 * test_stock2.js — tries multiple Tally report names to find stock items
 * Run: node test_stock2.js
 */
'use strict';
require('dotenv').config();
const axios = require('axios');

const url     = process.env.TALLY_HOST + ':' + process.env.TALLY_PORT;
const company = 'Wallnut Building Solutions India Pvt Ltd-2024-25';

async function tryReport(reportName) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${reportName}</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

  try {
    const r = await axios.post(url, xml, {
      headers: { 'Content-Type': 'text/xml' },
      responseType: 'text',
      timeout: 30_000,
    });
    const size     = r.data.length;
    const isError  = r.data.includes('LINEERROR') || r.data.includes('Could not find');
    const items    = (r.data.match(/<STOCKITEM/gi) || []).length;
    const tags     = r.data.match(/<[A-Z]/g) || [];
    // First unique tags
    const uniqueTags = [...new Set(tags.map(t => t.slice(1)))].slice(0, 8).join(', ');
    console.log(`  [${reportName.padEnd(25)}] ${size.toString().padStart(7)} bytes | error=${isError} | STOCKITEM=${items} | tags: ${uniqueTags}`);
    if (!isError && size > 500) {
      console.log('  >>> PROMISING! First 800 chars:');
      console.log(r.data.slice(0, 800));
    }
  } catch (e) {
    console.log(`  [${reportName.padEnd(25)}] ERROR: ${e.message.slice(0, 60)}`);
  }
}

async function main() {
  console.log('Testing Tally:', url, '| Company:', company, '\n');

  // Built-in report names to try
  const reports = [
    'List of Items',
    'List of Stock Items',
    'Stock Items',
    'Godown Summary',
    'Item Summary',
    'Stock Summary',
    'Stock Item',
    'All Items',
    'Item Master',
    'Item wise Profit & Loss A/c',
    'Godown Item Summary',
  ];

  for (const name of reports) {
    await tryReport(name);
    await new Promise(r => setTimeout(r, 300)); // small delay between requests
  }

  console.log('\nDone!');
}

main().catch(console.error);
