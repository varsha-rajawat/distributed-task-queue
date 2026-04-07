/**
 * migrations.js
 * Run this once to set up the PostgreSQL schema:  npm run migrate
 */
require("dotenv").config();
const { pool } = require("./connection");
const logger = require("../utils/logger");

const MIGRATIONS = [
  // ─── Jobs table ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS jobs (
    id            UUID PRIMARY KEY,
    queue_name    TEXT        NOT NULL,
    type          TEXT        NOT NULL,
    payload       JSONB       NOT NULL DEFAULT '{}',
    status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed','failed','dead')),
    priority      SMALLINT    NOT NULL DEFAULT 2,   -- 1=high 2=medium 3=low
    attempts      SMALLINT    NOT NULL DEFAULT 0,
    max_attempts  SMALLINT    NOT NULL DEFAULT 3,
    run_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    error         TEXT,
    worker_id     TEXT
  )`,

  // Index for the worker "claim next job" query
  `CREATE INDEX IF NOT EXISTS idx_jobs_queue_status_priority
     ON jobs (queue_name, status, priority ASC, run_at ASC)`,

  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_run_at  ON jobs (run_at)`,

  // ─── Dead-letter queue ───────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS dead_letter_jobs (
    id            UUID PRIMARY KEY,
    original_job_id UUID NOT NULL,
    queue_name    TEXT        NOT NULL,
    type          TEXT        NOT NULL,
    payload       JSONB       NOT NULL DEFAULT '{}',
    attempts      SMALLINT    NOT NULL,
    last_error    TEXT,
    failed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL
  )`,

  // ─── Scheduled jobs ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id            SERIAL PRIMARY KEY,
    name          TEXT        NOT NULL UNIQUE,
    cron_expr     TEXT        NOT NULL,
    queue_name    TEXT        NOT NULL,
    type          TEXT        NOT NULL,
    payload       JSONB       NOT NULL DEFAULT '{}',
    priority      SMALLINT    NOT NULL DEFAULT 2,
    max_attempts  SMALLINT    NOT NULL DEFAULT 3,
    enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
    last_run_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ─── updated_at trigger ──────────────────────────────────────────────────
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ LANGUAGE plpgsql`,

  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger WHERE tgname = 'set_jobs_updated_at'
     ) THEN
       CREATE TRIGGER set_jobs_updated_at
         BEFORE UPDATE ON jobs
         FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
     END IF;
   END $$`,
];

async function runMigrations() {
  logger.info("Running database migrations...");
  const client = await pool.connect();
  try {
    for (const sql of MIGRATIONS) {
      await client.query(sql);
    }
    logger.info("All migrations applied successfully.");
  } catch (err) {
    logger.error("Migration failed", { error: err.message });
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error(err);
  process.exit(1);
});
