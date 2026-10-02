'use strict';

const pool   = require('../db/pool');
const logger = require('../utils/logger');
const { dbDateToIso } = require('../utils/helpers');

/**
 * sync/syncLogs.js
 *
 * Read and write the sync_logs table.
 * This table is the backbone of incremental sync — it stores:
 *   last_synced_date → the toDate of the last SUCCESSFUL sync window.
 *
 * On first run: no row exists → getLastSyncedDate() returns null → full sync triggered.
 * After success: row is upserted with the new toDate.
 */

/**
 * Returns the last successfully synced date for a (company, dataType) pair.
 * Returns null if this combination has never been synced successfully.
 *
 * @param {number} companyId
 * @param {string} dataType  'vouchers' | 'ledgers' | 'stock_items' | 'outstanding'
 * @returns {Promise<string|null>}  ISO date string "YYYY-MM-DD" or null
 */
async function getLastSyncedDate(companyId, dataType) {
  const res = await pool.query(
    `SELECT last_synced_date
       FROM sync_logs
      WHERE company_id = $1 AND data_type = $2 AND status = 'success'`,
    [companyId, dataType]
  );
  const val = res.rows[0]?.last_synced_date;
  if (!val) return null;
  // BUG FIX: was val.toISOString().slice(0,10) — for a DATE column, pg
  // creates a Date at LOCAL midnight, and toISOString() converts to UTC,
  // shifting the date back a day in any positive-UTC-offset timezone (e.g.
  // IST, this VM's timezone). dbDateToIso() uses local date components
  // instead, matching the same fix already applied in syncEngine.js.
  return dbDateToIso(val);
}

/**
 * Marks a sync as "running". Upserts the row so the first call creates it.
 */
async function startSync(companyId, dataType) {
  await pool.query(
    `INSERT INTO sync_logs (company_id, data_type, status, started_at)
          VALUES ($1, $2, 'running', NOW())
     ON CONFLICT (company_id, data_type)
     DO UPDATE SET status = 'running', started_at = NOW(), error_message = NULL`,
    [companyId, dataType]
  );
}

/**
 * Records a successful sync. Updates last_synced_date so the next run
 * can compute the correct incremental window.
 *
 * @param {number} companyId
 * @param {string} dataType
 * @param {string} toDate        The toDate used in this sync (stored as last_synced_date)
 * @param {{ fetched: number, upserted: number }} counts
 */
async function successSync(companyId, dataType, toDate, counts = {}) {
  await pool.query(
    `UPDATE sync_logs
        SET status = 'success',
            last_synced_date = $3,
            records_fetched  = $4,
            records_upserted = $5,
            completed_at     = NOW(),
            error_message    = NULL
      WHERE company_id = $1 AND data_type = $2`,
    [companyId, dataType, toDate, counts.fetched ?? 0, counts.upserted ?? 0]
  );
}

/**
 * Records a failed sync. Does NOT update last_synced_date so the next
 * cycle retries from the same window.
 */
async function failSync(companyId, dataType, errorMessage) {
  await pool.query(
    `UPDATE sync_logs
        SET status = 'error', error_message = $3, completed_at = NOW()
      WHERE company_id = $1 AND data_type = $2`,
    [companyId, dataType, String(errorMessage).slice(0, 1000)]
  );
}

/**
 * Flips companies.initial_sync_done = true after the first full sync completes.
 * This switches future runs to incremental mode.
 */
async function markInitialSyncDone(companyId) {
  await pool.query(
    `UPDATE companies SET initial_sync_done = true WHERE id = $1`,
    [companyId]
  );
  logger.info(`[syncLogs] Company ${companyId}: initial_sync_done = true.`);
}

// ── Voucher backfill resume cursor ───────────────────────────────────────────
// A full voucher backfill is hundreds of chunks. Without a cursor, any restart
// (pm2 memory limit, crash, deploy) began again at chunk 1 — on the 25-26
// company that meant it never got past ~24-Apr-2025. The cursor is the toDate
// of the last chunk that finished with NO failed chunk before it, stored in
// sync_logs under its own data_type so it never touches the real 'vouchers'
// incremental row. Removed once the backfill completes.
const BACKFILL_TYPE = 'vouchers_backfill';

/** ISO date of the last finished backfill chunk, or null if none. */
async function getBackfillCursor(companyId) {
  const res = await pool.query(
    `SELECT last_synced_date FROM sync_logs WHERE company_id = $1 AND data_type = $2`,
    [companyId, BACKFILL_TYPE]
  );
  const val = res.rows[0]?.last_synced_date;
  return val ? dbDateToIso(val) : null;
}

async function setBackfillCursor(companyId, isoDate) {
  await pool.query(
    `INSERT INTO sync_logs (company_id, data_type, status, last_synced_date, started_at)
          VALUES ($1, $2, 'running', $3, NOW())
     ON CONFLICT (company_id, data_type)
     DO UPDATE SET last_synced_date = $3, status = 'running'`,
    [companyId, BACKFILL_TYPE, isoDate]
  );
}

async function clearBackfillCursor(companyId) {
  await pool.query(
    `DELETE FROM sync_logs WHERE company_id = $1 AND data_type = $2`,
    [companyId, BACKFILL_TYPE]
  );
}

module.exports = {
  getLastSyncedDate, startSync, successSync, failSync, markInitialSyncDone,
  getBackfillCursor, setBackfillCursor, clearBackfillCursor,
};
