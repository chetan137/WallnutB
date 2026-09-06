'use strict';

const axios          = require('axios');
const { XMLParser }  = require('fast-xml-parser');
const config         = require('../config');
const logger         = require('../utils/logger');

/**
 * tally/client.js
 * Low-level HTTP client for the Tally Prime XML API.
 * Includes retry logic for ECONNRESET errors (Tally drops large responses).
 */

const ALWAYS_ARRAY = new Set([
  'VOUCHER',
  'LEDGER',
  'STOCKITEM',
  'TALLYMESSAGE',
  'LEDGERENTRIES.LIST',       // TallyPrime Day Book — actual ledger entry tag
  'ALLLEDGERENTRIES.LIST',    // Kept for compatibility with older Tally versions
  'ALLINVENTORYENTRIES.LIST',
  'BILLALLOCATIONS.LIST',
  'CATEGORYALLOCATIONS.LIST', // Cost centre category wrapper, nested inside a ledger entry
  'COSTCENTREALLOCATIONS.LIST', // Cost centre allocation (real Sales Officer/Manager name) — nested inside CATEGORYALLOCATIONS.LIST
  'DSPACCNAME',               // Stock Summary display format
  'DSPSTKINFO',               // Stock Summary display format
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
 * Retries up to 3 times on ECONNRESET (Tally drops connection on large responses).
 * @param {string} xml
 * @param {number} [retries=3]
 * @returns {Promise<string>}
 */
async function request(xml, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      logger.info(`[tally] Sending request (attempt ${attempt}/${retries}) → ${config.tally.baseUrl}`);
      const response = await axios.post(config.tally.baseUrl, xml, {
        headers: { 'Content-Type': 'text/xml;charset=UTF-8' },
        timeout: config.tally.timeout,
        responseType: 'text',
      });
      logger.info(`[tally] Response received: ${response.data.length} bytes`);
      return response.data;
    } catch (err) {
      const isConnReset = err.code === 'ECONNRESET' || err.message?.includes('ECONNRESET');
      const isTimeout   = err.code === 'ECONNABORTED' || err.message?.includes('timeout');

      if ((isConnReset || isTimeout) && attempt < retries) {
        const waitMs = attempt * 3000;
        logger.warn(`[tally] ${err.code || 'ERROR'} on attempt ${attempt} — retrying in ${waitMs / 1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

/**
 * POSTs raw XML to Tally Prime and returns a STREAMING response.
 * Use this for large responses (ledgers, outstanding) to avoid buffering.
 * The caller is responsible for consuming/piping the stream.
 * @param {string} xml
 * @returns {Promise<import('stream').Readable>}
 */
async function requestStream(xml) {
  logger.info(`[tally] Opening stream → ${config.tally.baseUrl}`);
  const response = await axios.post(config.tally.baseUrl, xml, {
    headers: { 'Content-Type': 'text/xml;charset=UTF-8' },
    timeout: config.tally.timeout,
    responseType: 'stream',
  });
  logger.info(`[tally] Stream opened (content-length: ${response.headers['content-length'] || 'unknown'})`);
  return response.data; // Node.js Readable stream
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

module.exports = { request, requestStream, parseXml, ping };

