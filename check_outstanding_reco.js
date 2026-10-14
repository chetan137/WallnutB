'use strict';
/**
 * check_outstanding_reco.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY. Answers the Outstanding reconciliation checklist from Tally (live) and the DB, and writes
 * a report with the date and time in its file name:
 *     outstanding_check_<YYYYMMDD_HHMM>.txt   (all answers)
 *     outstanding_bills_<YYYYMMDD_HHMM>.csv   (every pending bill Tally returned)
 * Nothing in Tally or the DB is changed.
 *
 *   1  Receivable total (Tally "Bills Receivable", as on today)
 *   2  Payable total (Tally "Bills Payable")
 *   3  Advances (credit entries in the receivables list), incl. INDORA / CORE LOGISTIC / Maa Annapurna
 *   4  Overdue days of a few bills (party, bill no, days)
 *   5  Nuvoni Corp LLP, bill WBSI-003/24-25: how many vouchers, which type
 *   6  Party-wise pending: CEE KE MATERIALS, MODERN CERAMICS, ESS JAY EMPORIUM, Atul Ltd.
 *   7  Old bills: Srinivasan & Co, Einstek - Engineering Insulation Solutions
 *   8  Cleared bills: WBSIMK-478/24-25 and WBSIMK-516/24-25 (ESS JAY EMPORIUM)
 *
 * ⚠️ Tally is queried: stop tallybackend first (pm2 stop tally-sync) and open the company in Tally.
 *    DB-only answers (5, part of 6 and 8) are still printed if Tally cannot be reached.
 *
 * Usage (tallybackend folder):   node check_outstanding_reco.js 25-26
 */
require('dotenv').config();
const fs = require('fs');
const pool = require('./db/pool');
const tallyClient = require('./tally/client');
const templates = require('./tally/xmlTemplates');
const config = require('./config');
const { buildSalesRecordsSql } = require('./utils/salesRecordsSql');

const arg = process.argv[2];
if (!arg) { console.error('Usage: node check_outstanding_reco.js <company e.g. 25-26>'); process.exit(1); }
const co = config.companies.find((c) => c.name.toLowerCase().includes(arg.toLowerCase()) || c.tallyName.toLowerCase().includes(arg.toLowerCase()));
if (!co) { console.error(`No configured company matches "${arg}".`); process.exit(1); }

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
const TXT = `outstanding_check_${stamp}.txt`;
const CSV = `outstanding_bills_${stamp}.csv`;

