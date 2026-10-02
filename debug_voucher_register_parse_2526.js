'use strict';
/**
 * debug_voucher_register_parse_2526.js
 * Run ONLY while Tally has the 25-26 company focused. Wrapper around
 * debug_voucher_register_parse.js (see that file).
 *   node debug_voucher_register_parse_2526.js [YYYY-MM-DD] > register_parse.txt
 */
process.argv.splice(2, 0, '25-26');
require('./debug_voucher_register_parse');
