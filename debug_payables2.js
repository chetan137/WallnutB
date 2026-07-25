'use strict';
/**
 * debug_payables2.js
 * Try multiple approaches to get payables from Tally.
 * Run: node debug_payables2.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');

// Helper: build a report request
function reportXml(company, reportName) {
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
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// Helper: fetch ledgers by parent group using Collection
function collectionXml(company, parentGroup) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>List of Accounts</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// Try a collection-based payables query
function collectionPayablesXml(company) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Outstandings</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVFROMDATE>20240401</SVFROMDATE>
          <SVTODATE>20260725</SVTODATE>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

async function tryReport(company, label, xml) {
  try {
    const raw = await tallyClient.request(xml);
    const isError = raw.includes('LINEERROR') || raw.includes('Could not find');
    const status = isError ? '❌ ERROR' : `✅ ${raw.length} bytes`;
    console.log(`  [${label}] ${status}`);
    if (!isError) {
      console.log(`    Preview: ${raw.slice(0, 300).replace(/\n/g, ' ')}`);
    }
    return !isError ? raw : null;
  } catch (e) {
    console.log(`  [${label}] ❌ EXCEPTION: ${e.message}`);
    return null;
  }
}

async function main() {
  const co = config.companies[0]; // Use first company
  console.log(`\nTesting payables approaches for: ${co.tallyName}\n`);

  // Try different report names
  const reportNames = [
    'Payables',
    'Bills Payable',
    'Outstanding Payables',
    'Outstandings',
    'Outstanding Bills',
    'Bill Outstanding',
    'Creditors',
    'Sundry Creditors',
    'Outstanding Creditor',
  ];

  for (const name of reportNames) {
    await tryReport(co.tallyName, name, reportXml(co.tallyName, name));
  }

  // Also try collection-based
  console.log('\n--- Collection approach ---');
  await tryReport(co.tallyName, 'Outstandings (with dates)', collectionPayablesXml(co.tallyName));

  // Check existing ledgers table for Sundry Creditors
  console.log('\n--- From DB: Sundry Creditors ledgers (existing data) ---');
  const pool = require('./db/pool');
  const { rows } = await pool.query(`
    SELECT name, closing_balance, parent_group
    FROM ledgers
    WHERE LOWER(parent_group) LIKE '%creditor%'
       OR LOWER(parent_group) LIKE '%payable%'
    ORDER BY ABS(closing_balance) DESC
    LIMIT 20
  `);
  if (rows.length === 0) {
    console.log('  No Sundry Creditor ledgers found in DB');
    // Show all parent groups
    const { rows: groups } = await pool.query(`
      SELECT DISTINCT parent_group, COUNT(*) as cnt
      FROM ledgers WHERE company_id=1
      GROUP BY parent_group ORDER BY cnt DESC
    `);
    console.log('  All parent_groups in DB:');
    groups.forEach(g => console.log(`    ${g.parent_group} (${g.cnt} ledgers)`));
  } else {
    rows.forEach(r => console.log(`  ${r.name}: ${r.closing_balance} (${r.parent_group})`));
  }
  await pool.end();
}

main().catch(console.error);
