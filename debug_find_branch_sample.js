'use strict';
/**
 * debug_find_branch_sample.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, Tally XML only (no Postgres). Only EXPORTs from Tally.
 *
 * Goal: find out HOW "Branch Transfer" and "Sample" invoices look in Tally's
 * raw XML, so they can be excluded from Sales. Checks every place the signal
 * could live:
 *   STEP A  Voucher TYPE masters  (custom type like "Sales-Branch Transfer"?)
 *   STEP B  Ledger masters whose name/group matches (e.g. "Branch Transfer - Sales")
 *   STEP C  Real vouchers in a SMALL date window (same ad-hoc Voucher
 *           Collection + literal-date FILTER shape as debug_godown_test.js /
 *           production buildAllVouchersRequest): voucher type, party,
 *           narration, every ledger line name, stock items, cost centres —
 *           flags any that contain branch / transfer / sample / demo / free.
 *
 * Same rules as the other debug scripts:
 *   • Stop tallybackend first (pm2 stop tally-sync) — two things hitting
 *     Tally's single-request XML server at once can cross-wire responses.
 *   • Only ONE company is reachable at a time — run it for whichever company
 *     Tally currently has focused.
 *   • Keep the window small. A full year with ledger entries has crashed
 *     Tally before (see xmlTemplates.js BUG FIX 3/4).
 *
 * Usage:
 *   node debug_find_branch_sample.js [companyNameContains] [fromDate] [toDate]
 *     defaults: current (non-historical) company, last 15 days → today
 *   node debug_find_branch_sample.js 25-26 2026-09-01 2026-09-15 > branch_sample_report.txt
 *
 * Then paste the output (or file) back.
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const config      = require('./config');
const { todayIso, subtractDays, escapeXml } = require('./utils/helpers');

const KEYWORDS = ['branch', 'transfer', 'sample', 'sampl', 'demo', 'free'];
const kwRe = new RegExp(KEYWORDS.join('|'), 'i');

const [, , companyArg, fromArg, toArg] = process.argv;
const co = companyArg
  ? config.companies.find((c) => c.name.toLowerCase().includes(companyArg.toLowerCase()) ||
                                 c.tallyName.toLowerCase().includes(companyArg.toLowerCase()))
  : config.companies.find((c) => !c.isHistorical) || config.companies[0];

if (!co) {
  console.error(`No configured company matches "${companyArg}". Configured companies:`);
  config.companies.forEach((c) => console.error(`  - ${c.name} (Tally: "${c.tallyName}")`));
  process.exit(1);
}

const toDate   = toArg   || todayIso();
const fromDate = fromArg || subtractDays(toDate, 15);

function section(title) {
  console.log('\n' + '═'.repeat(78));
  console.log(title);
  console.log('═'.repeat(78));
}

async function safely(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`\n❌ ${label} FAILED: ${err.message}`);
  }
}

const pause = () => new Promise((r) => setTimeout(r, 1000));

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return m ? m[1].trim() : '';
}
function tagAll(block, name) {
  return [...block.matchAll(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'g'))]
    .map((m) => m[1].trim()).filter(Boolean);
}
function bump(map, key) { map[key] = (map[key] || 0) + 1; }
function printCounts(title, map, limit = 40) {
  console.log(`\n── ${title}  (${Object.keys(map).length} distinct)`);
  Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, limit)
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(5)} × ${k || '(blank)'}`));
}

// Ad-hoc master collection — same Export + TYPE=Collection + ID shape as the
// proven working StockItem / Voucher collections.
function buildMasterCollectionXml(type, fetch) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>Dbg${type}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(co.tallyName)}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="Dbg${type}" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
            <TYPE>${type}</TYPE>
            <FETCH>${fetch}</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

async function main() {
  console.log('⚠️  tallybackend (pm2 tally-sync / node index.js) should be STOPPED right now.');
  console.log(`Company:  ${co.name} (Tally: "${co.tallyName}")`);
  console.log(`Window:   ${fromDate} → ${toDate}`);
  console.log(`Keywords: ${KEYWORDS.join(', ')}`);

  // ── STEP A — voucher type masters ────────────────────────────────────────
  await safely('STEP A', async () => {
    section('STEP A — Voucher TYPE masters (name + parent): is Branch Transfer / Sample its own type?');
    const raw = await tallyClient.request(buildMasterCollectionXml('VoucherType', 'Name, Parent'));
    const blocks = [...raw.matchAll(/<VOUCHERTYPE[ >][\s\S]*?<\/VOUCHERTYPE>/g)].map((m) => m[0]);
    console.log(`  → ${raw.length} bytes | ${blocks.length} voucher types`);
    for (const b of blocks) {
      const name   = (b.match(/\sNAME="([^"]*)"/) || [])[1] || tag(b, 'NAME');
      const parent = tag(b, 'PARENT');
      console.log(`  ${name.padEnd(42)} parent: ${parent}${kwRe.test(name) ? '   ◀◀ KEYWORD' : ''}`);
    }
    if (!blocks.length) console.log('  First 1500 chars:\n' + raw.slice(0, 1500));
  });
  await pause();

  // ── STEP B — ledger masters ──────────────────────────────────────────────
  await safely('STEP B', async () => {
    section('STEP B — LEDGER masters whose name or group matches a keyword');
    const raw = await tallyClient.request(buildMasterCollectionXml('Ledger', 'Name, Parent'));
    const blocks = [...raw.matchAll(/<LEDGER[ >][\s\S]*?<\/LEDGER>/g)].map((m) => m[0]);
    console.log(`  → ${raw.length} bytes | ${blocks.length} ledgers`);
    const groups = {};
    const hits = [];
    for (const b of blocks) {
      const name   = (b.match(/\sNAME="([^"]*)"/) || [])[1] || tag(b, 'NAME');
      const parent = tag(b, 'PARENT');
      bump(groups, parent);
      if (kwRe.test(name) || kwRe.test(parent)) hits.push({ name, parent });
    }
    console.log(`\n  ${hits.length} ledgers match a keyword:`);
    hits.slice(0, 80).forEach((h) => console.log(`    ${h.name.padEnd(46)} group: ${h.parent}`));
    printCounts('All ledger groups (look for a Branch / Sample / Sales sub-group)', groups, 40);
    if (!blocks.length) console.log('  First 1500 chars:\n' + raw.slice(0, 1500));
  });
  await pause();

  // ── STEP C — real vouchers, production request, small window ─────────────
  await safely('STEP C', async () => {
    section(`STEP C — Vouchers ${fromDate} → ${toDate} via production buildAllVouchersRequest()`);
    const t0  = Date.now();
    const raw = await tallyClient.request(templates.buildAllVouchersRequest(co.tallyName, fromDate, toDate));
    const blocks = [...raw.matchAll(/<VOUCHER[ >][\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]).filter((b) => b.length > 30);
    console.log(`  → ${raw.length} bytes in ${Date.now() - t0}ms | ${blocks.length} voucher blocks`);

    const byType = {}, byParent = {}, salesLedgers = {}, costCentres = {}, hitFields = {};
    const hits = [];

    for (const b of blocks) {
      const typeName = tag(b, 'VOUCHERTYPENAME');
      // VCHTYPE attribute on <VOUCHER ...> is the PARENT type — a custom type
      // like "Sales-Sample" would show typeName="Sales-Sample" but VCHTYPE="Sales".
      const parent   = (b.match(/<VOUCHER[^>]*\sVCHTYPE="([^"]*)"/) || [])[1] || '';
      const party    = tag(b, 'PARTYLEDGERNAME');
      const narr     = tag(b, 'NARRATION');
      const ledgers  = [...new Set(tagAll(b, 'LEDGERNAME'))];
      const items    = [...new Set(tagAll(b, 'STOCKITEMNAME'))];
      const ccs      = [...b.matchAll(/<COSTCENTREALLOCATIONS\.LIST>[\s\S]*?<NAME>([^<]*)<\/NAME>/g)]
                         .map((m) => m[1].trim());

      bump(byType, typeName);
      bump(byParent, parent);
      if (/^sales|^credit note/i.test(typeName)) {
        ledgers.forEach((l) => { if (l !== party) bump(salesLedgers, l); });
        ccs.forEach((c) => bump(costCentres, c));
      }

      const fields = { vchType: typeName, parentType: parent, party, narration: narr,
                       ledgers: ledgers.join(' | '), items: items.join(' | '), costCentres: ccs.join(' | ') };
      const matched = Object.entries(fields).filter(([, v]) => kwRe.test(v)).map(([k]) => k);
      if (matched.length) {
        matched.forEach((f) => bump(hitFields, f));
        hits.push({
          vchNo: tag(b, 'VOUCHERNUMBER'), date: tag(b, 'DATE'), vchType: typeName, parentType: parent,
          party, narration: narr.slice(0, 80), ledgers: fields.ledgers, costCentres: fields.costCentres,
          matchedIn: matched.join(','),
        });
      }
    }

    printCounts('VOUCHERTYPENAME (type shown in Tally)', byType);
    printCounts('VCHTYPE attribute (PARENT type — custom types roll up here)', byParent);
    printCounts('Non-party ledger lines inside Sales/Credit Note vouchers (sales account names)', salesLedgers, 50);
    printCounts('Cost centres inside Sales/Credit Note vouchers', costCentres, 30);

    console.log(`\n── ${hits.length} vouchers contain a keyword somewhere`);
    printCounts('Which FIELD the keyword was found in', hitFields);
    console.log('\nFirst 25 matching vouchers:');
    hits.slice(0, 25).forEach((h) => console.log('  ' + JSON.stringify(h)));

    // One full raw voucher per keyword, so the exact tag layout is visible.
    for (const kw of ['branch', 'sample']) {
      const re = new RegExp(kw, 'i');
      const ex = blocks.find((b) => re.test(b));
      if (ex) {
        console.log(`\n── Full raw XML of ONE voucher containing "${kw}" (first 4000 chars):`);
        console.log(ex.slice(0, 4000));
      } else {
        console.log(`\n── No voucher in this window contains "${kw}" — rerun with a wider/different window.`);
      }
    }
  });

  console.log('\nVERDICT: look at STEP A/B/C for where "Branch Transfer" and "Sample" actually appear —');
  console.log('         voucher type, sales-ledger name, party name, or narration — that is the field');
  console.log('         the dashboard exclusion should key on.');
  console.log('\nPaste this ENTIRE output back.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});
