'use strict';
/**
 * debug_verify_sales_officer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cost Centre -> Sales Officer was confirmed working via a synthetic offline
 * unit test (commit 79d6441), but the DATABASE shows 0/0 voucher_inventory_
 * entries.sales_officer populated for BOTH companies, even though e-way-bills
 * (deployed AFTER this fix, from the same synced-data window) is working
 * fine. This tests the REAL deployed code — buildAllVouchersRequest +
 * parseVouchers, the actual production functions, not a reimplementation —
 * against a real recent window, to tell apart two possibilities:
 *   (a) Tally isn't returning cost centre data for this size/shape of
 *       request the way it did for the earlier narrow debug test, or
 *   (b) it IS coming back in the raw XML, but parseVouchers isn't
 *       extracting it correctly in this real path.
 *
 * v2 — only tests "Wallnut 25-26" directly (not looped with 24-25). Only
 * one Tally company is reachable at a time, and 25-26 is the one with real
 * vouchers in the last 7 days — testing 24-25 in the same run just wastes
 * output on a guaranteed-0 result (its real data ends March 2025).
 *
 * Run: node debug_verify_sales_officer.js
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const parsers     = require('./tally/parsers');
const config      = require('./config');
const { todayIso, subtractDays } = require('./utils/helpers');

const co = config.companies.find((c) => !c.isHistorical) || config.companies[0];

async function tryCompany() {
  console.log(`\n=== Company: ${co.name} (Tally: "${co.tallyName}") ===`);

  const toDate = todayIso();
  const fromDate = subtractDays(toDate, 7);
  console.log(`Window: ${fromDate} -> ${toDate} (matches the real 7-day production chunk size)`);

  const xml = templates.buildAllVouchersRequest(co.tallyName, fromDate, toDate);
  const t0 = Date.now();
  const raw = await tallyClient.request(xml);
  console.log(`-> ${raw.length} bytes in ${Date.now() - t0}ms`);

  // Ground truth: is COSTCENTREALLOCATIONS.LIST present in the raw XML at all?
  const costCentreMatches = [...raw.matchAll(/<COSTCENTREALLOCATIONS\.LIST>[\s\S]*?<\/COSTCENTREALLOCATIONS\.LIST>/g)];
  console.log(`Raw XML contains ${costCentreMatches.length} <COSTCENTREALLOCATIONS.LIST> block(s)`);
  if (costCentreMatches.length > 0) {
    console.log('Sample:', costCentreMatches[0][0].replace(/\s+/g, ' ').trim());
  }

  // The Tally UI label is "Cost Centre/CLASSES" — TallyPrime has a separate
  // "Cost Centre Classes" feature (predefined groups of cost centres) that
  // may use a different XML tag than the plain Category/Cost-Centre-
  // Allocation structure confirmed earlier for company 24-25. Check broadly
  // for anything CLASS-related, and for the exact real name from the
  // screenshot appearing anywhere at all, in whatever tag wraps it.
  const classTagMatches = [...raw.matchAll(/<[A-Z]*CLASS[A-Z]*[^>]*>[\s\S]{0,80}/g)];
  console.log(`Tags containing "CLASS": ${classTagMatches.length}`);
  classTagMatches.slice(0, 5).forEach((m, i) => console.log(`  [${i}] ${m[0].replace(/\s+/g, ' ').trim()}`));

  const nameIdx = raw.indexOf('Vaibhav Pawar');
  if (nameIdx >= 0) {
    console.log('Found "Vaibhav Pawar" in raw XML — context (200 chars before/after):');
    console.log(raw.slice(Math.max(0, nameIdx - 200), nameIdx + 200).replace(/\s+/g, ' ').trim());
  } else {
    console.log('"Vaibhav Pawar" not found anywhere in this window\'s raw XML (may just not be in these 7 days).');
  }

  // Now run it through the REAL production parser.
  const parsed = tallyClient.parseXml(raw);
  const records = parsers.parseVouchers(parsed, co.id || 0);
  const withOfficer = records.filter((r) =>
    r.inventoryEntries.some((ie) => ie.salesOfficer)
  );
  console.log(`parseVouchers() returned ${records.length} vouchers, ${withOfficer.length} with a non-empty salesOfficer`);

  if (withOfficer.length > 0) {
    console.log('Sample matched record:', JSON.stringify({
      vchNo: withOfficer[0].vchNo,
      salesOfficer: withOfficer[0].inventoryEntries.find((ie) => ie.salesOfficer)?.salesOfficer,
    }));
  } else if (costCentreMatches.length > 0) {
    console.log('MISMATCH: raw XML has cost centre data but parseVouchers found none — bug is in parsing, not fetching.');
  } else {
    console.log('No cost centre data in the raw XML for this window at all — bug (if any) is upstream of parsing.');
  }
}

async function main() {
  await tryCompany().catch((err) => console.error(`  ERROR for ${co.name}: ${err.message}`));
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
