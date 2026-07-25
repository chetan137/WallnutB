'use strict';

const sax    = require('sax');
const logger = require('../utils/logger');

/**
 * tally/streamParser.js
 *
 * SAX-based streaming XML parser for Tally responses.
 *
 * WHY: fast-xml-parser loads the ENTIRE XML into memory as a JS object.
 *      For a 55 MB ledger export this creates a ~500 MB JS object on a 4 GB VM
 *      that already runs TallyPrime + PostgreSQL — causing OOM or extreme slowness.
 *
 * HOW: SAX parses bytes as they arrive from the HTTP stream.
 *      Peak memory usage is proportional to ONE record, not the entire file.
 *      We can also show real-time download + parse progress.
 */

// ── Field lists we care about (everything else is skipped) ────────────────────

const LEDGER_FIELDS = new Set([
  'PARENT', 'OPENINGBALANCE', 'GSTREGISTRATIONNUMBER', 'GSTIN', 'PARTYGSTIN',
  'STATENAME', 'STATE', 'NAME',
]);

// ── Helper: human-readable bytes ──────────────────────────────────────────────

function humanBytes(b) {
  if (b < 1024)        return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Core streaming parser ─────────────────────────────────────────────────────

/**
 * Streams a Tally HTTP response through a SAX parser.
 * Calls onRecord(record) for each complete LEDGER found.
 *
 * @param {import('stream').Readable} responseStream  axios responseType:'stream'
 * @param {string}   recordTag     XML tag to look for ('LEDGER', 'STOCKITEM', etc.)
 * @param {Set}      fieldSet      Set of child tag names to extract
 * @param {Function} onRecord      Called with a plain object for each complete record
 * @param {Function} [onProgress]  Called with (bytesReceived, recordsParsed) periodically
 * @returns {Promise<{ bytesTotal: number, recordsParsed: number }>}
 */
function streamParseRecords(responseStream, recordTag, fieldSet, onRecord, onProgress) {
  return new Promise((resolve, reject) => {
    // SAX stream in strict mode (case-sensitive tags)
    const saxStream = sax.createStream(true, {
      lowercase:  false,
      trim:       true,
      normalize:  false,
    });

    let currentRecord = null;
    let currentField  = null;
    let currentText   = '';
    let bytesReceived = 0;
    let recordsParsed = 0;
    let lastProgressBytes = 0;

    // ── Progress tracking via data events ──────────────────────────────────
    responseStream.on('data', (chunk) => {
      bytesReceived += chunk.length;
      // Report progress every 2 MB downloaded
      if (onProgress && (bytesReceived - lastProgressBytes) >= 2 * 1024 * 1024) {
        onProgress(bytesReceived, recordsParsed);
        lastProgressBytes = bytesReceived;
      }
    });

    // ── SAX events ──────────────────────────────────────────────────────────
    saxStream.on('opentag', (node) => {
      if (node.name === recordTag) {
        // Start of a new record — grab the NAME attribute if present
        currentRecord = { _name: node.attributes['NAME'] || '' };
        currentField  = null;
        currentText   = '';
      } else if (currentRecord !== null && fieldSet.has(node.name)) {
        currentField = node.name;
        currentText  = '';
      } else {
        currentField = null;
        currentText  = '';
      }
    });

    saxStream.on('text', (text) => {
      if (currentRecord !== null && currentField !== null) {
        currentText += text;
      }
    });

    saxStream.on('cdata', (cdata) => {
      if (currentRecord !== null && currentField !== null) {
        currentText += cdata;
      }
    });

    saxStream.on('closetag', (tagName) => {
      if (currentRecord !== null) {
        if (tagName === recordTag) {
          // Complete record — emit it
          onRecord(currentRecord);
          recordsParsed++;
          currentRecord = null;
          currentField  = null;
          currentText   = '';
        } else if (currentField !== null && tagName === currentField) {
          // Store field value into current record
          currentRecord[currentField] = currentText.trim();
          currentField = null;
          currentText  = '';
        }
      }
    });

    saxStream.on('error', (err) => {
      // SAX strict-mode throws on namespace declarations like xmlns:UDF="..."
      // These are harmless — resume the stream.
      if (err.message && (
        err.message.includes('Unexpected end') ||
        err.message.includes('Unquoted') ||
        err.message.includes('attribute') ||
        err.message.includes('namespace')
      )) {
        saxStream._parser.error = null;
        saxStream._parser.resume();
        return;
      }
      // Real error
      reject(err);
    });

    saxStream.on('end', () => {
      if (onProgress) onProgress(bytesReceived, recordsParsed); // final progress
      resolve({ bytesTotal: bytesReceived, recordsParsed });
    });

    // ── Pipe HTTP stream → SAX ───────────────────────────────────────────────
    responseStream.on('error', reject);
    responseStream.pipe(saxStream);
  });
}

// ── Ledger streaming parser ───────────────────────────────────────────────────

/**
 * Stream-parses a Tally "List of Accounts" response.
 * Returns an array of ledger records WITHOUT loading the full XML into memory.
 *
 * @param {import('stream').Readable} responseStream
 * @param {number}   companyId
 * @param {Function} [onProgress]  (bytesReceived, recordsParsed) => void
 * @returns {Promise<Array>}
 */
async function streamParseLedgers(responseStream, companyId, onProgress) {
  const records = [];

  await streamParseRecords(
    responseStream,
    'LEDGER',
    LEDGER_FIELDS,
    (raw) => {
      const name           = String(raw._name || raw.NAME || '').trim();
      const parentGroup    = String(raw.PARENT || '').trim();
      // CLOSINGBALANCE is NOT in List of Accounts — only OPENINGBALANCE is.
      // closing_balance is computed post-sync as: opening_balance + SUM(voucher_ledger_entries)
      const openingBalance = parseFloat(raw.OPENINGBALANCE) || 0;
      const gstNo          = String(raw.PARTYGSTIN || raw.GSTREGISTRATIONNUMBER || raw.GSTIN || '').trim();
      const state          = String(raw.STATENAME || raw.STATE || '').trim();

      if (!name) return; // skip empty
      records.push({ companyId, name, parentGroup, openingBalance, gstNo, state });
    },
    onProgress
  );

  return records;
}

module.exports = { streamParseLedgers, humanBytes };
