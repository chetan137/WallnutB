'use strict';

const { Pool } = require('pg');
const config   = require('../config');
const logger   = require('../utils/logger');

/**
 * db/pool.js
 * Single shared pg connection pool for the whole process.
 * max:5 keeps memory low on the 4 GB VM.
 */
const pool = new Pool(config.pg);

// Log unexpected idle-client errors but don't crash the process
pool.on('error', (err) => {
  logger.error(`[pg-pool] Unexpected client error: ${err.message}`);
});

module.exports = pool;
