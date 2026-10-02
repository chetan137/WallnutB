'use strict';
/**
 * debug_find_branch_sample_2526.js
 * Run ONLY while Tally has the 25-26 (current) company connected/focused.
 * Thin wrapper around debug_find_branch_sample.js — see that file for details.
 *
 *   node debug_find_branch_sample_2526.js [fromDate] [toDate]
 *   node debug_find_branch_sample_2526.js 2026-09-01 2026-09-15 > report_2526.txt
 *
 * Default window: last 15 days → today.
 */
process.argv.splice(2, 0, '25-26');
require('./debug_find_branch_sample');
