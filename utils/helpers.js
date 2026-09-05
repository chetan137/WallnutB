'use strict';

/**
 * utils/helpers.js
 * Shared pure utility functions used across tally/ and sync/ modules.
 */

/** Escapes special XML characters to prevent malformed requests. */
function escapeXml(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Converts ISO date string "YYYY-MM-DD" to Tally format "YYYYMMDD".
 * Also handles Date objects.
 */
function isoToTally(dateInput) {
  const s = dateInput instanceof Date
    ? dateInput.toISOString().slice(0, 10)
    : String(dateInput).slice(0, 10);
  return s.replace(/-/g, '');
}

/**
 * Converts Tally date "YYYYMMDD" to ISO "YYYY-MM-DD".
 * Returns null if input is not a valid 8-digit date string.
 */
function tallyToIso(tallyDate) {
  const s = String(tallyDate || '').replace(/\D/g, '');
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Safely convert a DB date value (Date object or string) to 'YYYY-MM-DD'.
 * CRITICAL: Do NOT use .toISOString().slice(0,10) for DATE values from
 * PostgreSQL. In India (UTC+5:30), the pg driver creates the Date at local
 * midnight (2024-04-01 00:00 IST = 2024-03-31 18:30 UTC), so toISOString()
 * shifts the date back by one day. Use LOCAL date components instead.
 *
 * @param {Date|string|null} d
 * @returns {string|null}
 */
function dbDateToIso(d) {
  if (!d) return null;
  if (d instanceof Date) {
    const y   = d.getFullYear();
    const m   = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  // Already a string (pg can return DATE as string in some versions)
  return String(d).slice(0, 10);
}

/**
 * Safely reads any Tally XML value (string, object with _, or array).
 * Always returns a trimmed string. Never throws.
 */
function safeStr(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) val = val[0];
  if (typeof val === 'object') return String(val?._ ?? val?.['#text'] ?? '').trim();
  return String(val).trim();
}

/**
 * Safely parses a Tally numeric string ("1,23,456.78") to a JS number.
 * Returns 0 on any failure.
 */
function safeNum(val) {
  const s = safeStr(val).replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Wraps a value in an array if it isn't one already. */
function ensureArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Subtracts N days from an ISO date string and returns the new ISO date.
 * @param {string} isoDate  e.g. "2026-07-20"
 * @param {number} days
 * @returns {string}
 */
function subtractDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Returns today's date as "YYYY-MM-DD" in local time. */
function todayIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const TALLY_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Converts ISO date "YYYY-MM-DD" to Tally's literal short-date format
 * "D-Mon-YYYY" (e.g. "1-Apr-2024") — the format Tally's TDL formula engine
 * accepts for a literal $$Date:'...' value inside a FILTER formula.
 *
 * Verified live (debug_safe_2425.js STEP D): STATICVARIABLES SVFROMDATE/
 * SVTODATE do NOT filter a TYPE=Voucher ad-hoc Collection, and referencing
 * them by name (##SVFROMDATE/##SVTODATE) inside a FILTER formula silently
 * resolves to nothing (the comparison stayed always-true). A literal date
 * value embedded directly in the formula does work — confirmed a 1-week
 * window returned 161 of a company's 10,689 total vouchers.
 */
function isoToTallyLiteral(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d}-${TALLY_MONTHS[m - 1]}-${y}`;
}

/**
 * Splits [fromIso, toIso] into consecutive date ranges of at most
 * `maxDaysPerChunk` days each (clipped to the overall bounds). Used to
 * chunk a large voucher fetch into requests small enough that the sync
 * process doesn't run out of memory parsing the response.
 *
 * BUG FIX HISTORY: a single company here has 10,689 vouchers.
 *  - Fetching them ALL in one request (with ledger/inventory entries)
 *    crashed Tally's own process outright — a genuine "Software Exception
 *    c0000005 (Memory Access Violation)" dialog.
 *  - Chunking by calendar MONTH (~27.5 MB raw per chunk for this company's
 *    busiest month) avoided that Tally-side crash, but then blew past
 *    tallybackend's own pm2 max_memory_restart (200 MB): parsing a 27.5 MB
 *    XML string into a full JS object tree used well over 200 MB, so pm2
 *    killed and restarted the whole process every time, always mid-way
 *    through the very first chunk, before anything could reach Postgres.
 *    The VM has 8 GB RAM (not the 4 GB originally assumed when 200 MB was
 *    set), so pm2.config.js raised max_memory_restart to 512 MB and the
 *    default chunk size here dropped from a month to a week — comfortably
 *    inside that ceiling even with the parser's memory overhead.
 *
 * @param {string} fromIso           "YYYY-MM-DD"
 * @param {string} toIso             "YYYY-MM-DD"
 * @param {number} [maxDaysPerChunk=7]
 * @returns {Array<{from: string, to: string}>}
 */
function buildDateChunks(fromIso, toIso, maxDaysPerChunk = 7) {
  const ranges = [];
  let cursor = new Date(`${fromIso}T00:00:00`);
  const end  = new Date(`${toIso}T00:00:00`);
  if (isNaN(cursor) || isNaN(end) || cursor > end) return ranges;

  const toIsoStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  while (cursor <= end) {
    const rangeFrom = new Date(cursor);
    const candidate = new Date(cursor);
    candidate.setDate(candidate.getDate() + maxDaysPerChunk - 1);
    const rangeTo = candidate < end ? candidate : end;

    ranges.push({ from: toIsoStr(rangeFrom), to: toIsoStr(rangeTo) });

    cursor = new Date(rangeTo);
    cursor.setDate(cursor.getDate() + 1);
  }
  return ranges;
}

module.exports = {
  escapeXml, isoToTally, tallyToIso, dbDateToIso, safeStr, safeNum, ensureArray,
  subtractDays, todayIso, isoToTallyLiteral, buildDateChunks,
};
