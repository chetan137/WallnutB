'use strict';
/**
 * sync_pincode_locations.js
 * Maps every ledger pincode to State / District / City, using the free India Post lookup
 * (https://api.postalpincode.in). Needs internet, NOT Tally (pm2 can keep running).
 * Result goes to `pincode_locations`; the dashboard API joins it to the dealer's ledger pincode.
 *
 *   District = India Post "District"
 *   City     = most common "Block" of the pincode's post offices (a town / tehsil name);
 *              if that is empty or "NA", the District.
 *
 *   node sync_pincode_locations.js            only pincodes that are not mapped yet
 *   node sync_pincode_locations.js --refresh  look up every pincode again
 */
require('dotenv').config();
const axios = require('axios');
const pool  = require('./db/pool');

const REFRESH = process.argv.includes('--refresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const valid = (v) => v && !/^(na|n\/a|null|-)$/i.test(String(v).trim());

async function lookup(pincode) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await axios.get(`https://api.postalpincode.in/pincode/${pincode}`, { timeout: 20000 });
      const res = Array.isArray(data) ? data[0] : null;
      if (!res || res.Status !== 'Success' || !Array.isArray(res.PostOffice) || !res.PostOffice.length) return null;
      const pos = res.PostOffice;
      const mode = (key) => {
        const count = {};
        pos.forEach((p) => { if (valid(p[key])) count[p[key]] = (count[p[key]] || 0) + 1; });
        return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      };
      const state = mode('State');
      const district = mode('District');
      return { state, district, city: mode('Block') || district };
    } catch (err) {
      if (attempt === 3) { console.log(`  ${pincode}: lookup failed (${err.message})`); return undefined; }
      await sleep(1500 * attempt);
    }
  }
  return undefined;
}

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS pincode_locations (
    pincode TEXT PRIMARY KEY, state TEXT, district TEXT, city TEXT, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  const { rows } = await pool.query(`
    SELECT DISTINCT REGEXP_REPLACE(l.pincode, '\\s', '', 'g') AS pincode
    FROM ledgers l
    WHERE NULLIF(TRIM(l.pincode), '') IS NOT NULL
      ${REFRESH ? '' : "AND NOT EXISTS (SELECT 1 FROM pincode_locations p WHERE p.pincode = REGEXP_REPLACE(l.pincode, '\\s', '', 'g'))"}
    ORDER BY 1`);
  const pins = rows.map((r) => r.pincode).filter((p) => /^\d{6}$/.test(p));
  const bad = rows.map((r) => r.pincode).filter((p) => !/^\d{6}$/.test(p));
  console.log(`${pins.length} pincode(s) to look up${bad.length ? `; ${bad.length} are not 6 digits and are skipped: ${bad.slice(0, 15).join(', ')}` : ''}`);

  let ok = 0, notFound = [], failed = 0;
  for (const [i, pin] of pins.entries()) {
    const loc = await lookup(pin);
    if (loc === undefined) failed++;
    else if (loc === null) notFound.push(pin);
    else {
      await pool.query(
        `INSERT INTO pincode_locations (pincode, state, district, city, fetched_at) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (pincode) DO UPDATE SET state=EXCLUDED.state, district=EXCLUDED.district, city=EXCLUDED.city, fetched_at=NOW()`,
        [pin, loc.state, loc.district, loc.city]);
      ok++;
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${pins.length}`);
    await sleep(350);
  }
  console.log(`\nmapped ${ok} | not found at India Post ${notFound.length}${notFound.length ? ` (${notFound.join(', ')})` : ''} | failed ${failed}`);

  const { rows: sample } = await pool.query(`SELECT pincode, state, district, city FROM pincode_locations ORDER BY pincode LIMIT 12`);
  console.table(sample);
  const { rows: cov } = await pool.query(`
    SELECT COUNT(DISTINCT v.party_name) AS dealers,
           COUNT(DISTINCT v.party_name) FILTER (WHERE d.name IS NOT NULL) AS with_location
    FROM vouchers v
    LEFT JOIN (SELECT DISTINCT l.name FROM ledgers l JOIN pincode_locations p ON p.pincode = REGEXP_REPLACE(l.pincode, '\\s', '', 'g')) d ON d.name = v.party_name
    WHERE v.is_cancelled = false AND (LOWER(v.vch_type) LIKE 'sales%' OR LOWER(v.vch_type) LIKE 'credit note%')`);
  console.log('Dealers with a location:', cov[0]);
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
