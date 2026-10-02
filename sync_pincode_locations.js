'use strict';
/**
 * sync_pincode_locations.js
 * Manual run of the pincode -> State / District / City mapping (tally/pincodeLocations.js).
 * The same function also runs automatically after every ledger sync, so this is only needed to
 * fill everything at once or to retry with --refresh. Needs internet, NOT Tally (pm2 can keep running).
 *
 *   node sync_pincode_locations.js            only pincodes that are not mapped yet
 *   node sync_pincode_locations.js --refresh  look up every pincode again (also retries unknown ones)
 */
require('dotenv').config();
const pool = require('./db/pool');
const { syncPincodeLocations } = require('./tally/pincodeLocations');

(async () => {
  const r = await syncPincodeLocations({ refresh: process.argv.includes('--refresh'), log: console.log });
  console.log(`\nlooked up ${r.toLookup} | mapped ${r.mapped} | not found at India Post ${r.notFound.length}${r.notFound.length ? ` (${r.notFound.join(', ')})` : ''} | failed ${r.failed}`);
  if (r.skipped.length) console.log(`not a 6-digit pincode, skipped (fix these in Tally): ${r.skipped.join(', ')}`);

  const { rows: sample } = await pool.query('SELECT pincode, state, district, city FROM pincode_locations WHERE state IS NOT NULL ORDER BY pincode LIMIT 10');
  console.table(sample);
  const { rows: cov } = await pool.query(`
    SELECT COUNT(DISTINCT v.party_name) AS dealers,
           COUNT(DISTINCT v.party_name) FILTER (WHERE d.name IS NOT NULL) AS with_location
    FROM vouchers v
    LEFT JOIN (SELECT DISTINCT l.name FROM ledgers l JOIN pincode_locations p ON p.pincode = REGEXP_REPLACE(l.pincode, '[^0-9]', '', 'g') AND p.state IS NOT NULL) d ON d.name = v.party_name
    WHERE v.is_cancelled = false AND (LOWER(v.vch_type) LIKE 'sales%' OR LOWER(v.vch_type) LIKE 'credit note%')`);
  console.log('Dealers with a location:', cov[0]);
})()
  .catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
