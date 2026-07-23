# VM Deployment Guide — Tally Sync Service

> **Target**: Windows Server VM (AntraCloud) running TallyPrime
> **Starting point**: Fresh VM — no Node.js, no PostgreSQL installed
> **Only tool needed**: Windows PowerShell (run as Administrator)
> **Result**: PostgreSQL + Node.js installed, service auto-syncs both Tally companies every 10 minutes, survives reboots

---

## Prerequisites Checklist

Before starting, confirm these on the VM:
- [ ] TallyPrime is running on Port **9000**
- [ ] **Both companies are open/loaded** in TallyPrime simultaneously
- [ ] You know the **exact company names** as shown in TallyPrime → press F1 → copy the name exactly
- [ ] PowerShell is available (every Windows has it — search "PowerShell", right-click → **Run as Administrator**)

---

## Step 1 — Install PostgreSQL (terminal only, no GUI)

> All commands below are run in **PowerShell as Administrator**

### 1a. Download PostgreSQL installer

```powershell
# Download PostgreSQL 16 installer (~300 MB)
Invoke-WebRequest `
  -Uri "https://get.enterprisedb.com/postgresql/postgresql-16.3-1-windows-x64.exe" `
  -OutFile "C:\pg-installer.exe"
```

### 1b. Run silent install (no wizard, no GUI)

```powershell
# This installs PostgreSQL silently with default settings
# --unattendedmodeui none  → no GUI popups
# --mode unattended        → fully silent
# --superpassword          → sets the 'postgres' user password (CHANGE THIS!)
# --serverport 5432        → default port
# --servicename postgresql → Windows service name

Start-Process "C:\pg-installer.exe" -ArgumentList `
  "--mode unattended",
  "--unattendedmodeui none",
  "--superpassword YourStrongPasswordHere",
  "--serverport 5432",
  "--servicename postgresql",
  "--datadir C:\PostgreSQL\data",
  "--prefix C:\PostgreSQL" `
  -Wait

Write-Host "PostgreSQL installation complete."
```

> ⚠️ **Change `YourStrongPasswordHere`** to a real password. This becomes your `postgres` user password — you'll need it in the `.env` file later.

### 1c. Add PostgreSQL to PATH

```powershell
# Add psql to your terminal path so you can run it from anywhere
$pgBin = "C:\PostgreSQL\bin"
$current = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($current -notlike "*$pgBin*") {
    [Environment]::SetEnvironmentVariable("Path", "$current;$pgBin", "Machine")
    Write-Host "PostgreSQL added to PATH."
}

# Reload PATH in current session
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine")
```

### 1d. Verify PostgreSQL is running

```powershell
# Check the Windows service is running
Get-Service -Name "postgresql" | Select-Object Name, Status

# Should output:
# Name         Status
# ----         ------
# postgresql   Running

# Also test the psql connection
psql -U postgres -c "SELECT version();"
# It will ask for the password you set above
```

### 1e. Create the database

```powershell
# Create the wallnut_sync database (run this once)
psql -U postgres -c "CREATE DATABASE wallnut_sync;"

# Verify it was created
psql -U postgres -c "\l"
# Should show wallnut_sync in the list
```

> ✅ PostgreSQL is now installed and running as a Windows service. It will auto-start when the VM reboots.

---

## Step 2 — Install Node.js

```powershell
# Download Node.js v22 LTS installer
Invoke-WebRequest `
  -Uri "https://nodejs.org/dist/v22.17.0/node-v22.17.0-x64.msi" `
  -OutFile "C:\node-installer.msi"

# Install silently
Start-Process msiexec.exe -ArgumentList "/i C:\node-installer.msi /qn" -Wait

# Reload PATH
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine")

# Verify
node --version    # should print v22.x.x
npm --version     # should print 10.x.x
```

---

## Step 3 — Install PM2 (Process Manager)

PM2 keeps the Node.js service alive after crashes and VM reboots.

```powershell
npm install -g pm2
npm install -g pm2-windows-startup

# Verify
pm2 --version
```

---

## Step 4 — Install Git and Get the Code

### Option A — Install Git and clone

```powershell
# Download Git for Windows
Invoke-WebRequest `
  -Uri "https://github.com/git-for-windows/git/releases/download/v2.45.2.windows.1/Git-2.45.2-64-bit.exe" `
  -OutFile "C:\git-installer.exe"

# Install silently
Start-Process "C:\git-installer.exe" -ArgumentList "/VERYSILENT /NORESTART" -Wait

# Reload PATH
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine")

# Clone the repo
cd C:\services
git clone https://github.com/YOUR_USERNAME/Wallnut.git
cd Wallnut\tallybackend
```

### Option B — Copy the folder manually (no Git needed)

If you have the `tallybackend` folder on your dev machine:
1. Open **RDP** to the VM
2. Copy-paste the `tallybackend` folder to `C:\services\tallybackend`

---

## Step 5 — Install Node.js Dependencies

```powershell
cd C:\services\tallybackend   # adjust path if different

npm install
# Expected: "added 46 packages" with no errors
```

---

## Step 6 — Configure the `.env` File

