'use strict';
/**
 * debug_balance_sheet.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, asks Tally. Stop tallybackend first (pm2 stop tally-sync); the company must be open.
 *
 * The website's Current Assets (4,02,98,431 from the Trial Balance) is ~19.5 lakh below Tally's
 * Balance Sheet (4,22,48,728.47). This asks Tally for the BALANCE SHEET report itself (the one on
 * your screenshot) and prints every line it returns, so we can see whether it hands us
 * "Current Assets" with Closing Stock included, and which lines make it up.
 *
 *   node debug_balance_sheet.js 25-26
 */
require('dotenv').config();
const tallyClient = require('./tally/client');
const config      = require('./config');

const arg = process.argv[2];
if (!arg) { console.error('Usage: node debug_balance_sheet.js <company e.g. 25-26>'); process.exit(1); }
const co = config.companies.find((c) => c.name.toLowerCase().includes(arg.toLowerCase()) || c.tallyName.toLowerCase().includes(arg.toLowerCase()));
if (!co) { console.error(`No configured company matches "${arg}".`); process.exit(1); }

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tallyDate = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(d)}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]}-${y}`; };
const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#13;&#10;|&#10;/g, ' ').trim();

const request = (from, to) => `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>Balance Sheet</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>${esc(co.tallyName)}</SVCURRENTCOMPANY>
      <SVFROMDATE>${tallyDate(from)}</SVFROMDATE>
      <SVTODATE>${tallyDate(to)}</SVTODATE>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;

(async () => {
  const from = String(co.fiscalYearFrom || '2025-04-01').slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  console.log(`Company: ${co.name} (Tally "${co.tallyName}")  Balance Sheet ${from} → ${to}`);
  const raw = await tallyClient.request(request(from, to), 1);
  console.log(`reply: ${raw.length} bytes`);
  if (raw.length < 1500) { console.log('RAW REPLY:\n' + raw); return; }

  // Each line: <BSNAME><DSPACCNAME><DSPDISPNAME>name</DSPDISPNAME></DSPACCNAME></BSNAME> then <BSAMT><BSSUBAMT>..</BSSUBAMT><BSMAINAMT>..</BSMAINAMT></BSAMT>
  const blocks = [...raw.matchAll(/<BSNAME>([\s\S]*?)<\/BSNAME>\s*<BSAMT>([\s\S]*?)<\/BSAMT>/g)];
  const rows = blocks.map((m) => ({
    name: decode((m[1].match(/<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>/) || [])[1] || ''),
    sub: parseFloat((m[2].match(/<BSSUBAMT>([^<]*)<\/BSSUBAMT>/) || [])[1]) || 0,
    main: parseFloat((m[2].match(/<BSMAINAMT>([^<]*)<\/BSMAINAMT>/) || [])[1]) || 0,
  }));
  if (!rows.length) {
    console.log('Could not read BSNAME/BSAMT blocks. Tags present:');
    console.log([...new Set([...raw.matchAll(/<([A-Z][A-Z0-9.]*)[ >]/g)].map((m) => m[1]))].join(', '));
    console.log('\nFirst 1500 chars:\n' + raw.slice(0, 1500));
    return;
  }
  console.table(rows.map((r) => ({ line: r.name, sub_amount: fmt(r.sub), main_amount: fmt(r.main) })));
  const ca = rows.find((r) => /^current assets$/i.test(r.name));
  console.log(ca ? `Balance Sheet "Current Assets": main ${fmt(ca.main)}  (Tally figure on your screenshot: 4,22,48,728.47)` : 'No "Current Assets" line found.');
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; });
