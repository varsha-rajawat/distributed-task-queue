/**
 * index.js — application entry point.
 *
 * Boots:
 *   1. Two example queues  ("email", "reports")
 *   2. A Worker per queue, with processors registered
 *   3. A Scheduler with two example cron jobs
 *   4. An Express HTTP API on PORT (default 3000)
 */
require("dotenv").config();

const Queue      = require("./queue/Queue");
const Worker     = require("./queue/Worker");
const Scheduler  = require("./queue/Scheduler");
const createServer = require("./api/server");

const emailProcessor  = require("./processors/emailProcessor");
const reportProcessor = require("./processors/reportProcessor");

const JobPriority = require("./queue/JobPriority");
const logger      = require("./utils/logger");

const PORT = parseInt(process.env.PORT || "3000");

async function main() {
  // ── 1. Queues ────────────────────────────────────────────────────────────
  const emailQueue   = new Queue("email");
  const reportsQueue = new Queue("reports");

  // Expose queues in a map — shared with the API and Scheduler
  const queues = new Map([
    ["email",   emailQueue],
    ["reports", reportsQueue],
  ]);

  // ── 2. Workers ───────────────────────────────────────────────────────────
  const emailWorker = new Worker(emailQueue, { concurrency: 5 })
    .process("sendEmail", emailProcessor)
    .process("sendPasswordReset", emailProcessor);  // reuse for similar types

  const reportsWorker = new Worker(reportsQueue, { concurrency: 2 })
    .process("generateReport", reportProcessor);

  emailWorker.start();
  reportsWorker.start();

  // ── 3. Scheduler ─────────────────────────────────────────────────────────
  const scheduler = new Scheduler(queues);

  // Define recurring jobs (these upsert into the scheduled_jobs table)
  await scheduler.define({
    name:      "daily-summary-report",
    cronExpr:  "0 8 * * *",           // Every day at 08:00
    queueName: "reports",
    type:      "generateReport",
    payload:   { reportType: "daily" },
    priority:  JobPriority.LOW,
  });

  await scheduler.define({
    name:      "weekly-digest-email",
    cronExpr:  "0 9 * * 1",           // Every Monday at 09:00
    queueName: "email",
    type:      "sendEmail",
    payload:   { to: "team@example.com", subject: "Weekly Digest", body: "Here's your weekly summary." },
    priority:  JobPriority.MEDIUM,
  });

  await scheduler.start();

  // ── 4. HTTP API ──────────────────────────────────────────────────────────
  const app = createServer(queues);
  const server = app.listen(PORT, () => {
    logger.info(`API server listening`, { port: PORT });
    logger.info(`Try:  curl -s localhost:${PORT}/api/health | json_pp`);
  });

  // ── 5. Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`Received ${signal} — shutting down gracefully...`);

    // Stop accepting new HTTP requests
    server.close();

    // Stop scheduling new jobs
    scheduler.stop();

    // Stop workers (waits for in-flight jobs to finish)
    await Promise.all([emailWorker.stop(), reportsWorker.stop()]);

    // Close Redis connections
    await Promise.all([emailQueue.close(), reportsQueue.close()]);

    logger.info("All connections closed. Goodbye.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: err.message, stack: err.stack });
  process.exit(1);
});
