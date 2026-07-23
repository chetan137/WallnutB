'use strict';

const http         = require('http');
const cron         = require('node-cron');
const config       = require('./config');
const { migrate }  = require('./db/migrate');
const pool         = require('./db/pool');
const { runSyncCycle } = require('./sync/syncEngine');
const logger       = require('./utils/logger');

/**
 * index.js — Tally Sync Service Entry Point
 *
 * Startup sequence:
 *  1. Apply DB schema + seed companies (idempotent)
 *  2. Run full sync cycle immediately (vouchers + masters)
 *  3. Schedule incremental voucher sync every N minutes
 *  4. Schedule daily master data sync at configured hour
 *  5. Start lightweight health-check HTTP server
 *
 * Clone → fill .env → `node index.js` — everything works automatically.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let isShuttingDown = false;
let isSyncRunning  = false;

// ── Safe sync wrapper ──────────────────────────────────────────────────────────
// Prevents cron errors from silently killing the scheduler,
// and skips overlapping cycles if a previous one is still running.
async function safeSyncCycle(options, label) {
  if (isShuttingDown) {
    logger.info(`[cron] ${label}: skip — shutting down.`);
    return;
  }
  if (isSyncRunning) {
    logger.warn(`[cron] ${label}: skip — previous cycle still running.`);
    return;
  }
  isSyncRunning = true;
  try {
    logger.info(`[cron] ${label}: starting.`);
    await runSyncCycle(options);
    logger.info(`[cron] ${label}: complete.`);
  } catch (err) {
    logger.error(`[cron] ${label}: UNHANDLED ERROR — ${err.message}`);
    logger.error(err.stack);
  } finally {
    isSyncRunning = false;
  }
}

// ── Health endpoint data ───────────────────────────────────────────────────────
async function getSyncStatus() {
  try {
    const res = await pool.query(
      `SELECT company_id, data_type, status, last_synced_date, completed_at, error_message
         FROM sync_logs
        ORDER BY company_id, data_type`
    );
    return res.rows;
  } catch {
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('═══════════════════════════════════════════');
  logger.info(' Tally Sync Service — Starting             ');
  logger.info(`  Tally:     ${config.tally.baseUrl}`);
  logger.info(`  DB:        ${config.pg.host}:${config.pg.port}/${config.pg.database}`);
  logger.info(`  Interval:  every ${config.sync.intervalMinutes} min`);
  logger.info(`  Masters:   daily at ${config.sync.masterSyncHour}:00`);
  logger.info(`  Companies: ${config.companies.map(c => c.name).join(', ')}`);
  logger.info('═══════════════════════════════════════════');

  // ── 1. DB Migration (safe to run every startup) ───────────────────────────
  await migrate();

  // ── 2. Immediate full sync on startup ─────────────────────────────────────
  await safeSyncCycle({ includeMasters: true }, 'Startup full sync');

  // ── 3. Incremental voucher sync every N minutes ───────────────────────────
  const voucherSchedule = `*/${config.sync.intervalMinutes} * * * *`;
  cron.schedule(voucherSchedule, () =>
    safeSyncCycle({ includeMasters: false }, 'Incremental voucher sync')
  );
  logger.info(`[main] Voucher sync scheduled: ${voucherSchedule}`);

  // ── 4. Daily master sync (ledgers, stock items, outstanding) ──────────────
  const masterSchedule = `0 ${config.sync.masterSyncHour} * * *`;
  cron.schedule(masterSchedule, () =>
    safeSyncCycle({ includeMasters: true }, 'Daily master sync')
  );
  logger.info(`[main] Master sync scheduled: ${masterSchedule} (${config.sync.masterSyncHour}:00 daily)`);

  // ── 5. Health check HTTP endpoint ─────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const syncStatus = await getSyncStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:      'ok',
        service:     'tally-sync',
        time:        new Date().toISOString(),
        syncRunning: isSyncRunning,
        tally:       config.tally.baseUrl,
        companies:   config.companies.map(c => c.name),
        syncLogs:    syncStatus,
      }, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(config.port, () => {
    logger.info(`[main] Health endpoint: http://localhost:${config.port}/health`);
  });

  // ── 6. Graceful shutdown ───────────────────────────────────────────────────
  async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`[main] ${signal} received — shutting down gracefully...`);

    // Stop accepting new HTTP requests
    server.close(() => logger.info('[main] HTTP server closed.'));

    // Wait for running sync to finish (max 60s)
    const deadline = Date.now() + 60_000;
    while (isSyncRunning && Date.now() < deadline) {
      logger.info('[main] Waiting for active sync cycle to finish...');
      await new Promise(r => setTimeout(r, 2000));
    }

    // Close DB pool
    await pool.end();
    logger.info('[main] DB pool closed. Goodbye.');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
main().catch((err) => {
  logger.error(`[FATAL] ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
