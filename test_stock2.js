/**
 * test_stock2.js  — tests the new TDL Collection stock item export
 * Run: node test_stock2.js
 */
'use strict';
require('dotenv').config();
const axios = require('axios');

const url     = process.env.TALLY_HOST + ':' + process.env.TALLY_PORT;
const company = 'Wallnut Building Solutions India Pvt Ltd-2024-25';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>WALLNUT_STOCK_EXPORT</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
        <TDL>
          <TDLMESSAGE>
            <COLLECTION NAME="WALLNUT_STOCK_EXPORT">
              <TYPE>Stock Item</TYPE>
              <FETCH>Name, Parent, BaseUnits, ClosingBalance, ClosingValue</FETCH>
            </COLLECTION>
          </TDLMESSAGE>
        </TDL>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

console.log('Sending stock items request to:', url);
console.log('Company:', company);

axios.post(url, xml, {
  headers: { 'Content-Type': 'text/xml' },
  responseType: 'text',
  timeout: 120_000,
})
  .then(r => {
    console.log('\n--- Response size:', r.data.length, 'bytes ---');
    console.log(r.data.slice(0, 3000));

    // Count STOCKITEM tags
    const matches = r.data.match(/<STOCKITEM/g);
    console.log('\n=== STOCKITEM tags found:', matches ? matches.length : 0, '===');
  })
  .catch(e => console.error('ERROR:', e.message));
