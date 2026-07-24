'use strict';

const pool        = require('../db/pool');
const tallyClient = require('../tally/client');
const templates   = require('../tally/xmlTemplates');
const parsers     = require('../tally/parsers');
const syncLogs    = require('./syncLogs');
const logger      = require('../utils/logger');
const config      = require('../config');
const { subtractDays, todayIso } = require('../utils/helpers');

// ── Progress bar helper ────────────────────────────────────────────────────────

function progressBar(done, total, startMs, label) {
  if (total === 0) return;
  const pct      = Math.min(100, Math.round((done / total) * 100));
  const filled   = Math.round(pct / 5);           // 20-char bar
  const bar      = '▓'.repeat(filled) + '░'.repeat(20 - filled);
  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
  const rate     = done / ((Date.now() - startMs) / 1000);  // records/sec
  const etaSec   = rate > 0 ? Math.round((total - done) / rate) : '?';
  const eta      = typeof etaSec === 'number'
    ? (etaSec > 60 ? `${Math.floor(etaSec/60)}m ${etaSec%60}s` : `${etaSec}s`)
    : '?';

  logger.info(
    `[syncEngine]   [${bar}] ${pct}% | ${done}/${total} ${label} | ` +
    `elapsed: ${elapsedS}s | ETA: ${eta} | speed: ${rate.toFixed(0)} rec/s`
  );
}

function humanBytes(bytes) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024*1024)  return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}

function logStep(company, step, detail = '') {
  logger.info(`[syncEngine]   ▶ ${company} | ${step}${detail ? ' — ' + detail : ''}`);
}

// ── Vouchers ───────────────────────────────────────────────────────────────────

