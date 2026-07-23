'use strict';

require('dotenv').config();

/**
 * config.js
 * Single source of truth for all configuration.
 * All other modules import from here — never read process.env directly.
 *
 * COMPANY FORMAT (TALLY_COMPANIES env var):
 *   Pipe-separated: "displayName::tallyExactName::fiscalYearFrom::isHistorical"
 *   Example: "Wallnut 26-27::Wallnut Chemicals 26-27::2025-04-01::false"
 *   Multiple: "CompA::TallyA::2024-04-01::true|CompB::TallyB::2025-04-01::false"
 *
 * SHORTHAND (single company, simpler .env):
 *   If TALLY_COMPANIES is not set but TALLY_COMPANY_NAME is, a single
 *   non-historical company entry is created automatically.
 */

// ── Company parser ─────────────────────────────────────────────────────────────

function parseCompanies(raw, fallbackName) {
  // Try the pipe-separated TALLY_COMPANIES format first
  if (raw) {
    const entries = raw.split('|').filter(Boolean).map((entry) => {
      const parts = entry.split('::');
      return {
        name:           parts[0]?.trim() || '',
        tallyName:      parts[1]?.trim() || '',
        fiscalYearFrom: parts[2]?.trim() || '2025-04-01',
        isHistorical:   parts[3]?.trim() === 'true',
      };
    }).filter(c => c.name && c.tallyName);

    if (entries.length > 0) return entries;
  }

  // Fallback: single company shorthand via TALLY_COMPANY_NAME
  if (fallbackName) {
    return [{
      name:           fallbackName,
      tallyName:      fallbackName,
      fiscalYearFrom: process.env.TALLY_FISCAL_FROM || '2025-04-01',
      isHistorical:   false,
    }];
  }

  return [];
}

// ── Build config ───────────────────────────────────────────────────────────────

const config = {
  port: parseInt(process.env.PORT, 10) || 4001,
  env:  process.env.NODE_ENV || 'development',

  tally: {
    host:    process.env.TALLY_HOST || 'http://localhost',
    port:    parseInt(process.env.TALLY_PORT, 10) || 9000,
    timeout: parseInt(process.env.TALLY_TIMEOUT_MS, 10) || 120_000,
    get baseUrl() { return `${this.host}:${this.port}`; },
  },

  pg: {
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT, 10) || 5432,
    database: process.env.PG_DATABASE || 'wallnut_sync',
    user:     process.env.PG_USER     || 'postgres',
    password: process.env.PG_PASSWORD || '',
    max: 5,
    idleTimeoutMillis:       30_000,
    connectionTimeoutMillis:  5_000,
  },

  sync: {
    intervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 10,
    masterSyncHour:  parseInt(process.env.MASTER_SYNC_HOUR, 10) || 2,
    backfillDays:    parseInt(process.env.BACKFILL_DAYS, 10) || 3,
  },

  companies: parseCompanies(
    process.env.TALLY_COMPANIES,
    process.env.TALLY_COMPANY_NAME,
  ),
};

// ── Startup validation ─────────────────────────────────────────────────────────
// Crash early with a clear message rather than a confusing DB/Tally error later.

function validate(cfg) {
  const errors = [];

  if (!process.env.PG_PASSWORD && cfg.env === 'production') {
    errors.push('PG_PASSWORD is not set. Set it in .env or as an environment variable.');
  }
  if (!process.env.PG_HOST && cfg.env === 'production') {
    errors.push('PG_HOST is not set. The sync service needs to know where PostgreSQL is running.');
  }
  if (cfg.companies.length === 0) {
    errors.push(
      'No companies configured. Set TALLY_COMPANIES or TALLY_COMPANY_NAME in .env.\n' +
      '  Example: TALLY_COMPANY_NAME=MyTallyCompany\n' +
      '  Or full: TALLY_COMPANIES=Display Name::Exact Tally Name::2025-04-01::false'
    );
  }

  if (errors.length > 0) {
    console.error('\n❌ Configuration errors — cannot start:\n');
    errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}`));
    console.error('\nFix the above errors in your .env file and restart.\n');
    process.exit(1);
  }
}

validate(config);

module.exports = config;
