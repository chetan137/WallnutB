'use strict';
/**
 * debug_check_months_2526.js
 * Run ONLY while Tally has the 25-26 company focused. Wrapper around
 * debug_check_months.js (see that file).
 *   node debug_check_months_2526.js > months_2526.txt
 */
process.argv.splice(2, 0, '25-26');
require('./debug_check_months');