async function syncVouchers(company) {
  const { id: companyId, tally_name: tallyName, fiscal_year_from, initial_sync_done } = company;
  const t0 = Date.now();

  logStep(tallyName, 'VOUCHERS', 'starting...');
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
      logStep(tallyName, 'VOUCHERS', `FULL SYNC | range: ${fromDate} → ${toDate}`);
    } else {
      const lastSynced = await syncLogs.getLastSyncedDate(companyId, 'vouchers');
      const base       = lastSynced || toDate;
      fromDate         = subtractDays(base, config.sync.backfillDays);
      logStep(tallyName, 'VOUCHERS', `INCREMENTAL | range: ${fromDate} → ${toDate}`);
    }

    // ── Fetch from Tally ────────────────────────────────────────────────────
    logStep(tallyName, 'VOUCHERS', '📡 sending request to Tally...');
    const fetchStart = Date.now();
    const xml    = templates.buildAllVouchersRequest(tallyName, fromDate, toDate);
    const raw    = await tallyClient.request(xml);
    logStep(tallyName, 'VOUCHERS', `📥 got ${humanBytes(raw.length)} from Tally in ${((Date.now()-fetchStart)/1000).toFixed(1)}s`);

    // ── Parse XML ───────────────────────────────────────────────────────────
    logStep(tallyName, 'VOUCHERS', '⚙️  parsing XML...');
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseVouchers(parsed, companyId);
    logStep(tallyName, 'VOUCHERS', `✅ parsed ${records.length} vouchers in ${((Date.now()-parseStart)/1000).toFixed(1)}s`);

    if (records.length === 0) {
      await syncLogs.successSync(companyId, 'vouchers', toDate, { fetched: 0, upserted: 0 });
      if (!initial_sync_done) await syncLogs.markInitialSyncDone(companyId);
      logStep(tallyName, 'VOUCHERS DONE', '0 records (Tally has no data for this range)');
      return;
    }

    // ── DB Upsert ───────────────────────────────────────────────────────────
    logStep(tallyName, 'VOUCHERS', `💾 writing ${records.length} vouchers to DB...`);
    const dbStart = Date.now();
    let upserted = 0;

    for (const r of records) {
      const vRes = await pool.query(
        `INSERT INTO vouchers
           (company_id, vch_no, date, vch_type, party_name, narration, total_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, vch_no, vch_type)
         DO UPDATE SET date=EXCLUDED.date, party_name=EXCLUDED.party_name,
           narration=EXCLUDED.narration, total_amount=EXCLUDED.total_amount, synced_at=NOW()
         RETURNING id`,
        [r.companyId, r.vchNo, r.date, r.vchType, r.partyName, r.narration, r.totalAmount]
      );
      const voucherId = vRes.rows[0]?.id;
      if (!voucherId) continue;

      await pool.query('DELETE FROM voucher_ledger_entries    WHERE voucher_id=$1', [voucherId]);
      await pool.query('DELETE FROM voucher_inventory_entries WHERE voucher_id=$1', [voucherId]);

      for (const le of r.ledgerEntries) {
        await pool.query(
          `INSERT INTO voucher_ledger_entries (voucher_id,ledger_name,amount,is_party_ledger,is_deemed_positive)
           VALUES ($1,$2,$3,$4,$5)`,
          [voucherId, le.ledgerName, le.amount, le.isParty, le.isDeemedPositive]
        );
      }
      for (const ie of r.inventoryEntries) {
        await pool.query(
          `INSERT INTO voucher_inventory_entries (voucher_id,item_name,quantity,unit,rate,amount,sales_officer,area_city,state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [voucherId, ie.itemName, ie.quantity, ie.unit, ie.rate, ie.amount,
           ie.salesOfficer, ie.areaCity, ie.state]
        );
      }
      upserted++;

      // Progress every 25 records
      if (upserted % 25 === 0 || upserted === records.length) {
        progressBar(upserted, records.length, dbStart, 'vouchers');
      }
    }

    const totalS = ((Date.now() - t0) / 1000).toFixed(1);
    await syncLogs.successSync(companyId, 'vouchers', toDate, { fetched: records.length, upserted });
    if (!initial_sync_done) await syncLogs.markInitialSyncDone(companyId);
    logStep(tallyName, 'VOUCHERS ✅ DONE', `${upserted}/${records.length} in DB | total time: ${totalS}s`);

  } catch (err) {
    await syncLogs.failSync(companyId, 'vouchers', err.message);
    logger.error(`[syncEngine] ❌ VOUCHERS FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Ledger Masters ─────────────────────────────────────────────────────────────

async function syncLedgers(company) {
  const { id: companyId, tally_name: tallyName } = company;
  const t0 = Date.now();
  logStep(tallyName, 'LEDGERS', 'starting...');
  await syncLogs.startSync(companyId, 'ledgers');
  try {
    logStep(tallyName, 'LEDGERS', '📡 sending request to Tally...');
    const fetchStart = Date.now();
    const xml  = templates.buildLedgerMasterRequest(tallyName);
    const raw  = await tallyClient.request(xml);
    logStep(tallyName, 'LEDGERS', `📥 got ${humanBytes(raw.length)} in ${((Date.now()-fetchStart)/1000).toFixed(1)}s`);

    logStep(tallyName, 'LEDGERS', '⚙️  parsing XML...');
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseLedgers(parsed, companyId);
    logStep(tallyName, 'LEDGERS', `✅ parsed ${records.length} ledgers in ${((Date.now()-parseStart)/1000).toFixed(1)}s`);

    logStep(tallyName, 'LEDGERS', `💾 writing ${records.length} ledgers to DB...`);
    const dbStart = Date.now();
    let upserted = 0;

    for (const r of records) {
      await pool.query(
        `INSERT INTO ledgers (company_id,name,parent_group,closing_balance,gst_no,state,synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (company_id,name)
         DO UPDATE SET parent_group=EXCLUDED.parent_group, closing_balance=EXCLUDED.closing_balance,
           gst_no=EXCLUDED.gst_no, state=EXCLUDED.state, synced_at=NOW()`,
        [r.companyId, r.name, r.parentGroup, r.closingBalance, r.gstNo, r.state]
      );
      upserted++;
      if (upserted % 100 === 0 || upserted === records.length) {
        progressBar(upserted, records.length, dbStart, 'ledgers');
      }
    }

    const totalS = ((Date.now() - t0) / 1000).toFixed(1);
    await syncLogs.successSync(companyId, 'ledgers', todayIso(), { fetched: records.length, upserted });
    logStep(tallyName, 'LEDGERS ✅ DONE', `${upserted} in DB | total time: ${totalS}s`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'ledgers', err.message);
    logger.error(`[syncEngine] ❌ LEDGERS FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Stock Items ────────────────────────────────────────────────────────────────

async function syncStockItems(company) {
  const { id: companyId, tally_name: tallyName } = company;
  const t0 = Date.now();
  logStep(tallyName, 'STOCK ITEMS', 'starting...');
  await syncLogs.startSync(companyId, 'stock_items');
  try {
    logStep(tallyName, 'STOCK ITEMS', '📡 sending request to Tally...');
    const fetchStart = Date.now();
    const xml  = templates.buildStockItemsRequest(tallyName);
    const raw  = await tallyClient.request(xml);
    logStep(tallyName, 'STOCK ITEMS', `📥 got ${humanBytes(raw.length)} in ${((Date.now()-fetchStart)/1000).toFixed(1)}s`);

    logStep(tallyName, 'STOCK ITEMS', '⚙️  parsing XML...');
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseStockItems(parsed, companyId);
    logStep(tallyName, 'STOCK ITEMS', `✅ parsed ${records.length} items in ${((Date.now()-parseStart)/1000).toFixed(1)}s`);

    logStep(tallyName, 'STOCK ITEMS', `💾 writing ${records.length} items to DB...`);
    const dbStart = Date.now();
    let upserted = 0;

    for (const r of records) {
      await pool.query(
        `INSERT INTO stock_items (company_id,name,parent_group,base_unit,closing_qty,closing_value,synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (company_id,name)
         DO UPDATE SET parent_group=EXCLUDED.parent_group, base_unit=EXCLUDED.base_unit,
           closing_qty=EXCLUDED.closing_qty, closing_value=EXCLUDED.closing_value, synced_at=NOW()`,
        [r.companyId, r.name, r.parentGroup, r.baseUnit, r.closingQty, r.closingValue]
      );
      upserted++;
      if (upserted % 50 === 0 || upserted === records.length) {
        progressBar(upserted, records.length, dbStart, 'stock items');
      }
    }

    const totalS = ((Date.now() - t0) / 1000).toFixed(1);
    await syncLogs.successSync(companyId, 'stock_items', todayIso(), { fetched: records.length, upserted });
    logStep(tallyName, 'STOCK ITEMS ✅ DONE', `${upserted} in DB | total time: ${totalS}s`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'stock_items', err.message);
    logger.error(`[syncEngine] ❌ STOCK ITEMS FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Outstanding ────────────────────────────────────────────────────────────────

async function syncOutstanding(company) {
  const { id: companyId, tally_name: tallyName } = company;
  const t0 = Date.now();
  logStep(tallyName, 'OUTSTANDING', 'starting...');
  await syncLogs.startSync(companyId, 'outstanding');
  try {
    logStep(tallyName, 'OUTSTANDING', '📡 sending request to Tally...');
    const fetchStart = Date.now();
    const xml  = templates.buildOutstandingRequest(tallyName);
    const raw  = await tallyClient.request(xml);
    logStep(tallyName, 'OUTSTANDING', `📥 got ${humanBytes(raw.length)} in ${((Date.now()-fetchStart)/1000).toFixed(1)}s`);

    logStep(tallyName, 'OUTSTANDING', '⚙️  parsing XML...');
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseOutstanding(parsed, companyId);
    logStep(tallyName, 'OUTSTANDING', `✅ parsed ${records.length} records in ${((Date.now()-parseStart)/1000).toFixed(1)}s`);

    logStep(tallyName, 'OUTSTANDING', `💾 replacing snapshot (${records.length} records)...`);
    const dbStart = Date.now();
    await pool.query('DELETE FROM outstanding WHERE company_id=$1', [companyId]);
    let inserted = 0;
    for (const r of records) {
      await pool.query(
        `INSERT INTO outstanding (company_id,party_name,total_outstanding,synced_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (company_id,party_name)
         DO UPDATE SET total_outstanding=EXCLUDED.total_outstanding, synced_at=NOW()`,
        [r.companyId, r.partyName, r.totalOutstanding]
      );
      inserted++;
      if (inserted % 50 === 0 || inserted === records.length) {
        progressBar(inserted, records.length, dbStart, 'outstanding');
      }
    }

    const totalS = ((Date.now() - t0) / 1000).toFixed(1);
    await syncLogs.successSync(companyId, 'outstanding', todayIso(), { fetched: records.length, upserted: records.length });
    logStep(tallyName, 'OUTSTANDING ✅ DONE', `${inserted} records | total time: ${totalS}s`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'outstanding', err.message);
    logger.error(`[syncEngine] ❌ OUTSTANDING FAILED for "${tallyName}": ${err.message}`);
  }
}

// ── Main Sync Cycle ────────────────────────────────────────────────────────────

async function runSyncCycle({ includeMasters = false } = {}) {
  const cycleStart = Date.now();
  logger.info('[syncEngine] ─────────────────────────────────────');
  logger.info('[syncEngine] Sync cycle START');
  logger.info('[syncEngine] ─────────────────────────────────────');

  // 1. Tally health check
  logger.info('[syncEngine] 🔍 Checking Tally is alive...');
  const alive = await tallyClient.ping();
  if (!alive) {
    logger.warn('[syncEngine] ❌ Tally NOT reachable — skipping cycle.');
    return;
  }
  logger.info('[syncEngine] ✅ Tally is alive');

  // 2. Load active companies
  const { rows: companies } = await pool.query(
    `SELECT * FROM companies WHERE is_active=true ORDER BY id ASC`
  );
  logger.info(`[syncEngine] 📋 ${companies.length} active company/companies found`);

  if (companies.length === 0) {
    logger.warn('[syncEngine] No active companies — check TALLY_COMPANIES in .env.');
    return;
  }

  // 3. Process each company SEQUENTIALLY
  for (const company of companies) {
    if (company.is_historical && company.initial_sync_done) {
      logger.info(`[syncEngine] ⏭  Skipping "${company.name}" (historical, already fully synced)`);
      continue;
    }

    logger.info('[syncEngine] ══════════════════════════════════════════');
    logger.info(`[syncEngine] ▶▶ Company: "${company.name}"  (id=${company.id})`);
    logger.info('[syncEngine] ══════════════════════════════════════════');
    const compStart = Date.now();

    await syncVouchers(company);

    if (includeMasters || !company.initial_sync_done) {
      await syncLedgers(company);
      await syncStockItems(company);
      await syncOutstanding(company);
    }

    logger.info(`[syncEngine] ✅ Company "${company.name}" done in ${((Date.now()-compStart)/1000).toFixed(1)}s`);
  }

  logger.info('[syncEngine] ─────────────────────────────────────');
  logger.info(`[syncEngine] Sync cycle COMPLETE — total: ${((Date.now()-cycleStart)/1000).toFixed(1)}s`);
  logger.info('[syncEngine] ─────────────────────────────────────');
}

module.exports = { runSyncCycle, syncVouchers, syncLedgers, syncStockItems, syncOutstanding };
