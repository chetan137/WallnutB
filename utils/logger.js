'use strict';

/**
 * utils/logger.js
 * Minimal timestamp logger. Keeps RAM usage near zero (no file writes by default).
 * Set LOG_LEVEL=warn in production to reduce noise.
 */

const LEVELS = { error: 0, warn: 1, info: 2 };
const current = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function log(level, msg) {
  if (LEVELS[level] > current) return;
  const ts  = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = {
  info:  (msg) => log('info',  msg),
  warn:  (msg) => log('warn',  msg),
  error: (msg) => log('error', msg),
};
