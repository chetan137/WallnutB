'use strict';
/**
 * debug_voucher_register_parse.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY. One-day check that the NEW sync path (Voucher Register report →
 * tallyClient.parseXml → parsers.parseVouchers) really produces usable rows,
 * BEFORE letting pm2 backfill 18 months with it.
 *
 * Prints: response size, the parsed XML's top-level structure, how many
 * records the real parser extracted, how many fall inside the day, and a
 * breakdown (types, with inventory, with sales officer, ledger entries) plus
 * a few sample sales rows. Also checks the sales-ledger totals of that day.
 *
 * Same rules as the other debug scripts: stop tallybackend first
 * (pm2 stop tally-sync), only the focused company is reachable. ONE day only —
 * a register response is ~70 KB per voucher.
 *
 * Usage:
 *   node debug_voucher_register_parse_2526.js [YYYY-MM-DD]   (default 2026-09-02)
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const parsers     = require('./tally/parsers');
const config      = require('./config');

const [, , companyArg, dayArg] = process.argv;
const co = companyArg
  ? config.companies.find((c) => c.name.toLowerCase().includes(companyArg.toLowerCase()) ||
                                 c.tallyName.toLowerCase().includes(companyArg.toLowerCase()))
  : config.companies.find((c) => !c.isHistorical) || config.companies[0];

if (!co) {
  console.error(`No configured company matches "${companyArg}".`);
  process.exit(1);
}
const day = dayArg || '2026-09-02';

function counts(arr) {
  const m = {};
  arr.forEach((k) => { m[k || '(blank)'] = (m[k || '(blank)'] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

async function main() {
  console.log('⚠️  tallybackend (pm2 tally-sync / node index.js) should be STOPPED right now.');
  console.log(`Company: ${co.name} (Tally: "${co.tallyName}") | Day: ${day}\n`);

  const t0  = Date.now();
  const raw = await tallyClient.request(templates.buildVoucherRegisterRequest(co.tallyName, day, day));
  console.log(`Response: ${(raw.length / 1024 / 1024).toFixed(2)} MB in ${Date.now() - t0}ms | <VOUCHER tags: ${(raw.match(/<VOUCHER[ >]/g) || []).length}`);

  const parsed = tallyClient.parseXml(raw);
  const env  = parsed.ENVELOPE || {};
  const body = env.BODY || {};
  console.log('ENVELOPE keys:', Object.keys(env).join(', '));
  console.log('BODY keys:    ', Object.keys(body).join(', '));
  for (const k of Object.keys(body)) {
    if (body[k] && typeof body[k] === 'object') console.log(`  BODY.${k} keys:`, Object.keys(body[k]).join(', '));
  }

  const records = parsers.parseVouchers(parsed, 0);
  const inDay   = records.filter((r) => r.date === day);
  console.log(`\nParsed by the REAL parser: ${records.length} records | dated ${day}: ${inDay.length}`);
  if (!records.length) {
    console.log('❌ Parser found nothing — the response shape is not one parsers.js understands.');
    console.log('First 2500 chars of the raw response:\n' + raw.slice(0, 2500));
    return;
  }

  console.log('\nVoucher types:');
  counts(records.map((r) => r.vchType)).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)} × ${k}`));

  const sales = records.filter((r) => /^sales|^credit note/i.test(r.vchType));
  const withInv  = sales.filter((r) => r.inventoryEntries.length > 0);
  const withOff  = sales.filter((r) => r.inventoryEntries.some((i) => i.salesOfficer));
  const withLed  = records.filter((r) => r.ledgerEntries.length > 0);
  console.log(`\nSales/Credit-Note vouchers: ${sales.length} | with inventory lines: ${withInv.length} | with sales officer: ${withOff.length}`);
  console.log(`All vouchers with ledger entries: ${withLed.length}/${records.length}`);

  const salesLedgers = {};
  sales.forEach((r) => r.ledgerEntries.filter((l) => !l.isParty).forEach((l) => {
    salesLedgers[l.ledgerName] = (salesLedgers[l.ledgerName] || 0) + 1;
  }));
  console.log('\nNon-party ledgers in Sales/Credit-Note vouchers:');
  Object.entries(salesLedgers).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)} × ${k}`));

  console.log('\nSample sales rows:');
  sales.slice(0, 4).forEach((r) => console.log('  ' + JSON.stringify({
    vchNo: r.vchNo, date: r.date, type: r.vchType, party: r.partyName, total: r.totalAmount,
    ledgers: r.ledgerEntries.map((l) => l.ledgerName),
    items: r.inventoryEntries.map((i) => ({ item: i.itemName, qty: i.quantity, amt: i.amount, officer: i.salesOfficer })),
  })));

  console.log('\nVERDICT: parsed > 0, dated inside the day, sales have inventory lines/officers = the');
  console.log('         Voucher Register path is safe for the sync. Paste this ENTIRE output back.');
}

main().catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); });
