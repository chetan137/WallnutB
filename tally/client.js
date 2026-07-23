'use strict';

const axios          = require('axios');
const { XMLParser }  = require('fast-xml-parser');
const config         = require('../config');
const logger         = require('../utils/logger');

/**
 * tally/client.js
 * Low-level HTTP client for the Tally Prime XML API.
 *
 * fast-xml-parser is used instead of xml2js:
 *   - ~3× faster for large Day Book responses
 *   - Lower memory footprint (important on 4 GB VM)
 *
 * The `isArray` callback ensures collection nodes are always arrays,
 * so parsers never need to guard against single-element non-arrays.
 */

const ALWAYS_ARRAY = new Set([
  'VOUCHER',
  'LEDGER',
  'STOCKITEM',
  'TALLYMESSAGE',           // Tally IMPORTDATA wraps data in TALLYMESSAGE nodes
  'ALLLEDGERENTRIES.LIST',
  'ALLINVENTORYENTRIES.LIST',
  'BILLALLOCATIONS.LIST',
]);

const xmlParser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  trimValues:          true,
  parseAttributeValue: false,
  isArray: (tagName) => ALWAYS_ARRAY.has(tagName),
});

/**
 * POSTs raw XML to Tally Prime and returns the raw response string.
 * @param {string} xml
 * @returns {Promise<string>}
 */
async function request(xml) {
  const response = await axios.post(config.tally.baseUrl, xml, {
    headers: { 'Content-Type': 'text/xml;charset=UTF-8' },
    timeout: config.tally.timeout,
    // Return raw string — do NOT let axios try to parse XML
    responseType: 'text',
  });
  return response.data;
}

/**
 * Parses a Tally XML string into a JS object using fast-xml-parser.
 * @param {string} rawXml
 * @returns {Object}
 */
function parseXml(rawXml) {
  return xmlParser.parse(rawXml);
}

/**
 * Checks if Tally Prime is reachable on the configured port.
 * Does NOT require a specific company to be loaded.
 * @returns {Promise<boolean>}
 */
async function ping() {
  try {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>List of Companies</REPORTNAME>
        <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
    await axios.post(config.tally.baseUrl, xml, {
      headers: { 'Content-Type': 'text/xml;charset=UTF-8' },
      timeout: 5_000,
      responseType: 'text',
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { request, parseXml, ping };
