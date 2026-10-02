'use strict';
/**
 * tally/pincodeLocations.js
 * Maps ledger pincodes to State / District / City (India Post lookup, https://api.postalpincode.in)
 * into `pincode_locations`. Only pincodes that are not mapped yet are looked up, so a run with
 * nothing new costs one DB query. Runs after every ledger sync, so a new dealer in Tally gets its
 * place on the dashboard within one sync cycle. Never needs Tally.
 *
 *   District = India Post "District"
 *   City     = most common "Block" of the pincode's post offices (town / tehsil); District if empty / "NA"
 *
 * A pincode is cleaned to its digits first ("400072." -> 400072, "411 001" -> 411001); only
 * 6-digit results are looked up.
 */
const axios  = require('axios');
const pool   = require('../db/pool');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const valid = (v) => v && !/^(na|n\/a|null|-)$/i.test(String(v).trim());
// Same cleaning as the dashboard SQL (backend/services/salesRecordsSql.js)
const CLEAN = "REGEXP_REPLACE(l.pincode, '[^0-9]', '', 'g')";

async function lookup(pincode) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await axios.get(`https://api.postalpincode.in/pincode/${pincode}`, { timeout: 20000 });
      const res = Array.isArray(data) ? data[0] : null;
      if (!res || res.Status !== 'Success' || !Array.isArray(res.PostOffice) || !res.PostOffice.length) return null; // unknown pincode
      const mode = (key) => {
        const count = {};
        res.PostOffice.forEach((p) => { if (valid(p[key])) count[p[key]] = (count[p[key]] || 0) + 1; });
        return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      };
      const district = mode('District');
      return { state: mode('State'), district, city: mode('Block') || district };
    } catch (err) {
      if (attempt === 3) { logger.warn(`[pincodes] ${pincode}: lookup failed (${err.message})`); return undefined; } // retried next run
      await sleep(1500 * attempt);
    }
  }
  return undefined;
}

/**
 * @param {{ refresh?: boolean, log?: Function }} opts  refresh = look up every pincode again
 * @returns {{ toLookup:number, mapped:number, notFound:string[], failed:number, skipped:string[] }}
 */
async function syncPincodeLocations({ refresh = false, log = (m) => logger.info(m) } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS pincode_locations (
    pincode TEXT PRIMARY KEY, state TEXT, district TEXT, city TEXT, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  const { rows } = await pool.query(`
    SELECT DISTINCT ${CLEAN} AS pincode, l.pincode AS raw
    FROM ledgers l
    WHERE NULLIF(TRIM(l.pincode), '') IS NOT NULL
      ${refresh ? '' : `AND NOT EXISTS (SELECT 1 FROM pincode_locations p WHERE p.pincode = ${CLEAN})`}`);
  const pins    = [...new Set(rows.map((r) => r.pincode).filter((p) => /^\d{6}$/.test(p)))].sort();
  const skipped = [...new Set(rows.filter((r) => !/^\d{6}$/.test(r.pincode)).map((r) => r.raw))].sort();
  const out = { toLookup: pins.length, mapped: 0, notFound: [], failed: 0, skipped };
  if (!pins.length) return out;

  log(`[pincodes] ${pins.length} new pincode(s) to look up`);
  for (const [i, pin] of pins.entries()) {
    const loc = await lookup(pin);
    if (loc === undefined) out.failed++;
    else if (loc === null) out.notFound.push(pin);
    else {
      await pool.query(
        `INSERT INTO pincode_locations (pincode, state, district, city, fetched_at) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (pincode) DO UPDATE SET state=EXCLUDED.state, district=EXCLUDED.district, city=EXCLUDED.city, fetched_at=NOW()`,
        [pin, loc.state, loc.district, loc.city]);
      out.mapped++;
    }
    if ((i + 1) % 50 === 0) log(`[pincodes] ${i + 1}/${pins.length}`);
    await sleep(350);
  }
  // A pincode India Post does not know is stored with no place, so it is not asked again every
  // cycle (run with --refresh to retry them).
  for (const pin of out.notFound) {
    await pool.query('INSERT INTO pincode_locations (pincode) VALUES ($1) ON CONFLICT (pincode) DO NOTHING', [pin]);
  }
  log(`[pincodes] mapped ${out.mapped}, not found ${out.notFound.length}, failed ${out.failed}`);
  return out;
}

module.exports = { syncPincodeLocations };
