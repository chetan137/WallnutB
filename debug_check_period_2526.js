'use strict';
/**
 * debug_check_period_2526.js
 * Run ONLY while Tally has the 25-26 company focused. Wrapper around
 * debug_check_period.js (see that file).
 *   node debug_check_period_2526.js > period_2526.txt
 */
process.argv.splice(2, 0, '25-26');
require('./debug_check_period');