```powershell
cd C:\services\tallybackend

# Copy the example file
copy .env.example .env

# Open in Notepad (or use any text editor)
notepad .env
```

Fill in the values:

```env
PORT=4001
NODE_ENV=production
LOG_LEVEL=info

# ── Tally (same VM = localhost) ──────────────────────────────────────────────
TALLY_HOST=http://localhost
TALLY_PORT=9000
TALLY_TIMEOUT_MS=120000

# ── PostgreSQL (same VM = localhost) ─────────────────────────────────────────
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=wallnut_sync
PG_USER=postgres
PG_PASSWORD=YourStrongPasswordHere      ← same password you set in Step 1b

# ── Sync schedule ─────────────────────────────────────────────────────────────
SYNC_INTERVAL_MINUTES=10
MASTER_SYNC_HOUR=2
BACKFILL_DAYS=3

# ── Companies ─────────────────────────────────────────────────────────────────
# FORMAT: DisplayName::ExactTallyName::FiscalYearStart::isHistorical
#
# HOW TO FIND ExactTallyName:
#   1. Open TallyPrime on the VM
#   2. Press F1 (Select Company)
#   3. Look at the list — copy the company name EXACTLY
#      (character for character, including spaces and case)
#
# isHistorical=true  → sync ONCE (for old/closed FY), then skip forever
# isHistorical=false → keep syncing every 10 minutes
#
# Example — two companies (FY 24-25 closed + FY 25-26 active):
TALLY_COMPANIES=Wallnut 24-25::Wallnut Chemicals 24-25::2024-04-01::true|Wallnut 25-26::Wallnut Chemicals 25-26::2025-04-01::false
```

> ⚠️ **The most common mistake**: the `ExactTallyName` doesn't match what's in TallyPrime.
> If data shows as 0 vouchers fetched, the company name is wrong. Open Tally, press F1, copy exactly.

---

## Step 7 — Test Connectivity Before Running

### Test 1: PostgreSQL connection

```powershell
cd C:\services\tallybackend

node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ host: process.env.PG_HOST, port: process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });
pool.query('SELECT NOW()').then(r => { console.log('PostgreSQL OK:', r.rows[0].now); pool.end(); }).catch(e => { console.error('PostgreSQL FAILED:', e.message); pool.end(); });
"
```
Expected: `PostgreSQL OK: 2026-07-23T...`

### Test 2: Tally connection

```powershell
node -e "
const axios = require('axios');
require('dotenv').config();
const url = process.env.TALLY_HOST + ':' + process.env.TALLY_PORT;
axios.post(url, '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>', { headers: { 'Content-Type': 'text/xml' }, responseType: 'text', timeout: 10000 }).then(r => console.log('Tally OK! Response size:', r.data.length, 'bytes')).catch(e => console.error('Tally FAILED:', e.message));
"
```
Expected: `Tally OK! Response size: XXXX bytes`

---

## Step 8 — First Run (watch logs live)

```powershell
cd C:\services\tallybackend
node index.js
```

Expected output on first run:
```
[INFO ] ═══════════════════════════════════════════
[INFO ]  Tally Sync Service — Starting
[INFO ]   Tally:     http://localhost:9000
[INFO ]   DB:        localhost:5432/wallnut_sync
[INFO ]   Companies: Wallnut 24-25, Wallnut 25-26
[INFO ] ═══════════════════════════════════════════
[INFO ] [migrate] Schema applied successfully.
[INFO ] [migrate] Seeded: "Wallnut 24-25" (historical: true)
[INFO ] [migrate] Seeded: "Wallnut 25-26" (historical: false)
[INFO ] [cron] Startup full sync: starting.
[INFO ] [syncEngine] ══ Processing: "Wallnut Chemicals 24-25" ══
[INFO ] [syncEngine] FULL voucher sync from 2024-04-01 to 2026-07-23
[INFO ] [syncEngine] Fetched 1847 vouchers. Done: 1847 upserted.
[INFO ] [syncEngine] Ledgers done: 45 upserted.
[INFO ] [syncEngine] ══ Processing: "Wallnut Chemicals 25-26" ══
[INFO ] [syncEngine] Fetched 234 vouchers. Done: 234 upserted.
[INFO ] [cron] Startup full sync: complete.
[INFO ] [main] Health endpoint: http://localhost:4001/health
```

Press `Ctrl+C` when satisfied. The service is working.

> ⚠️ **First run takes longer** — it's doing a FULL sync from FY start (could be thousands of vouchers). Let it finish before pressing Ctrl+C.

---

## Step 9 — Verify Data in the Database

```powershell
# Open psql
psql -U postgres -d wallnut_sync

# Inside psql, run these:
```

```sql
-- Check companies were created
SELECT id, name, tally_name, is_historical, initial_sync_done FROM companies;

-- Check sync completed successfully
SELECT company_id, data_type, status, last_synced_date, records_fetched
FROM sync_logs ORDER BY company_id, data_type;

-- Check some vouchers came through
SELECT date, vch_type, party_name, total_amount
FROM vouchers ORDER BY date DESC LIMIT 10;

-- Exit psql
\q
```

---

