'use strict';
/**
 * debug_voucher_access_2526.js
 * Run ONLY while Tally has the 25-26 company focused. Wrapper around
 * debug_voucher_access.js (see that file).
 *   node debug_voucher_access_2526.js > access_2526.txt
 */
process.argv.splice(2, 0, '25-26');
require('./debug_voucher_access');
