'use strict';
/**
 * debug_remaining_data.js
 * Check Bills Receivable + Cash Flow report structures from Tally.
 * Run: node debug_remaining_data.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');

function xml(company, reportName, extras = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${reportName}</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          ${extras}
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

async function probe(label, company, reportName, extras = '') {
  try {
    const raw = await tallyClient.request(xml(company, reportName, extras));
    const isErr = raw.includes('LINEERROR') || raw.length < 50;
    const size = `${raw.length} bytes`;
    if (isErr) {
      console.log(`  ❌ [${label}] ERROR`);
    } else {
      // Extract unique tag names
      const tags = [...new Set([...raw.matchAll(/<([A-Z][A-Z0-9_.]*)[>\s/]/g)].map(m => m[1]))];
      console.log(`  ✅ [${label}] ${size} | tags: ${tags.join(', ')}`);
      console.log(`     Preview: ${raw.slice(0, 400).replace(/\n/g, ' ')}`);
    }
    return isErr ? null : raw;
  } catch(e) {
    console.log(`  ❌ [${label}] EXCEPTION: ${e.message}`);
    return null;
  }
}

async function main() {
  const co = config.companies[0];  // 2024-25 historical
  console.log(`\nCompany: ${co.tallyName}\n`);

  console.log('=== 1. RECEIVABLES AGING (Bills Receivable) ===');
  await probe('Bills Receivable',    co.tallyName, 'Bills Receivable');
  await probe('Outstanding Receivables', co.tallyName, 'Outstanding Receivables');
  await probe('Receivables',         co.tallyName, 'Receivables');
  await probe('Bills Receivable Report', co.tallyName, 'Bills Receivable Report');

  console.log('\n=== 2. CASH FLOW ===');
  const dates = '<SVFROMDATE>20240401</SVFROMDATE><SVTODATE>20250331</SVTODATE>';
  await probe('Cash Flow',           co.tallyName, 'Cash Flow', dates);
  await probe('Cash Flow Summary',   co.tallyName, 'Cash Flow Summary', dates);
  await probe('Fund Flow',           co.tallyName, 'Fund Flow', dates);
  await probe('Receipts and Payments', co.tallyName, 'Receipts and Payments', dates);
  await probe('Funds Flow',          co.tallyName, 'Funds Flow', dates);
  await probe('Cash/Fund Flow',      co.tallyName, 'Cash/Fund Flow', dates);

  console.log('\n=== 3. BALANCE SHEET (for sub-groups) ===');
  await probe('Balance Sheet',       co.tallyName, 'Balance Sheet', dates);

  console.log('\n=== From DB: Inventory summary (already in voucher_inventory_entries) ===');
  const pool = require('./db/pool');
  const { rows } = await pool.query(`
    SELECT
      SUM(CASE WHEN v.vch_type LIKE '%Sales%' OR v.vch_type LIKE '%Credit%' THEN ABS(vie.amount) END) AS outward_value,
      SUM(CASE WHEN v.vch_type LIKE '%Purchase%' THEN ABS(vie.amount) END)                           AS inward_value,
      SUM(CASE WHEN vie.quantity > 0 THEN vie.quantity END)                                          AS inward_qty,
      SUM(CASE WHEN vie.quantity < 0 THEN ABS(vie.quantity) END)                                     AS outward_qty,
      COUNT(*) AS total_entries
    FROM voucher_inventory_entries vie
    JOIN vouchers v ON v.id = vie.voucher_id
    WHERE v.company_id = 1
  `);
  const r = rows[0];
  console.log(`  Inward value:   ₹${Number(r.inward_value||0).toLocaleString('en-IN')}`);
  console.log(`  Outward value:  ₹${Number(r.outward_value||0).toLocaleString('en-IN')}`);
  console.log(`  Inward qty:     ${r.inward_qty}`);
  console.log(`  Outward qty:    ${r.outward_qty}`);
  console.log(`  Total entries:  ${r.total_entries}`);
  await pool.end();
}

main().catch(console.error);
