'use strict';
/**
 * check_ledger_contact_fields.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY. Finds out whether Tally actually gives us address / pincode / country /
 * mailing name / GST registration type / phone / email / contact person for ledgers,
 * and under which XML tag names, BEFORE we add columns to the `ledgers` table.
 *
 * It asks Tally for the ledgers in two ways and, for each, prints
 *   1. one real party ledger (Sundry Debtors with a GSTIN) so the tag names are visible,
 *   2. for every wanted field: the tag name(s) found and how many party ledgers have a value.
 *
 * ⚠️ Tally is queried: stop tallybackend first (pm2 stop tally-sync). Only the company that
 *    is open in Tally can be asked (one company at a time).
 *
 * Usage (in the tallybackend folder):
 *   node check_ledger_contact_fields.js 25-26
 */

require('dotenv').config();
const tallyClient = require('./tally/client');
const templates   = require('./tally/xmlTemplates');
const config      = require('./config');

const arg = process.argv[2];
if (!arg) { console.error('Usage: node check_ledger_contact_fields.js <company e.g. 25-26>'); process.exit(1); }
const co = config.companies.find((c) => c.name.toLowerCase().includes(arg.toLowerCase()) ||
                                        c.tallyName.toLowerCase().includes(arg.toLowerCase()));
if (!co) { console.error(`No configured company matches "${arg}".`); process.exit(1); }

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Wanted field -> tag names Tally may use for it (first non-empty wins).
const WANTED = {
  address:               ['ADDRESS'],
  pincode:               ['PINCODE'],
  country:               ['COUNTRYNAME', 'COUNTRYOFRESIDENCE', 'COUNTRY'],
  mailing_name:          ['MAILINGNAME'],
  gst_registration_type: ['GSTREGISTRATIONTYPE'],
  phone:                 ['LEDGERPHONE', 'LEDGERMOBILE', 'PHONENUMBER', 'MOBILENUMBER'],
  email:                 ['EMAIL', 'EMAILID'],
  contact_person:        ['LEDGERCONTACT', 'CONTACTPERSON'],
  state:                 ['STATENAME', 'LEDSTATENAME', 'STATE'],
  gst_no:                ['PARTYGSTIN', 'GSTIN', 'GSTREGISTRATIONNUMBER'],
};

function collectionRequest() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>WnLedgerContacts</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${esc(co.tallyName)}</SVCURRENTCOMPANY>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="WnLedgerContacts" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes">
        <TYPE>Ledger</TYPE>
        <FETCH>Name, Parent, Address, PinCode, CountryName, MailingName, GSTRegistrationType, LedgerPhone, LedgerMobile, Email, LedgerContact, LedStateName, StateName, PartyGSTIN, LedMailingDetails, LedGSTRegDetails</FETCH>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;
}

const first = (block, tag) => { const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`)); return m ? m[1].trim() : ''; };
const all   = (block, tag) => [...block.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => m[1].trim()).filter(Boolean);
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;&#10;|&#10;/g, ' ');

function analyse(label, raw) {
  console.log('\n' + '═'.repeat(78));
  console.log(`${label}: ${(raw.length / 1024).toFixed(0)} KB`);
  const blocks = [...raw.matchAll(/<LEDGER[ >][\s\S]*?<\/LEDGER>/g)].map((m) => m[0]);
  console.log(`ledger blocks: ${blocks.length}`);
  if (!blocks.length) { console.log(raw.slice(0, 600)); return; }

  const parties = blocks.filter((b) => /<PARENT[^>]*>\s*Sundry Debtors\s*</i.test(b));
  console.log(`party ledgers (Sundry Debtors): ${parties.length}`);
  const sample = parties.find((b) => /<(PARTYGSTIN|GSTIN)[^>]*>[^<]+</.test(b) && /<PINCODE[^>]*>[^<]+</.test(b)) ||
                 parties.find((b) => /<PINCODE[^>]*>[^<]+</.test(b)) || parties[0] || blocks[0];
  const tags = [...new Set([...sample.matchAll(/<([A-Z][A-Za-z0-9_.]*)[\s>]/g)].map((m) => m[1]))];
  console.log('\nTags inside one sample party ledger:\n  ' + tags.join(', '));

  console.log('\nField coverage over party ledgers (value present / total):');
  const rows = [];
  for (const [field, names] of Object.entries(WANTED)) {
    let used = '-';
    let count = 0;
    for (const b of parties) {
      for (const n of names) {
        const vals = all(b, n);
        if (vals.length) { count++; if (used === '-') used = n; break; }
      }
    }
    rows.push({ field, tag_used: used, with_value: count, of: parties.length, pct: parties.length ? `${Math.round((100 * count) / parties.length)}%` : '-' });
  }
  console.table(rows);

  const s = sample;
  console.log('Sample values:', JSON.stringify({
    name: decode(first(s, 'NAME') || (s.match(/NAME="([^"]*)"/) || [])[1] || ''),
    address: all(s, 'ADDRESS').map(decode).join(', '), pincode: first(s, 'PINCODE'),
    country: first(s, 'COUNTRYNAME'), mailing_name: decode(first(s, 'MAILINGNAME')),
    gst_registration_type: first(s, 'GSTREGISTRATIONTYPE'), email: first(s, 'EMAIL'),
    state: first(s, 'STATENAME') || first(s, 'LEDSTATENAME'),
  }, null, 2));
  const anyState = parties.filter((b) => /\x04 Any|&#4; Any/.test(b)).length;
  console.log(`party ledgers whose state is "\\x04 Any": ${anyState}`);
}

async function main() {
  console.log('⚠️  tallybackend should be STOPPED (pm2 stop tally-sync) and the company open in Tally.');
  console.log(`Company: ${co.name} (Tally: "${co.tallyName}")`);

  try {
    const raw1 = await tallyClient.request(collectionRequest());
    analyse('A) Ledger Collection with explicit FETCH', raw1);
  } catch (e) { console.log('\nA) Collection request FAILED:', e.message); }

  try {
    const from = (co.fiscalYearFrom || '2025-04-01');
    const to   = new Date().toISOString().slice(0, 10);
    const raw2 = await tallyClient.request(templates.buildLedgerMasterRequest(co.tallyName, from, to));
    analyse('B) List of Accounts (what the sync reads today)', raw2);
  } catch (e) { console.log('\nB) List of Accounts request FAILED:', e.message); }

  console.log('\nHow to read: a field with tag_used "-" or 0 ledgers is NOT available from that request.');
  console.log('Paste this ENTIRE output back (do it for 24-25, 25-26 and 26-27).');
}

main().catch((err) => { console.error('FATAL:', err.message); console.error(err.stack); process.exitCode = 1; });
