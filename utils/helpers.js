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

module.exports = { escapeXml, isoToTally, tallyToIso, dbDateToIso, safeStr, safeNum, ensureArray, subtractDays, todayIso };
