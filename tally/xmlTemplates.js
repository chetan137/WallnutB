'use strict';

const { escapeXml, isoToTally } = require('../utils/helpers');

/**
 * tally/xmlTemplates.js
 *
 * Builds all XML request envelopes for the Tally Prime XML API.
 *
 * KEY DESIGN DECISION — Unknown Company Compatibility:
 *   - buildAllVouchersRequest() fetches ALL voucher types (no VOUCHERTYPE filter).
 *     This means Sales, Credit Notes, Receipts, Payments, Journals — everything.
 *     vch_type is stored as-is in the DB. The AWS API filters by type for reports.
 *
 *   - buildLedgerMasterRequest() fetches ALL ledger accounts (no ACCOUNTTYPE filter).
 *     This includes customers, suppliers, banks, duties — the parent_group column
 *     in the DB tells us what category each ledger belongs to.
 *
 * This makes the service work correctly even when the new company's structure
 * is completely unknown before first run.
 */

/**
 * Fetch ALL vouchers (all types) for a given date range.
 * Uses Day Book report — includes every voucher Tally recorded.
 *
 * @param {string} companyName  Exact Tally company name
 * @param {string} fromDate     ISO date "YYYY-MM-DD"
 * @param {string} toDate       ISO date "YYYY-MM-DD"
 * @returns {string}
 */
function buildAllVouchersRequest(companyName, fromDate, toDate) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Day Book</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
          <SVFROMDATE>${isoToTally(fromDate)}</SVFROMDATE>
          <SVTODATE>${isoToTally(toDate)}</SVTODATE>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/**
 * Fetch ALL ledger masters (customers, suppliers, banks, all groups).
 * No ACCOUNTTYPE filter — works for unknown company structures.
 *
 * @param {string} companyName
 * @returns {string}
 */
function buildLedgerMasterRequest(companyName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>List of Accounts</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/**
 * Fetch Stock Summary (all stock items with closing qty and value).
 *
 * @param {string} companyName
 * @returns {string}
 */
function buildStockItemsRequest(companyName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Stock Summary</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/**
 * Fetch Outstanding Receivables snapshot.
 * Returns all parties with a positive closing balance.
 *
 * @param {string} companyName
 * @returns {string}
 */
function buildOutstandingRequest(companyName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Outstanding Receivables</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

module.exports = {
  buildAllVouchersRequest,
  buildLedgerMasterRequest,
  buildStockItemsRequest,
  buildOutstandingRequest,
};
