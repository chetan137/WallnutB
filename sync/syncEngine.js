'use strict';

const pool        = require('../db/pool');
const tallyClient = require('../tally/client');
const templates   = require('../tally/xmlTemplates');
const parsers     = require('../tally/parsers');
const syncLogs    = require('./syncLogs');
const logger      = require('../utils/logger');
const config      = require('../config');
const { subtractDays, todayIso } = require('../utils/helpers');

/**
 * sync/syncEngine.js
 *
 * Core sync logic. Handles full and incremental sync for all companies.
 * Sequential processing only (1 vCPU constraint).
 */

// ── Progress logger ────────────────────────────────────────────────────────────

function logStep(company, step, detail = '') {
  logger.info(`[syncEngine]   ▶ ${company} | ${step}${detail ? ' — ' + detail : ''}`);
}

// ── Vouchers ───────────────────────────────────────────────────────────────────

async function syncVouchers(company) {
  const { id: companyId, tally_name: tallyName, fiscal_year_from, initial_sync_done } = company;

  logStep(tallyName, 'VOUCHERS starting');
  await syncLogs.startSync(companyId, 'vouchers');

  try {
    const toDate = todayIso();
    let fromDate;

    if (!initial_sync_done) {
      fromDate = fiscal_year_from
        ? (fiscal_year_from instanceof Date
            ? fiscal_year_from.toISOString().slice(0, 10)
            : String(fiscal_year_from).slice(0, 10))
        : '2024-04-01';
      logStep(tallyName, 'VOUCHERS', `FULL sync from ${fromDate} to ${toDate}`);
    } else {
      const lastSynced = await syncLogs.getLastSyncedDate(companyId, 'vouchers');
      const base       = lastSynced || toDate;
      fromDate         = subtractDays(base, config.sync.backfillDays);
      logStep(tallyName, 'VOUCHERS', `INCREMENTAL from ${fromDate} to ${toDate}`);
    }

    // Fetch
    logStep(tallyName, 'VOUCHERS', 'building XML request...');
    const xml = templates.buildAllVouchersRequest(tallyName, fromDate, toDate);

    logStep(tallyName, 'VOUCHERS', 'sending to Tally (may take 30-120s for large data)...');
    const raw    = await tallyClient.request(xml);
    logStep(tallyName, 'VOUCHERS', `parsing ${raw.length} bytes...`);

    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseVouchers(parsed, companyId);
    logStep(tallyName, 'VOUCHERS', `parsed ${records.length} vouchers. Starting DB upsert...`);

    let upserted = 0;
    for (const r of records) {
      const vRes = await pool.query(
        `INSERT INTO vouchers
           (company_id, vch_no, date, vch_type, party_name, narration, total_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, vch_no, vch_type)
         DO UPDATE SET
           date         = EXCLUDED.date,
           party_name   = EXCLUDED.party_name,
           narration    = EXCLUDED.narration,
           total_amount = EXCLUDED.total_amount,
           synced_at    = NOW()
         RETURNING id`,
        [r.companyId, r.vchNo, r.date, r.vchType, r.partyName, r.narration, r.totalAmount]
      );
      const voucherId = vRes.rows[0]?.id;
      if (!voucherId) continue;

      await pool.query('DELETE FROM voucher_ledger_entries    WHERE voucher_id = $1', [voucherId]);
      await pool.query('DELETE FROM voucher_inventory_entries WHERE voucher_id = $1', [voucherId]);

      for (const le of r.ledgerEntries) {
        await pool.query(
          `INSERT INTO voucher_ledger_entries
             (voucher_id, ledger_name, amount, is_party_ledger, is_deemed_positive)
           VALUES ($1, $2, $3, $4, $5)`,
          [voucherId, le.ledgerName, le.amount, le.isParty, le.isDeemedPositive]
        );
      }
      for (const ie of r.inventoryEntries) {
        await pool.query(
          `INSERT INTO voucher_inventory_entries
             (voucher_id, item_name, quantity, unit, rate, amount, sales_officer, area_city, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [voucherId, ie.itemName, ie.quantity, ie.unit, ie.rate, ie.amount,
           ie.salesOfficer, ie.areaCity, ie.state]
        );
      }
      upserted++;

      // Progress every 50 records
      if (upserted % 50 === 0) {
        logStep(tallyName, 'VOUCHERS', `upserted ${upserted}/${records.length}...`);
      }
    }

    await syncLogs.successSync(companyId, 'vouchers', toDate, { fetched: records.length, upserted });
    if (!initial_sync_done) await syncLogs.markInitialSyncDone(companyId);
    logStep(tallyName, 'VOUCHERS DONE', `${upserted}/${records.length} upserted ✓`);

  } catch (err) {
    await syncLogs.failSync(companyId, 'vouchers', err.message);
    logger.error(`[syncEngine] VOUCHERS FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Ledger Masters ─────────────────────────────────────────────────────────────

async function syncLedgers(company) {
  const { id: companyId, tally_name: tallyName } = company;
  logStep(tallyName, 'LEDGERS starting');
  await syncLogs.startSync(companyId, 'ledgers');
  try {
    logStep(tallyName, 'LEDGERS', 'sending to Tally (may take 30-120s)...');
    const xml    = templates.buildLedgerMasterRequest(tallyName);
    const raw    = await tallyClient.request(xml);
    logStep(tallyName, 'LEDGERS', `parsing ${raw.length} bytes...`);

    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseLedgers(parsed, companyId);
    logStep(tallyName, 'LEDGERS', `parsed ${records.length} ledgers. Starting DB upsert...`);

    let upserted = 0;
    for (const r of records) {
      await pool.query(
        `INSERT INTO ledgers
           (company_id, name, parent_group, closing_balance, gst_no, state, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (company_id, name)
         DO UPDATE SET
           parent_group    = EXCLUDED.parent_group,
           closing_balance = EXCLUDED.closing_balance,
           gst_no          = EXCLUDED.gst_no,
           state           = EXCLUDED.state,
           synced_at       = NOW()`,
        [r.companyId, r.name, r.parentGroup, r.closingBalance, r.gstNo, r.state]
      );
      upserted++;
      if (upserted % 100 === 0) {
        logStep(tallyName, 'LEDGERS', `upserted ${upserted}/${records.length}...`);
      }
    }

    await syncLogs.successSync(companyId, 'ledgers', todayIso(), { fetched: records.length, upserted });
    logStep(tallyName, 'LEDGERS DONE', `${upserted} upserted ✓`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'ledgers', err.message);
    logger.error(`[syncEngine] LEDGERS FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Stock Items ────────────────────────────────────────────────────────────────

async function syncStockItems(company) {
  const { id: companyId, tally_name: tallyName } = company;
  logStep(tallyName, 'STOCK ITEMS starting');
  await syncLogs.startSync(companyId, 'stock_items');
  try {
    logStep(tallyName, 'STOCK ITEMS', 'sending to Tally...');
    const xml    = templates.buildStockItemsRequest(tallyName);
    const raw    = await tallyClient.request(xml);
    logStep(tallyName, 'STOCK ITEMS', `parsing ${raw.length} bytes...`);

    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseStockItems(parsed, companyId);
    logStep(tallyName, 'STOCK ITEMS', `parsed ${records.length} items. Upserting...`);

    let upserted = 0;
    for (const r of records) {
      await pool.query(
        `INSERT INTO stock_items
           (company_id, name, parent_group, base_unit, closing_qty, closing_value, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (company_id, name)
         DO UPDATE SET
           parent_group  = EXCLUDED.parent_group,
           base_unit     = EXCLUDED.base_unit,
           closing_qty   = EXCLUDED.closing_qty,
           closing_value = EXCLUDED.closing_value,
           synced_at     = NOW()`,
        [r.companyId, r.name, r.parentGroup, r.baseUnit, r.closingQty, r.closingValue]
      );
      upserted++;
    }
    await syncLogs.successSync(companyId, 'stock_items', todayIso(), { fetched: records.length, upserted });
    logStep(tallyName, 'STOCK ITEMS DONE', `${upserted} upserted ✓`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'stock_items', err.message);
    logger.error(`[syncEngine] STOCK ITEMS FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Outstanding ────────────────────────────────────────────────────────────────

async function syncOutstanding(company) {
  const { id: companyId, tally_name: tallyName } = company;
  logStep(tallyName, 'OUTSTANDING starting');
  await syncLogs.startSync(companyId, 'outstanding');
  try {
    logStep(tallyName, 'OUTSTANDING', 'sending to Tally...');
    const xml    = templates.buildOutstandingRequest(tallyName);
    const raw    = await tallyClient.request(xml);
    logStep(tallyName, 'OUTSTANDING', `parsing ${raw.length} bytes...`);

    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseOutstanding(parsed, companyId);
    logStep(tallyName, 'OUTSTANDING', `parsed ${records.length} records. Replacing snapshot...`);

    await pool.query('DELETE FROM outstanding WHERE company_id = $1', [companyId]);
    for (const r of records) {
      await pool.query(
        `INSERT INTO outstanding (company_id, party_name, total_outstanding, synced_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (company_id, party_name)
         DO UPDATE SET total_outstanding = EXCLUDED.total_outstanding, synced_at = NOW()`,
        [r.companyId, r.partyName, r.totalOutstanding]
      );
    }
    await syncLogs.successSync(companyId, 'outstanding', todayIso(), { fetched: records.length, upserted: records.length });
    logStep(tallyName, 'OUTSTANDING DONE', `${records.length} records ✓`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'outstanding', err.message);
    logger.error(`[syncEngine] OUTSTANDING FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Main Sync Cycle ────────────────────────────────────────────────────────────

async function runSyncCycle({ includeMasters = false } = {}) {
  // 1. Tally health check
  logger.info('[syncEngine] ── Sync cycle start ──');
  logger.info('[syncEngine] Checking Tally is alive...');
  const alive = await tallyClient.ping();
  if (!alive) {
    logger.warn('[syncEngine] Tally Prime NOT reachable — skipping this cycle.');
    return;
  }
  logger.info('[syncEngine] Tally is alive ✓');

  // 2. Load active companies
  const { rows: companies } = await pool.query(
    `SELECT * FROM companies WHERE is_active = true ORDER BY id ASC`
  );
  logger.info(`[syncEngine] Found ${companies.length} active company/companies.`);

  if (companies.length === 0) {
    logger.warn('[syncEngine] No active companies — check TALLY_COMPANIES in .env.');
    return;
  }

  // 3. Process each company SEQUENTIALLY
  for (const company of companies) {
    if (company.is_historical && company.initial_sync_done) {
      logger.info(`[syncEngine] ── Skipping "${company.tally_name}" (historical, already fully synced) ──`);
      continue;
    }

    logger.info(`[syncEngine] ══════════════════════════════════════════`);
    logger.info(`[syncEngine] ══ Processing: "${company.tally_name}" (id=${company.id}) ══`);
    logger.info(`[syncEngine] ══════════════════════════════════════════`);

    await syncVouchers(company);

    if (includeMasters || !company.initial_sync_done) {
      await syncLedgers(company);
      await syncStockItems(company);
      await syncOutstanding(company);
    }

    logger.info(`[syncEngine] ══ Done: "${company.tally_name}" ══`);
  }

  logger.info('[syncEngine] ── Sync cycle complete ──');
}

module.exports = { runSyncCycle, syncVouchers, syncLedgers, syncStockItems, syncOutstanding };
