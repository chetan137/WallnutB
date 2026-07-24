'use strict';

const pool        = require('../db/pool');
const tallyClient = require('../tally/client');
const templates   = require('../tally/xmlTemplates');
const parsers     = require('../tally/parsers');
const syncLogs    = require('./syncLogs');
const logger      = require('../utils/logger');
const config      = require('../config');
const { subtractDays, todayIso } = require('../utils/helpers');

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanMs(ms) {
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function estimateParseTime(bytes) {
  // ~0.7 MB/s parse speed on this hardware
  const seconds = Math.ceil(bytes / (1024 * 1024) / 0.7);
  return `~${seconds}s`;
}

function progressBar(label, done, total, startMs) {
  if (total === 0) return;
  const pct    = Math.min(100, Math.round((done / total) * 100));
  const filled = Math.round(pct / 5);
  const bar    = '▓'.repeat(filled) + '░'.repeat(20 - filled);
  const elapsed = Date.now() - startMs;
  const rate   = done > 0 ? done / (elapsed / 1000) : 0;
  const remain = rate > 0 ? Math.round((total - done) / rate) : null;
  const eta    = remain !== null ? `ETA: ${humanMs(remain * 1000)}` : 'ETA: calculating...';
  const speed  = rate > 0 ? `${rate.toFixed(0)} rec/s` : '';
  logger.info(
    `[syncEngine]   [${bar}] ${String(pct).padStart(3)}%` +
    ` | ${done}/${total} ${label}` +
    ` | elapsed: ${humanMs(elapsed)}` +
    ` | ${eta} | ${speed}`
  );
}

/** Run all inserts inside a single transaction — 10-50x faster than auto-commit */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function logStep(label, msg) {
  logger.info(`[syncEngine]   ▶ ${label} | ${msg}`);
}

// ── Vouchers ───────────────────────────────────────────────────────────────────

async function syncVouchers(company) {
  const { id: companyId, tally_name: tallyName, fiscal_year_from, initial_sync_done } = company;
  const t0 = Date.now();
  logStep('VOUCHERS', `start — company: "${company.name}"`);
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
      logStep('VOUCHERS', `FULL SYNC | range: ${fromDate} → ${toDate}`);
    } else {
      const lastSynced = await syncLogs.getLastSyncedDate(companyId, 'vouchers');
      const base       = lastSynced || toDate;
      fromDate         = subtractDays(base, config.sync.backfillDays);
      logStep('VOUCHERS', `INCREMENTAL | range: ${fromDate} → ${toDate}`);
    }

    // ── Fetch ────────────────────────────────────────────────────────────────
    logStep('VOUCHERS', '📡 sending to Tally...');
    const fetchStart = Date.now();
    const xml  = templates.buildAllVouchersRequest(tallyName, fromDate, toDate);
    const raw  = await tallyClient.request(xml);
    logStep('VOUCHERS', `📥 got ${humanBytes(raw.length)} in ${humanMs(Date.now() - fetchStart)}`);

    // ── Parse ────────────────────────────────────────────────────────────────
    const estTime = estimateParseTime(raw.length);
    logStep('VOUCHERS', `⚙️  parsing ${humanBytes(raw.length)} — NOTE: output pauses here ${estTime} (normal)`);
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseVouchers(parsed, companyId);
    logStep('VOUCHERS', `✅ parsed ${records.length} vouchers in ${humanMs(Date.now() - parseStart)}`);

    if (records.length === 0) {
      await syncLogs.successSync(companyId, 'vouchers', toDate, { fetched: 0, upserted: 0 });
      if (!initial_sync_done) await syncLogs.markInitialSyncDone(companyId);
      logStep('VOUCHERS', '⏭  0 records — Tally has no data for this range');
      return;
    }

    // ── DB Upsert (inside transaction) ───────────────────────────────────────
    logStep('VOUCHERS', `💾 writing ${records.length} vouchers inside 1 transaction (fast)...`);
    const dbStart = Date.now();
    let upserted = 0;

    await withTransaction(async (client) => {
      for (const r of records) {
        const vRes = await client.query(
          `INSERT INTO vouchers (company_id,vch_no,date,vch_type,party_name,narration,total_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (company_id,vch_no,vch_type)
           DO UPDATE SET date=EXCLUDED.date, party_name=EXCLUDED.party_name,
             narration=EXCLUDED.narration, total_amount=EXCLUDED.total_amount, synced_at=NOW()
           RETURNING id`,
          [r.companyId, r.vchNo, r.date, r.vchType, r.partyName, r.narration, r.totalAmount]
        );
        const voucherId = vRes.rows[0]?.id;
        if (!voucherId) continue;

        await client.query('DELETE FROM voucher_ledger_entries    WHERE voucher_id=$1', [voucherId]);
        await client.query('DELETE FROM voucher_inventory_entries WHERE voucher_id=$1', [voucherId]);

        for (const le of r.ledgerEntries) {
          await client.query(
            `INSERT INTO voucher_ledger_entries (voucher_id,ledger_name,amount,is_party_ledger,is_deemed_positive)
             VALUES ($1,$2,$3,$4,$5)`,
            [voucherId, le.ledgerName, le.amount, le.isParty, le.isDeemedPositive]
          );
        }
        for (const ie of r.inventoryEntries) {
          await client.query(
            `INSERT INTO voucher_inventory_entries (voucher_id,item_name,quantity,unit,rate,amount,sales_officer,area_city,state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [voucherId, ie.itemName, ie.quantity, ie.unit, ie.rate, ie.amount,
             ie.salesOfficer, ie.areaCity, ie.state]
          );
        }
        upserted++;
        if (upserted % 25 === 0 || upserted === records.length) {
          progressBar('vouchers', upserted, records.length, dbStart);
        }
      }
    });

    await syncLogs.successSync(companyId, 'vouchers', toDate, { fetched: records.length, upserted });
    if (!initial_sync_done) await syncLogs.markInitialSyncDone(companyId);
    logStep('VOUCHERS ✅', `${upserted}/${records.length} in DB | DB write: ${humanMs(Date.now()-dbStart)} | total: ${humanMs(Date.now()-t0)}`);

  } catch (err) {
    await syncLogs.failSync(companyId, 'vouchers', err.message);
    logger.error(`[syncEngine] ❌ VOUCHERS FAILED "${company.name}": ${err.message}`);
  }
}

// ── Ledger Masters (STREAMING) ────────────────────────────────────────────────
// Uses SAX streaming parser — never loads 55 MB into memory.
// Shows real-time download + parse progress every 2 MB.

async function syncLedgers(company) {
  const { id: companyId, tally_name: tallyName } = company;
  const t0 = Date.now();
  logStep('LEDGERS', `start — company: "${company.name}"`);
  await syncLogs.startSync(companyId, 'ledgers');

  try {
    // ── Open streaming HTTP connection to Tally ───────────────────────────
    logStep('LEDGERS', '📡 opening stream to Tally (large response expected)...');
    const xml    = templates.buildLedgerMasterRequest(tallyName);
    const stream = await tallyClient.requestStream(xml);

    // ── Stream-parse: download + SAX parse simultaneously ────────────────
    logStep('LEDGERS', '⚙️  streaming download + parsing simultaneously...');
    let lastLoggedMB = 0;

    const { streamParseLedgers } = require('../tally/streamParser');

    const records = await streamParseLedgers(stream, companyId, (bytesReceived, recordsParsed) => {
      const mb = bytesReceived / (1024 * 1024);
      if (mb - lastLoggedMB >= 4) {   // log every 4 MB
        logStep('LEDGERS',
          `📥 downloaded ${mb.toFixed(1)} MB | parsed ${recordsParsed} ledgers so far | ` +
          `elapsed: ${humanMs(Date.now() - t0)}`
        );
        lastLoggedMB = mb;
      }
    });

    logStep('LEDGERS', `✅ stream complete — ${records.length} ledgers parsed in ${humanMs(Date.now() - t0)}`);

    if (records.length === 0) {
      await syncLogs.successSync(companyId, 'ledgers', todayIso(), { fetched: 0, upserted: 0 });
      logStep('LEDGERS', '⏭  0 ledgers found in Tally response');
      return;
    }

    // ── DB Upsert inside single transaction (fast) ───────────────────────
    logStep('LEDGERS', `💾 writing ${records.length} ledgers to DB (1 transaction)...`);
    const dbStart = Date.now();
    let upserted  = 0;

    await withTransaction(async (client) => {
      for (const r of records) {
        await client.query(
          `INSERT INTO ledgers (company_id,name,parent_group,closing_balance,gst_no,state,synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (company_id,name)
           DO UPDATE SET parent_group=EXCLUDED.parent_group, closing_balance=EXCLUDED.closing_balance,
             gst_no=EXCLUDED.gst_no, state=EXCLUDED.state, synced_at=NOW()`,
          [r.companyId, r.name, r.parentGroup, r.closingBalance, r.gstNo, r.state]
        );
        upserted++;
        if (upserted % 100 === 0 || upserted === records.length) {
          progressBar('ledgers', upserted, records.length, dbStart);
        }
      }
    });

    await syncLogs.successSync(companyId, 'ledgers', todayIso(), { fetched: records.length, upserted });
    logStep('LEDGERS ✅', `${upserted} in DB | DB write: ${humanMs(Date.now()-dbStart)} | total: ${humanMs(Date.now()-t0)}`);

  } catch (err) {
    await syncLogs.failSync(companyId, 'ledgers', err.message);
    logger.error(`[syncEngine] ❌ LEDGERS FAILED "${company.name}": ${err.message}`);
    logger.error(err.stack);
  }
}


// ── Stock Items ────────────────────────────────────────────────────────────────

async function syncStockItems(company) {
  const { id: companyId, tally_name: tallyName } = company;
  const t0 = Date.now();
  logStep('STOCK ITEMS', `start — company: "${company.name}"`);
  await syncLogs.startSync(companyId, 'stock_items');
  try {
    logStep('STOCK ITEMS', '📡 sending to Tally...');
    const fetchStart = Date.now();
    const xml  = templates.buildStockItemsRequest(tallyName);
    const raw  = await tallyClient.request(xml);
    logStep('STOCK ITEMS', `📥 got ${humanBytes(raw.length)} in ${humanMs(Date.now()-fetchStart)}`);

    logStep('STOCK ITEMS', `⚙️  parsing ${humanBytes(raw.length)} — NOTE: output pauses ${estimateParseTime(raw.length)} (normal)`);
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseStockItems(parsed, companyId);
    logStep('STOCK ITEMS', `✅ parsed ${records.length} items in ${humanMs(Date.now()-parseStart)}`);

    if (records.length === 0) {
      await syncLogs.successSync(companyId, 'stock_items', todayIso(), { fetched: 0, upserted: 0 });
      logStep('STOCK ITEMS', '⏭  0 records from Tally');
      return;
    }

    logStep('STOCK ITEMS', `💾 writing ${records.length} items inside 1 transaction...`);
    const dbStart = Date.now();
    let upserted = 0;

    await withTransaction(async (client) => {
      for (const r of records) {
        await client.query(
          `INSERT INTO stock_items (company_id,name,parent_group,base_unit,closing_qty,closing_value,synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (company_id,name)
           DO UPDATE SET parent_group=EXCLUDED.parent_group, base_unit=EXCLUDED.base_unit,
             closing_qty=EXCLUDED.closing_qty, closing_value=EXCLUDED.closing_value, synced_at=NOW()`,
          [r.companyId, r.name, r.parentGroup, r.baseUnit, r.closingQty, r.closingValue]
        );
        upserted++;
        if (upserted % 50 === 0 || upserted === records.length) {
          progressBar('stock items', upserted, records.length, dbStart);
        }
      }
    });

    await syncLogs.successSync(companyId, 'stock_items', todayIso(), { fetched: records.length, upserted });
    logStep('STOCK ITEMS ✅', `${upserted} in DB | total: ${humanMs(Date.now()-t0)}`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'stock_items', err.message);
    logger.error(`[syncEngine] ❌ STOCK ITEMS FAILED "${company.name}": ${err.message}`);
  }
}

// ── Outstanding ────────────────────────────────────────────────────────────────

async function syncOutstanding(company) {
  const { id: companyId, tally_name: tallyName } = company;
  const t0 = Date.now();
  logStep('OUTSTANDING', `start — company: "${company.name}"`);
  await syncLogs.startSync(companyId, 'outstanding');
  try {
    logStep('OUTSTANDING', '📡 sending to Tally...');
    const fetchStart = Date.now();
    const xml  = templates.buildOutstandingRequest(tallyName);
    const raw  = await tallyClient.request(xml);
    logStep('OUTSTANDING', `📥 got ${humanBytes(raw.length)} in ${humanMs(Date.now()-fetchStart)}`);

    logStep('OUTSTANDING', `⚙️  parsing ${humanBytes(raw.length)} — NOTE: output pauses ${estimateParseTime(raw.length)} (normal)`);
    const parseStart = Date.now();
    const parsed  = tallyClient.parseXml(raw);
    const records = parsers.parseOutstanding(parsed, companyId);
    logStep('OUTSTANDING', `✅ parsed ${records.length} records in ${humanMs(Date.now()-parseStart)}`);

    if (records.length === 0) {
      await syncLogs.successSync(companyId, 'outstanding', todayIso(), { fetched: 0, upserted: 0 });
      logStep('OUTSTANDING', '⏭  0 records from Tally');
      return;
    }

    logStep('OUTSTANDING', `💾 replacing ${records.length} records inside 1 transaction...`);
    const dbStart = Date.now();
    let inserted = 0;

    await withTransaction(async (client) => {
      await client.query('DELETE FROM outstanding WHERE company_id=$1', [companyId]);
      for (const r of records) {
        await client.query(
          `INSERT INTO outstanding (company_id,party_name,total_outstanding,synced_at)
           VALUES ($1,$2,$3,NOW())
           ON CONFLICT (company_id,party_name)
           DO UPDATE SET total_outstanding=EXCLUDED.total_outstanding, synced_at=NOW()`,
          [r.companyId, r.partyName, r.totalOutstanding]
        );
        inserted++;
        if (inserted % 50 === 0 || inserted === records.length) {
          progressBar('outstanding', inserted, records.length, dbStart);
        }
      }
    });

    await syncLogs.successSync(companyId, 'outstanding', todayIso(), { fetched: records.length, upserted: records.length });
    logStep('OUTSTANDING ✅', `${inserted} records | total: ${humanMs(Date.now()-t0)}`);
  } catch (err) {
    await syncLogs.failSync(companyId, 'outstanding', err.message);
    logger.error(`[syncEngine] ❌ OUTSTANDING FAILED "${company.name}": ${err.message}`);
  }
}

// ── Main Sync Cycle ────────────────────────────────────────────────────────────

async function runSyncCycle({ includeMasters = false } = {}) {
  const cycleStart = Date.now();

  logger.info('[syncEngine] ════════════════════════════════════════════');
  logger.info('[syncEngine]  SYNC CYCLE START');
  logger.info('[syncEngine] ════════════════════════════════════════════');

  // 1. Tally health check
  logger.info('[syncEngine] 🔍 Pinging Tally...');
  const alive = await tallyClient.ping();
  if (!alive) {
    logger.warn('[syncEngine] ❌ Tally NOT reachable — skipping cycle.');
    return;
  }
  logger.info('[syncEngine] ✅ Tally is alive');

  // 2. Load active companies
  const { rows: companies } = await pool.query(
    'SELECT * FROM companies WHERE is_active=true ORDER BY id ASC'
  );
  logger.info(`[syncEngine] 📋 ${companies.length} company/companies to process`);

  if (companies.length === 0) {
    logger.warn('[syncEngine] No active companies — check TALLY_COMPANIES in .env.');
    return;
  }

  // 3. Process sequentially
  for (const company of companies) {
    if (company.is_historical && company.initial_sync_done) {
      logger.info(`[syncEngine] ⏭  Skipping "${company.name}" (historical, fully synced already)`);
      continue;
    }

    const compStart = Date.now();
    logger.info(`[syncEngine] ────────────────────────────────────────────`);
    logger.info(`[syncEngine]  ▶▶ COMPANY: "${company.name}"  (id=${company.id})`);
    logger.info(`[syncEngine]     historical=${company.is_historical} | initial_done=${company.initial_sync_done}`);
    logger.info(`[syncEngine] ────────────────────────────────────────────`);

    await syncVouchers(company);

    if (includeMasters || !company.initial_sync_done) {
      logger.info(`[syncEngine]   [masters: ledgers → stock items → outstanding]`);
      await syncLedgers(company);
      await syncStockItems(company);
      await syncOutstanding(company);
    } else {
      logger.info(`[syncEngine]   [masters skipped — incremental voucher-only cycle]`);
    }

    logger.info(`[syncEngine]  ✅ COMPANY "${company.name}" done in ${humanMs(Date.now()-compStart)}`);
  }

  logger.info('[syncEngine] ════════════════════════════════════════════');
  logger.info(`[syncEngine]  SYNC CYCLE COMPLETE — total: ${humanMs(Date.now()-cycleStart)}`);
  logger.info('[syncEngine] ════════════════════════════════════════════');
}

module.exports = { runSyncCycle, syncVouchers, syncLedgers, syncStockItems, syncOutstanding };
