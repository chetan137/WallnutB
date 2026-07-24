/**
 * test_stock2.js  — tests TDL-based stock item export with full REPORT definition
 * Run: node test_stock2.js
 */
'use strict';
require('dotenv').config();
const axios = require('axios');

const url     = process.env.TALLY_HOST + ':' + process.env.TALLY_PORT;
const company = 'Wallnut Building Solutions India Pvt Ltd-2024-25';

// Full TDL definition — COLLECTION needs a REPORT/FORM/PART/LINE/FIELD wrapper
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
            <COLLECTION NAME="WCOL_STOCK">
              <TYPE>Stock Item</TYPE>
              <FETCH>Name, Parent, BaseUnits, ClosingBalance, ClosingValue</FETCH>
            </COLLECTION>
            <REPORT NAME="WALLNUT_STOCK_EXPORT">
              <FORMS>WFORM_STOCK</FORMS>
            </REPORT>
            <FORM NAME="WFORM_STOCK">
              <PARTS>WPART_STOCK</PARTS>
            </FORM>
            <PART NAME="WPART_STOCK">
              <LINES>WLINE_STOCK</LINES>
              <REPEAT>WLINE_STOCK : WCOL_STOCK</REPEAT>
              <SCROLLED>Vertical</SCROLLED>
            </PART>
            <LINE NAME="WLINE_STOCK">
              <FIELDS>WF_SNAME,WF_SPARENT,WF_SUNIT,WF_SQTY,WF_SVALUE</FIELDS>
              <XMLTAG>"STOCKITEM"</XMLTAG>
            </LINE>
            <FIELD NAME="WF_SNAME">
              <SET>$Name</SET>
              <XMLTAG>"NAME"</XMLTAG>
            </FIELD>
            <FIELD NAME="WF_SPARENT">
              <SET>$Parent</SET>
              <XMLTAG>"PARENT"</XMLTAG>
            </FIELD>
            <FIELD NAME="WF_SUNIT">
              <SET>$BaseUnits</SET>
              <XMLTAG>"BASEUNITS"</XMLTAG>
            </FIELD>
            <FIELD NAME="WF_SQTY">
              <SET>$ClosingBalance</SET>
              <XMLTAG>"CLOSINGBALANCE"</XMLTAG>
            </FIELD>
            <FIELD NAME="WF_SVALUE">
              <SET>$ClosingValue</SET>
              <XMLTAG>"CLOSINGVALUE"</XMLTAG>
            </FIELD>
          </TDLMESSAGE>
        </TDL>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

console.log('Sending stock items request (full TDL) to:', url);
console.log('Company:', company);

axios.post(url, xml, {
  headers: { 'Content-Type': 'text/xml' },
  responseType: 'text',
  timeout: 120_000,
})
  .then(r => {
    console.log('\n--- Response size:', r.data.length, 'bytes ---');
    console.log(r.data.slice(0, 3000));

    const matches = r.data.match(/<STOCKITEM/g);
    console.log('\n=== STOCKITEM tags found:', matches ? matches.length : 0, '===');
  })
  .catch(e => console.error('ERROR:', e.message));
