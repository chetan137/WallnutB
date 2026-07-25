'use strict';
/**
 * run_trial_balance.js
 * Run ONLY the trial balance sync for all companies.
 * Use when you need to refresh Trial Balance data without a full sync.
 * Run: node run_trial_balance.js
 */
require('dotenv').config();
const { pool }           = require('./db/pool');
const { syncTrialBalance } = require('./sync/syncEngine');

async function main() {
  const { rows: companies } = await pool.query(
    'SELECT * FROM companies WHERE is_active=true ORDER BY id ASC'
  );
  console.log(`Found ${companies.length} company/companies\n`);

  for (const company of companies) {
    console.log(`\n→ Syncing Trial Balance for: ${company.name}`);
    await syncTrialBalance(company);
  }

  // Show results
  const { rows } = await pool.query(`
    SELECT company_id, group_name, dr_amount, cr_amount, net_balance
    FROM trial_balance_groups
    ORDER BY company_id, ABS(net_balance) DESC
    LIMIT 30
  `);
  console.log('\n=== Trial Balance Groups in DB ===');
  for (const r of rows) {
    const net = r.net_balance > 0
      ? `CR ${Number(r.net_balance).toLocaleString('en-IN')}`
      : `DR ${Math.abs(Number(r.net_balance)).toLocaleString('en-IN')}`;
    console.log(`  [Co${r.company_id}] ${r.group_name.padEnd(35)} ${net}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
