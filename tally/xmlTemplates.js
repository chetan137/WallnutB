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
 * Fetch ALL ledger masters (customers, suppliers, banks, all groups)
 * with their CLOSING BALANCE as of the given date range.
 *
 * IMPORTANT: SVFROMDATE + SVTODATE are REQUIRED for Tally to compute
 * closing balances. Without them Tally returns 0 for all balances.
 *
 * @param {string} companyName
 * @param {string} fromDate   ISO date "YYYY-MM-DD" (fiscal year start)
 * @param {string} toDate     ISO date "YYYY-MM-DD" (today or fiscal year end)
 * @returns {string}
 */
function buildLedgerMasterRequest(companyName, fromDate, toDate) {
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
 * Fetch Stock Groups & Items from Stock Summary report.
 *
 * NOTE: TallyPrime's XML API does not support inline TDL for custom collection exports.
 * "Stock Summary" is the only accessible report. It returns DSP display format
 * (DSPACCNAME/DSPDISPNAME + DSPSTKINFO) which parsers.js handles correctly.
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

/**
 * Fetch Trial Balance (group-level) for a date range.
 * Returns ~37 top-level account groups with Dr/Cr closing amounts.
 * Response is tiny (~1KB) — use request() not requestStream().
 *
 * @param {string} companyName
 * @param {string} fromDate  ISO "YYYY-MM-DD"
 * @param {string} toDate    ISO "YYYY-MM-DD"
 * @returns {string}
 */
function buildTrialBalanceRequest(companyName, fromDate, toDate) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Trial Balance</REPORTNAME>
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
 * Fetch Outstanding Payables snapshot.
 * Gives all suppliers/vendors with pending payable amounts.
 *
 * @param {string} companyName
 * @returns {string}
 */
function buildOutstandingPayablesRequest(companyName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Bills Payable</REPORTNAME>
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
 * Fetch Profit and Loss statement for a specific period.
 * For CLOSED fiscal years, Trial Balance only shows Balance Sheet.
 * This report gives actual P&L line items (Sales, Purchase, Expenses, Net Profit).
 *
 * @param {string} companyName
 * @param {string} fromDate  ISO "YYYY-MM-DD"
 * @param {string} toDate    ISO "YYYY-MM-DD"
 * @returns {string}
 */
function buildProfitAndLossRequest(companyName, fromDate, toDate) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Profit and Loss</REPORTNAME>
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

module.exports = {
  buildAllVouchersRequest,
  buildLedgerMasterRequest,
  buildStockItemsRequest,
  buildOutstandingRequest,
  buildTrialBalanceRequest,
  buildOutstandingPayablesRequest,
  buildProfitAndLossRequest,
};
