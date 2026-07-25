'use strict';
/**
 * run_trial_balance.js
 * Run Trial Balance + P&L sync for all companies (no full sync needed).
 * Run: node run_trial_balance.js
 */
require('dotenv').config();
const pool                   = require('./db/pool');
const { syncTrialBalance, syncProfitAndLoss } = require('./sync/syncEngine');

async function main() {
  const { rows: companies } = await pool.query(
    'SELECT * FROM companies WHERE is_active=true ORDER BY id ASC'
  );
  console.log(`Found ${companies.length} company/companies\n`);

  for (const company of companies) {
    console.log(`\n→ [${company.id}] ${company.name}`);
    await syncTrialBalance(company);
    await syncProfitAndLoss(company);
  }

  // Show Trial Balance results
  console.log('\n\n════════════════════ TRIAL BALANCE GROUPS ════════════════════');
  const { rows: tbRows } = await pool.query(`
    SELECT company_id, group_name, dr_amount, cr_amount, net_balance
    FROM trial_balance_groups
    ORDER BY company_id, ABS(net_balance) DESC
    LIMIT 20
  `);
  for (const r of tbRows) {
    const net = r.net_balance > 0
      ? `CR ₹${Number(r.net_balance).toLocaleString('en-IN')}`
      : `DR ₹${Math.abs(Number(r.net_balance)).toLocaleString('en-IN')}`;
    console.log(`  [Co${r.company_id}] ${r.group_name.padEnd(40)} ${net}`);
  }

  // Show P&L results
  console.log('\n\n════════════════════ P&L ITEMS (main amounts only) ════════════════════');
  const { rows: plRows } = await pool.query(`
    SELECT company_id, group_name, main_amount, sub_amount
    FROM pl_items
    WHERE main_amount <> 0
    ORDER BY company_id, ABS(main_amount) DESC
    LIMIT 25
  `);
  for (const r of plRows) {
    const amt = r.main_amount > 0
      ? `INCOME ₹${Number(r.main_amount).toLocaleString('en-IN')}`
      : `EXPNS  ₹${Math.abs(Number(r.main_amount)).toLocaleString('en-IN')}`;
    console.log(`  [Co${r.company_id}] ${r.group_name.padEnd(40)} ${amt}`);
  }

  // Compute key dashboard metrics for each company
  console.log('\n\n════════════════════ DASHBOARD KPIs ════════════════════');
  for (const company of companies) {
    const { rows: kpis } = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN group_name = 'Sales Accounts' THEN main_amount END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN group_name = 'Cost of Sales :' THEN main_amount END), 0) AS cost_of_sales,
        COALESCE(SUM(CASE WHEN group_name IN ('Revenue From Operations','Indirect Incomes','Branch Trf-Sales') THEN main_amount END), 0) AS other_income,
        COALESCE(SUM(main_amount), 0) AS net_profit
      FROM pl_items
      WHERE company_id = $1 AND main_amount <> 0
    `, [company.id]);

    const k = kpis[0];
    const gross = Number(k.revenue) + Number(k.cost_of_sales);
    console.log(`\n  [Co${company.id}] ${company.name}`);
    console.log(`    Revenue (Sales):   ₹${Number(k.revenue).toLocaleString('en-IN')}`);
    console.log(`    Cost of Sales:     ₹${Number(k.cost_of_sales).toLocaleString('en-IN')}`);
    console.log(`    Gross Profit:      ₹${gross.toLocaleString('en-IN')}`);
    console.log(`    Net Profit/Loss:   ₹${Number(k.net_profit).toLocaleString('en-IN')}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
