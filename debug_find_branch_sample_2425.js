'use strict';
/**
 * debug_find_branch_sample_2425.js
 * Run ONLY while Tally has the 24-25 (historical) company connected/focused.
 * Thin wrapper around debug_find_branch_sample.js — see that file for details.
 *
 *   node debug_find_branch_sample_2425.js [fromDate] [toDate]
 *   node debug_find_branch_sample_2425.js 2025-03-01 2025-03-15 > report_2425.txt
 *
 * Default window: last 15 days → today, so pass real 24-25 dates (FY is closed).
 */
process.argv.splice(2, 0, '24-25');
require('./debug_find_branch_sample');