## Step 10 — Start with PM2 (permanent, production mode)

```powershell
cd C:\services\tallybackend

pm2 start pm2.config.js

# Check it's running
pm2 status
# Should show: tally-sync | online | ...

# Watch live logs (Ctrl+C to stop watching — does NOT stop the service)
pm2 logs tally-sync
```

---

## Step 11 — Auto-Start on VM Reboot (critical!)

This makes both PM2 and your sync service restart automatically after any reboot (Windows Updates, power cycle, etc).

```powershell
# Save current PM2 process list
pm2 save

# Register PM2 as a Windows startup item
pm2-startup install

# Confirm it worked
pm2-startup status
```

**Test the auto-start works:**
```powershell
# Reboot the VM
Restart-Computer

# After VM comes back online, check:
pm2 status
# tally-sync should show "online" automatically — no manual restart needed
```

---

## Step 12 — Allow AWS Backend to Access PostgreSQL

Your AWS Express API needs to connect to PostgreSQL on this VM. By default PostgreSQL only accepts `localhost` connections. You need to:

### 12a. Allow external connections in PostgreSQL config

```powershell
# Find the config file
$pgData = "C:\PostgreSQL\data"

# Edit pg_hba.conf — add a line to allow your AWS IP
Add-Content "$pgData\pg_hba.conf" "host    wallnut_sync    postgres    YOUR_AWS_EC2_IP/32    md5"

# Edit postgresql.conf — change listen_addresses
(Get-Content "$pgData\postgresql.conf") -replace "#listen_addresses = 'localhost'", "listen_addresses = '*'" | Set-Content "$pgData\postgresql.conf"

# Restart PostgreSQL to apply changes
Restart-Service postgresql
```

### 12b. Open port 5432 in Windows Firewall

```powershell
New-NetFirewallRule `
  -DisplayName "PostgreSQL from AWS" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 5432 `
  -RemoteAddress "YOUR_AWS_EC2_IP" `
  -Action Allow
```

> Replace `YOUR_AWS_EC2_IP` with the actual IP address of your AWS EC2 instance.
> For extra security, restrict it to just that one IP — not `0.0.0.0/0`.

---

## Daily Operations Reference

| Task | Command (run on VM) |
|---|---|
| Check service is running | `pm2 status` |
| View live logs | `pm2 logs tally-sync` |
| View last 100 log lines | `pm2 logs tally-sync --lines 100` |
| Restart service | `pm2 restart tally-sync` |
| Stop service | `pm2 stop tally-sync` |
| Health check (browser on VM) | `http://localhost:4001/health` |
| Check sync status in DB | `psql -U postgres -d wallnut_sync -c "SELECT * FROM sync_logs;"` |
| Count vouchers in DB | `psql -U postgres -d wallnut_sync -c "SELECT COUNT(*) FROM vouchers;"` |

---

## Health Check Endpoint

Open on the VM's browser or from AWS backend:
```
http://VM_IP_ADDRESS:4001/health
```

Response shows live sync status:
```json
{
  "status": "ok",
  "syncRunning": false,
  "companies": ["Wallnut 24-25", "Wallnut 25-26"],
  "syncLogs": [
    { "data_type": "vouchers", "status": "success", "last_synced_date": "2026-07-23", "records_fetched": 1847 },
    { "data_type": "ledgers",  "status": "success", "last_synced_date": "2026-07-23", "records_fetched": 45 }
  ]
}
```

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `ECONNREFUSED localhost:9000` | TallyPrime not running | Open TallyPrime, ensure it's on port 9000 |
| `0 vouchers fetched` | Company name mismatch | Open TallyPrime → F1 → copy name exactly into `.env` |
| `password authentication failed` | Wrong `PG_PASSWORD` in `.env` | Use same password set during PostgreSQL install |
| `database "wallnut_sync" does not exist` | DB not created | Run: `psql -U postgres -c "CREATE DATABASE wallnut_sync;"` |
| `psql: command not found` | PostgreSQL not in PATH | Restart PowerShell, or re-run the PATH step |
| PM2 shows `errored` | Node.js error on startup | `pm2 logs tally-sync --lines 50` — read the actual error |
| One company returns 0 vouchers | That company not loaded in Tally | In TallyPrime press F1 → load BOTH companies |
| `❌ Configuration errors` on startup | Missing `.env` values | Read the error message — it tells you exactly what's missing |

---

## How the Full Auto-Sync Works

```
VM boots (after reboot/update)
  ↓
PM2 auto-starts (registered in Windows startup)
  ↓
Tally Sync Service starts
  ↓
Startup: FULL sync — all vouchers from FY start date + all masters (ledgers, stock, outstanding)
  Historical company (FY 24-25): synced ONCE, then marked done, never synced again
  Active company (FY 25-26): synced now, then incrementally every 10 min
  ↓
Every 10 minutes: incremental voucher sync (fetches last 3 days window to catch backdated entries)
  ↓
Every night at 2:00 AM: refresh ledgers + stock items + outstanding from Tally
  ↓
PostgreSQL always has fresh data → AWS Express API reads from it → React dashboard shows live data
```

No manual work needed after initial setup. ✅
