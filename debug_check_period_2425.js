'use strict';
/**
 * debug_check_period_2425.js
 * Run ONLY while Tally has the 24-25 company focused. Wrapper around
 * debug_check_period.js (see that file). Period defaults to the 24-25 FY.
 *   node debug_check_period_2425.js > period_2425.txt
 */
process.argv.splice(2, 0, '24-25', process.argv[2] || '2024-04-01', process.argv[3] || '2025-03-31');
process.argv.length = 5;
require('./debug_check_period');
