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
 * Fetch ALL vouchers (all types) for a company via an ad-hoc TDL Collection.
 *
 * BUG FIX: this used to request REPORTNAME="Day Book" with SVFROMDATE/
 * SVTODATE. Verified live (debug_investigation.js TESTs 1/5/6/7) that on
 * this Tally installation "Day Book" specifically returns an unrelated
 * "Import Data"/"All Masters"-shaped response regardless of the requested
 * date range — while every other report name (Trial Balance, List of
 * Accounts, Stock Summary, a deliberately nonexistent name) resolves
 * normally (nonexistent names cleanly error "Could not find Report", ruling
 * out a general gateway problem). Something in this installation — most
 * likely a TDL add-on such as a GST e-invoice/e-way-bill tool — hooks that
 * exact report name.
 *
 * Fix: bypass "Day Book" entirely using the same ad-hoc TDL Collection
 * technique already proven for stock item costs (Export + TYPE=Collection +
 * ID, not Export Data + REPORTNAME). Verified live this returns real
 * per-voucher data — dates, ledger entries with real amounts, inventory
 * entries with real items/qty/rate.
 *
 * IMPORTANT: unlike REPORTNAME-based reports, Collections of TYPE=Voucher do
 * NOT respect SVFROMDATE/SVTODATE — verified live: a 3-day-window request
 * and a full-fiscal-year request both returned the exact same full voucher
 * count for the company. So this always fetches the company's ENTIRE
 * voucher history; the caller's upsert (ON CONFLICT) keeps repeated full
 * pulls correct and idempotent.
 *
 * BUG FIX 2: FETCHing the compound fields ALLLEDGERENTRIES.LIST and
 * ALLINVENTORYENTRIES.LIST by their bare list name pulls Tally's ENTIRE
 * native schema for every entry — dozens of empty GST/VAT/TDS/Excise/
 * e-invoice fields per ledger and inventory line that nothing here reads.
 * Verified live: this made one company's response balloon to 105 MB, and
 * repeatedly hitting Tally with a request that size eventually crashed its
 * XML gateway outright (every request afterward, for BOTH companies,
 * started failing instantly with ECONNRESET). Fixed by using TDL's
 * "list.field" dotted FETCH syntax to request only the specific sub-fields
 * this parser actually reads, instead of the whole native object.
 *
 * @param {string} companyName  Exact Tally company name
 * @returns {string}
 */
function buildAllVouchersRequest(companyName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>VoucherCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="VoucherCollection" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME, NARRATION</FETCH>
            <FETCH>ALLLEDGERENTRIES.LEDGERNAME, ALLLEDGERENTRIES.AMOUNT, ALLLEDGERENTRIES.ISPARTYLEDGER, ALLLEDGERENTRIES.ISDEEMEDPOSITIVE</FETCH>
            <FETCH>ALLINVENTORYENTRIES.STOCKITEMNAME, ALLINVENTORYENTRIES.ACTUALQTY, ALLINVENTORYENTRIES.BILLEDQTY, ALLINVENTORYENTRIES.RATE, ALLINVENTORYENTRIES.AMOUNT</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
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

/**
 * Fetch Bills Receivable (outstanding customer bills with aging).
 * EXACT same XML structure as Bills Payable:
 *   BILLFIXED { BILLDATE, BILLREF, BILLPARTY } + BILLCL + BILLDUE + BILLOVERDUE
 * parseBillsPayable() can be reused directly.
 *
 * @param {string} companyName
 * @returns {string}
 */
function buildBillsReceivableRequest(companyName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Bills Receivable</REPORTNAME>
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
 * Fetch Receipts and Payments report.
 * Gives cash Inflow, Outflow, and Net Flow by account group.
 * XML tags: DSPDISPNAME (group), RPMAINAMT (total), RPSUBAMT (sub-item)
 * positive RPMAINAMT = receipt/inflow, negative = payment/outflow
 *
 * @param {string} companyName
 * @param {string} fromDate  ISO "YYYY-MM-DD"
 * @param {string} toDate    ISO "YYYY-MM-DD"
 * @returns {string}
 */
function buildReceiptsAndPaymentsRequest(companyName, fromDate, toDate) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Receipts and Payments</REPORTNAME>
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
  buildBillsReceivableRequest,
  buildReceiptsAndPaymentsRequest,
};