const out = [];
const say = (s = '') => { console.log(s); out.push(s); };
const table = (rows) => { if (!rows.length) { say('   (none)'); return; } console.table(rows); out.push(tableText(rows)); };
const tableText = (rows) => {
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => '   ' + vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  return [line(cols), line(w.map((x) => '-'.repeat(x))), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
};
const inr = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lakh = (n) => `${(Number(n || 0) / 100000).toFixed(2)} L`;

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const tallyDate = (s) => {
  const p = String(s || '').trim().split('-');
  if (p.length !== 3 || !MONTHS[p[1]]) return '';
  let y = parseInt(p[2], 10); if (y < 100) y += 2000;
  return `${y}-${pad(MONTHS[p[1]])}-${pad(parseInt(p[0], 10))}`;
};
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();

/** Every bill block of a Bills Receivable / Payable reply, signs kept (Tally: receivable = negative). */
function parseBills(raw) {
  const re = /<BILLFIXED>[\s\S]*?<BILLDATE>([^<]*)<\/BILLDATE>[\s\S]*?<BILLREF>([^<]*)<\/BILLREF>[\s\S]*?<BILLPARTY>([^<]*)<\/BILLPARTY>[\s\S]*?<\/BILLFIXED>\s*<BILLCL>([^<]*)<\/BILLCL>\s*<BILLDUE>([^<]*)<\/BILLDUE>\s*<BILLOVERDUE>([^<]*)<\/BILLOVERDUE>/g;
  const bills = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    bills.push({ party: unesc(m[3]), ref: unesc(m[2]), billDate: tallyDate(m[1]), amount: parseFloat(m[4]) || 0, dueDate: tallyDate(m[5]), overdue: parseInt(m[6], 10) || 0 });
  }
  return bills;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const withDates = (report) => {
  const from = String(co.fiscalYearFrom || '2025-04-01').slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const d = (iso) => { const [y, m, dd] = iso.split('-'); return `${Number(dd)}-${Object.keys(MONTHS)[Number(m) - 1]}-${y}`; };
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC>
  <REPORTNAME>${report}</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${esc(co.tallyName)}</SVCURRENTCOMPANY><SVFROMDATE>${d(from)}</SVFROMDATE><SVTODATE>${d(to)}</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
};

async function fetchBills(label, variants) {
  for (const [name, xml] of variants) {
    try {
      const raw = await tallyClient.request(xml, 1);
      const bills = parseBills(raw);
      say(`   ${label}: request "${name}" -> ${raw.length} bytes, ${bills.length} bills`);
      if (bills.length) return { bills, variant: name };
      if (raw.length < 1500) say('   reply was: ' + raw.replace(/\s+/g, ' ').slice(0, 300));
    } catch (e) {
      say(`   ${label}: request "${name}" failed: ${e.message || e.code || '(no message)'} ${e.code ? `[${e.code}]` : ''}`);
    }
  }
  return { bills: [], variant: null };
}

const findParty = (bills, needle) => bills.filter((b) => b.party.toLowerCase().includes(needle.toLowerCase()));

(async () => {
  say(`OUTSTANDING CHECK   as on ${now.toLocaleString('en-IN')}   company: ${co.name} (Tally "${co.tallyName}")`);
  say('═'.repeat(100));

  // ── Tally: receivables + payables ─────────────────────────────────────────
  say('\nTALLY (live, read-only)');
  const rcv = await fetchBills('Bills Receivable', [
    ['as in the sync', templates.buildBillsReceivableRequest(co.tallyName)],
    ['with this year dates', withDates('Bills Receivable')],
  ]);
  const pay = await fetchBills('Bills Payable', [
    ['with this year dates', withDates('Bills Payable')],
    ['without dates', withDates('Bills Payable').replace(/<SVFROMDATE>[^<]*<\/SVFROMDATE><SVTODATE>[^<]*<\/SVTODATE>/, '')],
  ]);

  const R = rcv.bills;   // receivable = negative, advance (Cr) = positive
  const P = pay.bills;   // payable = positive, advance paid (Dr) = negative

  // 1
  say('\n1) RECEIVABLE TOTAL (Tally Bills Receivable, as on today)');
  if (R.length) {
    const recv = R.filter((b) => b.amount < 0), adv = R.filter((b) => b.amount > 0);
    const recvSum = -recv.reduce((s, b) => s + b.amount, 0), advSum = adv.reduce((s, b) => s + b.amount, 0);
    say(`   Pending receivable bills : ${recv.length}   total ${inr(recvSum)}  (${lakh(recvSum)})`);
    say(`   Credit (advance) entries : ${adv.length}   total ${inr(advSum)}  (${lakh(advSum)})`);
    say(`   NET receivable           : ${inr(recvSum - advSum)}  (${lakh(recvSum - advSum)})   <- compare with Tally Grand Total (~2.39 Cr expected)`);
  } else say('   Could not read Bills Receivable from Tally (see the messages above).');

  // 2
  say('\n2) PAYABLE TOTAL (Tally Bills Payable, as on today)');
  if (P.length) {
    const pp = P.filter((b) => b.amount > 0), ad = P.filter((b) => b.amount < 0);
    const ps = pp.reduce((s, b) => s + b.amount, 0), as = -ad.reduce((s, b) => s + b.amount, 0);
    say(`   Pending payable bills    : ${pp.length}   total ${inr(ps)}  (${lakh(ps)})`);
    say(`   Debit (advance paid)     : ${ad.length}   total ${inr(as)}  (${lakh(as)})`);
    say(`   NET payable              : ${inr(ps - as)}  (${lakh(ps - as)})   <- compare with Tally (~1.14 Cr expected)`);
  } else say('   Could not read Bills Payable from Tally (see the messages above).');

  // 3
  say('\n3) ADVANCES (Cr / On Account) in the receivables list');
  const adv = R.filter((b) => b.amount > 0);
  table(adv.map((b) => ({ party: b.party, ref: b.ref, bill_date: b.billDate, amount_cr: inr(b.amount) })));
  say('   The three parties you named, in receivables AND payables:');
  const named = ['INDORA ASSOCIATES', 'CORE LOGISTIC PRIVATE LIMITED', 'Maa Annapurna Transport Agency'];
  table(named.flatMap((n) => [
    ...findParty(R, n).map((b) => ({ party: b.party, list: 'receivables', ref: b.ref, bill_date: b.billDate, amount: inr(b.amount), side: b.amount > 0 ? 'Cr (advance)' : 'Dr' })),
    ...findParty(P, n).map((b) => ({ party: b.party, list: 'payables', ref: b.ref, bill_date: b.billDate, amount: inr(b.amount), side: b.amount < 0 ? 'Dr (advance paid)' : 'Cr' })),
  ]));

  // 4
  say('\n4) OVERDUE DAYS (receivables)');
  const dueBills = R.filter((b) => b.amount < 0);
  say('   Largest bills:');
  table([...dueBills].sort((a, b) => a.amount - b.amount).slice(0, 4).map((b) => ({ party: b.party, bill_no: b.ref, bill_date: b.billDate, due_date: b.dueDate, overdue_days: b.overdue, amount: inr(-b.amount) })));
  say('   Most overdue:');
  table([...dueBills].sort((a, b) => b.overdue - a.overdue).slice(0, 3).map((b) => ({ party: b.party, bill_no: b.ref, bill_date: b.billDate, due_date: b.dueDate, overdue_days: b.overdue, amount: inr(-b.amount) })));

  // ── DB ───────────────────────────────────────────────────────────────────
  say('\nDATABASE');
  // 5
  say('\n5) NUVONI CORP LLP, bill WBSI-003/24-25 (18-Apr-2024)');
  const { rows: nv } = await pool.query(
    `SELECT c.name AS company, v.vch_no, v.vch_type, v.date::text AS date, v.party_name, v.total_amount, v.is_cancelled
     FROM vouchers v JOIN companies c ON c.id = v.company_id
     WHERE v.vch_no ILIKE '%WBSI-003/24-25%' OR (v.party_name ILIKE '%nuvoni%' AND v.date = '2024-04-18')
     ORDER BY v.date, v.vch_type`);
  say(`   Vouchers in the DB: ${nv.length}`);
  table(nv.map((r) => ({ company: r.company.replace(/^Wallnut\s*/i, ''), vch_no: r.vch_no, type: r.vch_type, date: r.date, party: r.party_name, total: inr(r.total_amount), cancelled: r.is_cancelled })));
  const { rows: nvb } = await pool.query(`SELECT c.name AS company, b.party_name, b.bill_ref, b.bill_date::text AS bill_date, b.amount FROM bills_receivable b JOIN companies c ON c.id = b.company_id WHERE b.party_name ILIKE '%nuvoni%' ORDER BY b.bill_date`);
  say(`   Rows of this party in the DB bills table: ${nvb.length}`);
  table(nvb.map((r) => ({ company: r.company.replace(/^Wallnut\s*/i, ''), bill: r.bill_ref, bill_date: r.bill_date, amount: inr(r.amount) })));
  const nvT = findParty(R, 'nuvoni');
  say(`   In Tally's pending list now: ${nvT.length ? nvT.map((b) => `${b.ref} ${inr(b.amount)}`).join('; ') : 'not pending'}`);

  // 6
  say('\n6) PARTY-WISE PENDING (Tally vs the dashboard card)');
  const parties = [['CEE KE MATERIALS', 9.20], ['MODERN CERAMICS', 7.97], ['ESS JAY EMPORIUM', 4.74], ['Atul Ltd.', 9.90]];
  const { rows: sales } = await pool.query(buildSalesRecordsSql({}));
  const cardBy = new Map();
  sales.filter((r) => r.invoiceCategory === 'sale').forEach((r) => cardBy.set(r.partyName, (cardBy.get(r.partyName) || 0) + Number(r.finalOutstanding || 0)));
  table(parties.map(([name, expected]) => {
    const t = findParty(R, name).filter((b) => b.amount < 0);
    const card = [...cardBy.entries()].filter(([k]) => k.toLowerCase().includes(name.toLowerCase().replace(/\.$/, ''))).reduce((s, [, v]) => s + v, 0);
    return { party: name, expected_L: expected, tally_bills: t.length, tally_total_L: (-t.reduce((s, b) => s + b.amount, 0) / 100000).toFixed(2), dashboard_card_L: (card / 100000).toFixed(2) };
  }));

  // 7
  say('\n7) OLD BILLS: Srinivasan & Co, Einstek - Engineering Insulation Solutions');
  const old = [...findParty(R, 'srinivasan'), ...findParty(R, 'einstek')];
  table(old.map((b) => ({ party: b.party, bill_no: b.ref, bill_date: b.billDate, due_date: b.dueDate, overdue_days: b.overdue, amount: inr(Math.abs(b.amount)), side: b.amount < 0 ? 'Dr' : 'Cr' })));
  const { rows: oldDb } = await pool.query(`SELECT c.name AS company, b.party_name, b.bill_ref, b.bill_date::text AS bill_date, b.amount FROM bills_receivable b JOIN companies c ON c.id = b.company_id WHERE b.party_name ILIKE '%srinivasan%' OR b.party_name ILIKE '%einstek%' ORDER BY b.bill_date`);
  say('   In the DB bills table:');
  table(oldDb.map((r) => ({ company: r.company.replace(/^Wallnut\s*/i, ''), party: r.party_name, bill: r.bill_ref, bill_date: r.bill_date, amount: inr(r.amount) })));

  // 8
  say('\n8) CLEARED BILLS: WBSIMK-478/24-25 and WBSIMK-516/24-25');
  for (const no of ['WBSIMK-478/24-25', 'WBSIMK-516/24-25']) {
    const t = R.filter((b) => b.ref.toLowerCase() === no.toLowerCase());
    const { rows: v } = await pool.query(`SELECT c.name AS company, v.vch_type, v.date::text AS date, v.party_name, v.total_amount FROM vouchers v JOIN companies c ON c.id = v.company_id WHERE v.vch_no = $1`, [no]);
    const { rows: b } = await pool.query(`SELECT c.name AS company, b.amount FROM bills_receivable b JOIN companies c ON c.id = b.company_id WHERE b.bill_ref = $1`, [no]);
    say(`   ${no}`);
    say(`     voucher in DB   : ${v.length ? v.map((r) => `${r.vch_type} ${r.date} ${r.party_name} ${inr(r.total_amount)}`).join('; ') : 'not found'}`);
    say(`     Tally pending   : ${t.length ? `STILL PENDING ${inr(Math.abs(t[0].amount))}` : R.length ? 'not in the pending list  -> fully received (cleared)' : '(Tally list not read)'}`);
    say(`     DB bills table  : ${b.length ? b.map((r) => inr(r.amount)).join('; ') : 'no row (not pending)'}`);
  }

  // ── files ────────────────────────────────────────────────────────────────
  const csvRows = [['list', 'party', 'bill_no', 'bill_date', 'due_date', 'overdue_days', 'amount_tally_sign', 'side']];
  R.forEach((b) => csvRows.push(['receivable', b.party, b.ref, b.billDate, b.dueDate, b.overdue, b.amount, b.amount < 0 ? 'Dr (receivable)' : 'Cr (advance)']));
  P.forEach((b) => csvRows.push(['payable', b.party, b.ref, b.billDate, b.dueDate, b.overdue, b.amount, b.amount > 0 ? 'Cr (payable)' : 'Dr (advance paid)']));
  fs.writeFileSync(CSV, '﻿' + csvRows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n'));
  fs.writeFileSync(TXT, out.join('\n') + '\n');
  console.log(`\nSaved: ${TXT}\n       ${CSV}   (${csvRows.length - 1} bills)`);
})()
  .catch((e) => { console.error('FATAL:', e.message || e.code || '(no message)', e.stack); process.exitCode = 1; })
  .finally(() => pool.end());
