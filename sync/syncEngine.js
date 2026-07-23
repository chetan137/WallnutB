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
 * Core sync logic. Handles:
 *   - Full sync (when initial_sync_done = false OR historical company first run)
 *   - Incremental sync (after initial sync completes)
 *   - Sequential company processing (1 vCPU — never parallel)
 *
 * ── SYNC FLOW ────────────────────────────────────────────────────────────────
 *
 *  initial_sync_done = false:
 *    fromDate = fiscal_year_from (from companies table)
 *    toDate   = today
 *    → Fetch ALL data from FY start → UPSERT everything → mark initial_sync_done = true
 *
 *  initial_sync_done = true (incremental):
 *    fromDate = last_synced_date - BACKFILL_DAYS  (catches backdated Tally entries)
 *    toDate   = today
 *    → Fetch only new/changed data → UPSERT (ON CONFLICT DO UPDATE handles edits)
 *
 *  is_historical = true AND initial_sync_done = true:
 *    → Completely skip. FY is closed, data won't change.
 */

// ── Vouchers ───────────────────────────────────────────────────────────────────

async function syncVouchers(company) {
  const { id: companyId, tally_name: tallyName, fiscal_year_from, initial_sync_done } = company;

  await syncLogs.startSync(companyId, 'vouchers');
  try {
    // ── Determine sync window ──────────────────────────────────────────────
    const toDate = todayIso();
    let fromDate;

    if (!initial_sync_done) {
      // FULL SYNC — start from fiscal year beginning
      fromDate = fiscal_year_from
        ? (fiscal_year_from instanceof Date
            ? fiscal_year_from.toISOString().slice(0, 10)
            : String(fiscal_year_from).slice(0, 10))
        : '2024-04-01';
      logger.info(`[syncEngine] FULL voucher sync: "${tallyName}" from ${fromDate} to ${toDate}`);
    } else {
      // INCREMENTAL — go back BACKFILL_DAYS from last sync to catch backdated entries
      const lastSynced = await syncLogs.getLastSyncedDate(companyId, 'vouchers');
      const base       = lastSynced || toDate;
      fromDate         = subtractDays(base, config.sync.backfillDays);
      logger.info(`[syncEngine] INCREMENTAL voucher sync: "${tallyName}" from ${fromDate} to ${toDate}`);
    }

    // ── Fetch from Tally ───────────────────────────────────────────────────
    const xml    = templates.buildAllVouchersRequest(tallyName, fromDate, toDate);
    const raw    = await tallyClient.request(xml);
    const parsed = tallyClient.parseXml(raw);
    const records = parsers.parseVouchers(parsed, companyId);
    logger.info(`[syncEngine] Fetched ${records.length} vouchers from Tally for "${tallyName}".`);

    // ── UPSERT into DB (sequential — no Promise.all on 1 vCPU) ───────────
    let upserted = 0;
    for (const r of records) {
      // Upsert voucher header
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

      // Delete old line items before re-inserting (simpler + correct for edits)
      await pool.query('DELETE FROM voucher_ledger_entries    WHERE voucher_id = $1', [voucherId]);
      await pool.query('DELETE FROM voucher_inventory_entries WHERE voucher_id = $1', [voucherId]);

      // Insert ledger entries
      for (const le of r.ledgerEntries) {
        await pool.query(
          `INSERT INTO voucher_ledger_entries
             (voucher_id, ledger_name, amount, is_party_ledger, is_deemed_positive)
           VALUES ($1, $2, $3, $4, $5)`,
          [voucherId, le.ledgerName, le.amount, le.isParty, le.isDeemedPositive]
        );
      }

      // Insert inventory entries
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
    }

    await syncLogs.successSync(companyId, 'vouchers', toDate, { fetched: records.length, upserted });

    // Flip initial_sync_done flag after first successful full sync
    if (!initial_sync_done) {
      await syncLogs.markInitialSyncDone(companyId);
    }

    logger.info(`[syncEngine] Vouchers done for "${tallyName}": ${upserted}/${records.length} upserted.`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'vouchers', err.message);
    logger.error(`[syncEngine] Vouchers FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Ledger Masters ─────────────────────────────────────────────────────────────

async function syncLedgers(company) {
  const { id: companyId, tally_name: tallyName } = company;
  await syncLogs.startSync(companyId, 'ledgers');
  try {
    const xml    = templates.buildLedgerMasterRequest(tallyName);
    const raw    = await tallyClient.request(xml);
    const parsed = tallyClient.parseXml(raw);
    const records = parsers.parseLedgers(parsed, companyId);

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
    }

    await syncLogs.successSync(companyId, 'ledgers', todayIso(), { fetched: records.length, upserted });
    logger.info(`[syncEngine] Ledgers done for "${tallyName}": ${upserted} upserted.`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'ledgers', err.message);
    logger.error(`[syncEngine] Ledgers FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Stock Items ────────────────────────────────────────────────────────────────

async function syncStockItems(company) {
  const { id: companyId, tally_name: tallyName } = company;
  await syncLogs.startSync(companyId, 'stock_items');
  try {
    const xml    = templates.buildStockItemsRequest(tallyName);
    const raw    = await tallyClient.request(xml);
    const parsed = tallyClient.parseXml(raw);
    const records = parsers.parseStockItems(parsed, companyId);

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
    logger.info(`[syncEngine] Stock items done for "${tallyName}": ${upserted} upserted.`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'stock_items', err.message);
    logger.error(`[syncEngine] Stock items FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Outstanding ────────────────────────────────────────────────────────────────

async function syncOutstanding(company) {
  const { id: companyId, tally_name: tallyName } = company;
  await syncLogs.startSync(companyId, 'outstanding');
  try {
    const xml    = templates.buildOutstandingRequest(tallyName);
    const raw    = await tallyClient.request(xml);
    const parsed = tallyClient.parseXml(raw);
    const records = parsers.parseOutstanding(parsed, companyId);

    // Outstanding is a SNAPSHOT — full replace each time
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
    logger.info(`[syncEngine] Outstanding done for "${tallyName}": ${records.length} records.`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'outstanding', err.message);
    logger.error(`[syncEngine] Outstanding FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Main Sync Cycle ────────────────────────────────────────────────────────────

/**
 * Runs one complete sync cycle for all active companies.
 *
 * @param {{ includeMasters?: boolean }} options
 *   includeMasters = true  → sync ledgers, stock items, outstanding (runs on startup + daily)
 *   includeMasters = false → sync vouchers only (runs every 10 min)
 */
async function runSyncCycle({ includeMasters = false } = {}) {
  // ── 1. Tally health check ──────────────────────────────────────────────────
  const alive = await tallyClient.ping();
  if (!alive) {
    logger.warn('[syncEngine] Tally Prime not reachable — skipping this cycle.');
    return;
  }

  // ── 2. Load active companies from DB ──────────────────────────────────────
  const { rows: companies } = await pool.query(
    `SELECT * FROM companies WHERE is_active = true ORDER BY id ASC`
  );

  if (companies.length === 0) {
    logger.warn('[syncEngine] No active companies found in DB. Check TALLY_COMPANIES in .env.');
    return;
  }

  // ── 3. Process each company SEQUENTIALLY (1 vCPU constraint) ─────────────
  for (const company of companies) {
    // Skip historical companies that already completed their one-time full sync
    if (company.is_historical && company.initial_sync_done) {
      logger.info(`[syncEngine] Skipping historical company "${company.tally_name}" (already fully synced).`);
      continue;
    }

    logger.info(`[syncEngine] ══ Processing: "${company.tally_name}" (id=${company.id}) ══`);

    // Vouchers always run (incremental after first full sync)
    await syncVouchers(company);

    // Masters run on startup and daily schedule, or during first full sync
    if (includeMasters || !company.initial_sync_done) {
      await syncLedgers(company);
      await syncStockItems(company);
      await syncOutstanding(company);
    }
  }

  logger.info('[syncEngine] Sync cycle complete.');
}

module.exports = { runSyncCycle, syncVouchers, syncLedgers, syncStockItems, syncOutstanding };
