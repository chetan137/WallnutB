'use strict';

const fs     = require('fs');
const path   = require('path');
const pool   = require('./pool');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * db/migrate.js
 *
 * 1. Applies schema.sql (idempotent — safe to run every startup).
 * 2. Seeds companies from TALLY_COMPANIES env var if the companies table is empty.
 *
 * Called once at process startup in index.js.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    // ── 1. Apply schema ─────────────────────────────────────────────────────
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(sql);
    logger.info('[migrate] Schema applied successfully.');

    // ── 2. Seed companies from .env if table is empty ────────────────────────
    if (config.companies.length === 0) {
      logger.warn('[migrate] No companies found in TALLY_COMPANIES env var. Skipping seed.');
      return;
    }

    const existing = await client.query('SELECT COUNT(*) AS cnt FROM companies');
    const count = parseInt(existing.rows[0].cnt, 10);

    if (count === 0) {
      logger.info(`[migrate] Seeding ${config.companies.length} companies from env...`);
      for (const c of config.companies) {
        await client.query(
          `INSERT INTO companies (name, tally_name, fiscal_year_from, is_historical)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tally_name) DO NOTHING`,
          [c.name, c.tallyName, c.fiscalYearFrom, c.isHistorical]
        );
        logger.info(`[migrate]   Seeded: "${c.name}" (tally: "${c.tallyName}", from: ${c.fiscalYearFrom}, historical: ${c.isHistorical})`);
      }
    } else {
      logger.info(`[migrate] Companies table already has ${count} row(s) — skipping seed.`);
    }
  } finally {
    client.release();
  }
}

module.exports = { migrate };
