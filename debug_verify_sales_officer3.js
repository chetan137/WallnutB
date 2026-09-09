'use strict';
/**
 * debug_verify_sales_officer3.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this ONLY while Tally currently has the TARGET company connected/focused
 * — only one company is reachable at a time (see "bhai ek time ek company
 * possible" — never loop both in one script).
 *
 * sales_officer is STILL showing 0% populated in the DB even for real Sales
 * vouchers synced by the latest code (confirmed via hsn_code being present
 * on the same rows, which only the newest deploy can write). This runs the
 * EXACT same production fetch + parser (buildAllVouchersRequest +
 * parseVouchers) against a real date window and prints what sales_officer
 * comes out as per voucher — so it works for ANY year/company, not just one
 * hardcoded set of voucher numbers.
 *
 * Usage:
 *   node debug_verify_sales_officer3.js [companyNameContains] [fromDate] [toDate]
 *
 *   companyNameContains  substring match against configured company name/
 *                        tallyName, e.g. "25-26" or "24-25" (case-insensitive).
 *                        Defaults to the non-historical (current) company.
 *   fromDate / toDate    ISO "YYYY-MM-DD". Default: last 3 days through today.
 *
 * Examples:
 *   node debug_verify_sales_officer3.js                     # current company, last 3 days
 *   node debug_verify_sales_officer3.js 25-26                # company matching "25-26", last 3 days
 *   node debug_verify_sales_officer3.js 25-26 2026-09-01 2026-09-08
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const parsers     = require('./tally/parsers');
const config      = require('./config');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function subtractDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const [, , companyArg, fromArg, toArg] = process.argv;

const company = companyArg
  ? config.companies.find(
      (c) => c.name.toLowerCase().includes(companyArg.toLowerCase()) ||
             c.tallyName.toLowerCase().includes(companyArg.toLowerCase())
    )
  : config.companies.find((c) => !c.isHistorical) || config.companies[0];

if (!company) {
  console.error(`No configured company matches "${companyArg}". Configured companies:`);
  config.companies.forEach((c) => console.error(`  - ${c.name} (Tally: "${c.tallyName}")`));
  process.exit(1);
}

const toDate   = toArg   || todayIso();
const fromDate = fromArg || subtractDaysIso(toDate, 3);

async function main() {
  console.log(`Company: ${company.name} (Tally: "${company.tallyName}")`);
  console.log(`Window:  ${fromDate} → ${toDate}\n`);

  const xml = templates.buildAllVouchersRequest(company.tallyName, fromDate, toDate);
  const t0  = Date.now();
  const raw = await tallyClient.request(xml);
  console.log(`Fetched ${raw.length} bytes in ${Date.now() - t0}ms`);

  const parsed  = tallyClient.parseXml(raw);
  const records = parsers.parseVouchers(parsed, company.id || 0);
  const sales   = records.filter((r) => /^sales/i.test(r.vchType));

  console.log(`\n${records.length} total vouchers parsed, ${sales.length} are Sales-type.\n`);

  let anyOfficerFound = false;
  for (const r of sales) {
    const officers = [...new Set(r.inventoryEntries.map((ie) => ie.salesOfficer).filter(Boolean))];
    if (officers.length) anyOfficerFound = true;
    console.log(`${r.vchNo} | ${r.date} | party="${r.partyName}" | officer(s)="${officers.join(', ')}"`);
  }

  if (!anyOfficerFound && sales.length > 0) {
    console.log('\n⚠ No sales_officer found on ANY Sales voucher in this window.');
    console.log('Dumping FULL raw XML for the first Sales voucher for manual inspection:\n');
    const firstVchNo = sales[0].vchNo;
    // Extract just that voucher's block from the raw response for readability.
    const idx = raw.indexOf(firstVchNo);
    const start = raw.lastIndexOf('<VOUCHER', idx);
    const end   = raw.indexOf('</VOUCHER>', idx) + '</VOUCHER>'.length;
    console.log(start >= 0 && end > start ? raw.slice(start, end) : raw);
  }

  console.log('\nPaste this ENTIRE output back.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
