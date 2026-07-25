'use strict';
/**
 * debug_pl_report.js
 * Tests the Profit and Loss report for the 2024-25 historical company.
 * This gets P&L data that Trial Balance doesn't show for closed years.
 * Run: node debug_pl_report.js
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');

const COMPANY_24_25 = 'Wallnut Building Solutions India Pvt Ltd-2024-25';
const COMPANY_25_26 = 'Wallnut 25-26';
const FROM = '2024-04-01';
const TO   = '2025-03-31';

async function fetchAndShow(company, from, to) {
  console.log(`\n=== P&L for ${company} (${from} → ${to}) ===`);
  const xml = templates.buildProfitAndLossRequest(company, from, to);
  const raw = await tallyClient.request(xml);
  console.log(`Response: ${raw.length} bytes`);

  // Show first 4000 chars of raw XML
  console.log('\n--- Raw XML (first 4000 chars) ---');
  console.log(raw.slice(0, 4000));

  // Try same DSP parsing used in Trial Balance
  const names = [...raw.matchAll(/<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>/g)].map(m => m[1].trim());
  const drs   = [...raw.matchAll(/<DSPCLDRAMTA>([^<]*)<\/DSPCLDRAMTA>/g)].map(m => parseFloat(m[1]) || 0);
  const crs   = [...raw.matchAll(/<DSPCLCRAMTA>([^<]*)<\/DSPCLCRAMTA>/g)].map(m => parseFloat(m[1]) || 0);

  console.log(`\n--- Parsed groups (${names.length}) ---`);
  for (let i = 0; i < names.length; i++) {
    const net = (crs[i] || 0) + (drs[i] || 0);
    const label = net > 0 ? `CR ${net.toLocaleString('en-IN')}` : `DR ${Math.abs(net).toLocaleString('en-IN')}`;
    console.log(`  ${names[i].padEnd(40)} ${label}`);
  }
}

async function main() {
  await fetchAndShow(COMPANY_24_25, FROM, TO);
}

main().catch(console.error);
