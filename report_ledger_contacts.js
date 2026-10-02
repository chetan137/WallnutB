'use strict';
/**
 * report_ledger_contacts.js  (DB only, pm2 can keep running)
 * Dealers = parties that have a Sales / Credit Note / Debit Note voucher (not cancelled).
 * Ledger values are merged by NAME across all companies (FYs): the latest non-empty value wins.
 *
 *  1. per FY: how many dealers have address / pincode / state / gst_no
 *  2. dealers_no_pincode.csv  (name, state, gstin)
 *  3. dealers_all.csv         (name, state, pincode, address, gstin)
 */
require('dotenv').config();
const fs   = require('fs');
const pool = require('./db/pool');

const MERGED = `
  merged AS (
    SELECT l.name,
      (ARRAY_AGG(NULLIF(l.address,'')  ORDER BY c.fiscal_year_from DESC) FILTER (WHERE NULLIF(l.address,'')  IS NOT NULL))[1] AS address,
      (ARRAY_AGG(NULLIF(l.pincode,'')  ORDER BY c.fiscal_year_from DESC) FILTER (WHERE NULLIF(l.pincode,'')  IS NOT NULL))[1] AS pincode,
      (ARRAY_AGG(NULLIF(l.state,'')    ORDER BY c.fiscal_year_from DESC) FILTER (WHERE NULLIF(l.state,'')    IS NOT NULL))[1] AS state,
      (ARRAY_AGG(NULLIF(l.gst_no,'')   ORDER BY c.fiscal_year_from DESC) FILTER (WHERE NULLIF(l.gst_no,'')   IS NOT NULL))[1] AS gst_no
    FROM ledgers l JOIN companies c ON c.id = l.company_id
    GROUP BY l.name
  ),
  dealer_fy AS (
    SELECT DISTINCT v.party_name AS name, fy_start(v.date) AS fy
    FROM vouchers v
    WHERE v.is_cancelled = false AND v.party_name IS NOT NULL AND v.party_name <> ''
      AND ((LOWER(v.vch_type) LIKE 'sales%' AND LOWER(v.vch_type) NOT LIKE 'sales order%')
           OR LOWER(v.vch_type) LIKE 'credit note%' OR LOWER(v.vch_type) LIKE 'debit note%')
  )`;

const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const write = (file, header, rows) => {
  fs.writeFileSync(file, '﻿' + [header.join(','), ...rows.map((r) => header.map((h) => csv(r[h])).join(','))].join('\r\n'));
  console.log(`wrote ${file} (${rows.length} rows)`);
};

(async () => {
  const { rows: perFy } = await pool.query(`
    WITH ${MERGED}
    SELECT TO_CHAR(d.fy, 'YYYY') || '-' || TO_CHAR(d.fy + INTERVAL '1 year', 'YY') AS fy,
           COUNT(*) AS dealers,
           COUNT(m.address) AS with_address, COUNT(m.pincode) AS with_pincode,
           COUNT(m.state)   AS with_state,   COUNT(m.gst_no)  AS with_gst_no
    FROM dealer_fy d LEFT JOIN merged m ON m.name = d.name
    GROUP BY d.fy ORDER BY d.fy`);
  console.log('\n1) Dealers (parties with Sales / Credit Note vouchers) per Financial Year');
  console.table(perFy);

  const { rows: all } = await pool.query(`
    WITH ${MERGED}
    SELECT d.name, m.state, m.pincode, m.address, m.gst_no AS gstin
    FROM (SELECT DISTINCT name FROM dealer_fy) d LEFT JOIN merged m ON m.name = d.name
    ORDER BY d.name`);
  write('dealers_all.csv', ['name', 'state', 'pincode', 'address', 'gstin'], all);
  write('dealers_no_pincode.csv', ['name', 'state', 'gstin'], all.filter((r) => !r.pincode));
  console.log(`\nDealers: ${all.length} | without pincode: ${all.filter((r) => !r.pincode).length}`);
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
