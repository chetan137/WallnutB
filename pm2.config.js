/**
 * pm2.config.js
 *
 * PM2 ecosystem config for the Tally Sync Service.
 *
 * Usage:
 *   pm2 start pm2.config.js          # start
 *   pm2 restart tally-sync           # restart
 *   pm2 logs tally-sync              # view logs
 *   pm2 stop tally-sync              # stop
 *   pm2 save && pm2 startup          # auto-start on VM reboot
 *
 * max_memory_restart: 512M — VM has 8 GB RAM shared with TallyPrime + PostgreSQL.
 * Was 200M, which pm2 hit every time while parsing a large voucher XML
 * response (fast-xml-parser builds a full JS object tree — comfortably
 * more memory than the raw XML string) — pm2 killed and restarted the
 * process mid-chunk, before anything reached Postgres, every single cycle.
 * 512M leaves ample headroom on 8 GB alongside Tally + Postgres.
 */
module.exports = {
  apps: [
    {
      name:               'tally-sync',
      script:             'index.js',
      cwd:                __dirname,

      // Memory guard — restart if process exceeds 512 MB RAM
      max_memory_restart: '512M',

      // Wait before restarting on crash (ms)
      restart_delay:      5000,

      // Max crash restarts before giving up (0 = unlimited)
      max_restarts:       20,

      // Do NOT cluster — single instance only (1 vCPU, sync must be sequential)
      instances:  1,
      exec_mode: 'fork',

      // Environment variables loaded from .env by dotenv (inside config.js).
      // Only set NODE_ENV here — all other secrets stay in .env.
      env: {
        NODE_ENV: 'production',
      },

      // Log config — kept in logs/ directory (created by git, ignored by gitignore)
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file:      'logs/error.log',
      out_file:        'logs/out.log',
      merge_logs:      true,

      // Rotate logs when file hits 10 MB (requires pm2-logrotate module)
      // Install once: pm2 install pm2-logrotate
    },
  ],
};
