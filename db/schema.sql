-- ─────────────────────────────────────────────────────────────────────────────
-- db/schema.sql
-- Tally → PostgreSQL Sync Schema
-- ALL statements are idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
-- Safe to run on every application startup.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Companies ───────────────────────────────────────────────────────────────
-- One row per Tally company being synced.
CREATE TABLE IF NOT EXISTS companies (
  id                SERIAL PRIMARY KEY,
  name              TEXT    NOT NULL,               -- Human-readable display name
  tally_name        TEXT    NOT NULL UNIQUE,         -- Exact name used in <SVCURRENTCOMPANY>
  fiscal_year_from  DATE,                            -- FY start — used for initial full sync
  is_historical     BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE = full sync once, then skip
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE = completely excluded from sync
  initial_sync_done BOOLEAN NOT NULL DEFAULT FALSE,  -- Flipped after first full sync completes
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Sync Logs ────────────────────────────────────────────────────────────────
-- One row per (company, data_type) combination.
-- Stores the last successfully synced date used for incremental sync windows.
CREATE TABLE IF NOT EXISTS sync_logs (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  data_type        TEXT NOT NULL,        -- 'vouchers' | 'ledgers' | 'stock_items' | 'outstanding'
  status           TEXT NOT NULL DEFAULT 'never',  -- 'never' | 'running' | 'success' | 'error'
  last_synced_date DATE,                -- The toDate of the last SUCCESSFUL sync window
  records_fetched  INT  NOT NULL DEFAULT 0,
  records_upserted INT  NOT NULL DEFAULT 0,
  error_message    TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  UNIQUE (company_id, data_type)
);

-- ─── Ledger Masters ───────────────────────────────────────────────────────────
-- All ledger accounts: customers, dealers, suppliers, banks, expenses, etc.
-- parent_group tells us what kind of account it is (Sundry Debtors, Bank Accounts…)
CREATE TABLE IF NOT EXISTS ledgers (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  parent_group     TEXT,                -- Tally ledger group (used to classify account type)
  gst_no           TEXT,
  state            TEXT,
  opening_balance  NUMERIC(15, 2) NOT NULL DEFAULT 0,  -- balance at FY start (from Tally master)
  closing_balance  NUMERIC(15, 2) NOT NULL DEFAULT 0,  -- computed: opening + SUM(ledger entries)
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

-- ─── Stock Items (Product Master) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_items (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  parent_group     TEXT,                -- Stock group hierarchy
  base_unit        TEXT,
  closing_qty      NUMERIC(15, 3) NOT NULL DEFAULT 0,
  closing_value    NUMERIC(15, 2) NOT NULL DEFAULT 0,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

-- ─── Vouchers ─────────────────────────────────────────────────────────────────
-- All voucher types are stored (Sales, Credit Note, Receipt, Payment, Journal…)
-- vch_type is stored as-is from Tally — no pre-filtering for unknown company compatibility.
CREATE TABLE IF NOT EXISTS vouchers (
  id           SERIAL PRIMARY KEY,
  company_id   INT  NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vch_no       TEXT NOT NULL,
  date         DATE NOT NULL,
  vch_type     TEXT NOT NULL,           -- Raw Tally voucher type: 'Sales', 'Receipt', etc.
  party_name   TEXT,
  narration    TEXT,
  total_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
  is_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- vch_no can repeat across different voucher types (e.g. Sales/001 and Receipt/001)
  UNIQUE (company_id, vch_no, vch_type)
);

-- ─── Voucher Ledger Entries ────────────────────────────────────────────────────
-- The debit/credit ledger lines within each voucher.
CREATE TABLE IF NOT EXISTS voucher_ledger_entries (
  id                 SERIAL PRIMARY KEY,
  voucher_id         INT  NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  ledger_name        TEXT,
  amount             NUMERIC(15, 2),
  is_party_ledger    BOOLEAN NOT NULL DEFAULT FALSE,
  is_deemed_positive BOOLEAN,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Voucher Inventory Entries ────────────────────────────────────────────────
-- The stock item lines within sales/purchase vouchers.
-- Narration-parsed fields (sales_officer, area_city, state) are stored here
-- because Tally embeds them in the narration string, not in structured XML.
CREATE TABLE IF NOT EXISTS voucher_inventory_entries (
  id            SERIAL PRIMARY KEY,
  voucher_id    INT  NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  item_name     TEXT,
  quantity      NUMERIC(15, 3),
  unit          TEXT,
  rate          NUMERIC(15, 2),
  amount        NUMERIC(15, 2),
  -- Parsed from NARRATION — may be empty for companies with different narration format
  sales_officer TEXT,
  area_city     TEXT,
  state         TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Outstanding Receivables ──────────────────────────────────────────────────
-- Snapshot of party-wise outstanding as of last sync.
-- This table is fully replaced on each daily master sync (not incremental).
CREATE TABLE IF NOT EXISTS outstanding (
  id                SERIAL PRIMARY KEY,
  company_id        INT  NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  party_name        TEXT NOT NULL,
  total_outstanding NUMERIC(15, 2) NOT NULL DEFAULT 0,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, party_name)
);

-- ─── Outstanding Payables ─────────────────────────────────────────────────────
-- Snapshot of party-wise amounts WE OWE (vendors/suppliers) as of last sync.
-- Negative CLOSINGBALANCE in Tally = payable (we owe them).
-- Replaced fully on each daily master sync.
CREATE TABLE IF NOT EXISTS outstanding_payables (
  id              SERIAL PRIMARY KEY,
  company_id      INT  NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  party_name      TEXT NOT NULL,
  amount_payable  NUMERIC(15, 2) NOT NULL DEFAULT 0,  -- stored as positive
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, party_name)
);

-- ─── Trial Balance Groups ─────────────────────────────────────────────────────
-- Group-level Dr/Cr closing balances from Tally's Trial Balance report.
-- This is the AUTHORITATIVE source for P&L and Balance Sheet totals.
-- Updated on every master sync (replaces old data for the period).
--
-- Key groups and what they power on the dashboard:
--   Sales Accounts       → Trading Details / Revenue
--   Purchase Accounts    → Trading Details / COGS
--   Direct Expenses      → Gross Profit calculation
--   Indirect Incomes     → Net Profit calculation
--   Indirect Exp         → Net Profit calculation
--   Current Assets       → Balance Sheet
--   Current Liabilities  → Balance Sheet
--   Fixed Assets         → Balance Sheet
--   Loans (Liability)    → Balance Sheet / Debt-Equity ratio
--   Capital Account      → Balance Sheet / Equity
CREATE TABLE IF NOT EXISTS trial_balance_groups (
  id           SERIAL PRIMARY KEY,
  company_id   INT   NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  group_name   TEXT  NOT NULL,
  dr_amount    NUMERIC(15, 2) NOT NULL DEFAULT 0,  -- absolute DR closing (negative in raw XML)
  cr_amount    NUMERIC(15, 2) NOT NULL DEFAULT 0,  -- absolute CR closing (positive in raw XML)
  net_balance  NUMERIC(15, 2) NOT NULL DEFAULT 0,  -- positive=CR balance, negative=DR balance
  period_from  DATE  NOT NULL,
  period_to    DATE  NOT NULL,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, group_name, period_from, period_to)
);

-- ─── P&L Line Items ───────────────────────────────────────────────────────────
-- Line items from Tally's "Profit and Loss" report.
-- Different from Trial Balance — P&L is available even for CLOSED fiscal years.
-- Tag mapping from raw XML:
--   DSPDISPNAME → group_name    (e.g. "Sales Accounts", "Employee Salary")
--   BSMAINAMT   → main_amount   (group total: positive=income, negative=expense)
--   PLSUBAMT    → sub_amount    (sub-item detail within a group, may be 0)
-- Key computed metrics:
--   Revenue      = main_amount WHERE group_name = 'Sales Accounts'
--   Cost of Sales = main_amount WHERE group_name = 'Cost of Sales :'
--   Gross Profit = Revenue + Cost of Sales (cost is negative)
--   Net Profit   = SUM of all main_amount values
CREATE TABLE IF NOT EXISTS pl_items (
  id           SERIAL PRIMARY KEY,
  company_id   INT   NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  group_name   TEXT  NOT NULL,
  main_amount  NUMERIC(15, 2) NOT NULL DEFAULT 0, -- BSMAINAMT: positive=income, negative=expense
  sub_amount   NUMERIC(15, 2) NOT NULL DEFAULT 0, -- PLSUBAMT: sub-item detail
  period_from  DATE  NOT NULL,
  period_to    DATE  NOT NULL,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, group_name, period_from, period_to)
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Optimized for the query patterns used by the AWS Express API.

-- Most common: filter by company + date range (dashboard charts)
CREATE INDEX IF NOT EXISTS idx_vouchers_company_date
  ON vouchers (company_id, date DESC);

-- Filter by voucher type (Sales only, Receipts only)
CREATE INDEX IF NOT EXISTS idx_vouchers_company_type
  ON vouchers (company_id, vch_type);

-- Filter by party (dealer-specific views)
CREATE INDEX IF NOT EXISTS idx_vouchers_party
  ON vouchers (company_id, party_name);

-- Inventory entries by voucher (JOIN performance)
CREATE INDEX IF NOT EXISTS idx_inv_entries_voucher
  ON voucher_inventory_entries (voucher_id);

-- Ledger entries by voucher
CREATE INDEX IF NOT EXISTS idx_ledger_entries_voucher
  ON voucher_ledger_entries (voucher_id);

-- Outstanding sorted by amount
CREATE INDEX IF NOT EXISTS idx_outstanding_company
  ON outstanding (company_id, total_outstanding DESC);

-- Ledger master lookups
CREATE INDEX IF NOT EXISTS idx_ledgers_company_group
  ON ledgers (company_id, parent_group);
