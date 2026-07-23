'use strict';

const pool   = require('../db/pool');
const logger = require('../utils/logger');

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
  // pg returns Date objects — convert to ISO string
  return val instanceof Date ? val.toISOString().slice(0, 10) : String(val).slice(0, 10);
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

module.exports = { getLastSyncedDate, startSync, successSync, failSync, markInitialSyncDone };
