const cron = require("node-cron");
const { query } = require("../db/connection");
const JobPriority = require("./JobPriority");
const logger = require("../utils/logger");

/**
 * Scheduler — manages recurring (cron-based) job definitions stored in PostgreSQL.
 *
 * Each registered schedule is stored in the `scheduled_jobs` table and fires
 * a new job on the specified queue at the given cron interval.
 *
 * Usage:
 *   const scheduler = new Scheduler(queues);   // queues = Map<name, Queue>
 *
 *   // Define a schedule programmatically (also upserts to DB)
 *   await scheduler.define({
 *     name:       "daily-report",
 *     cronExpr:   "0 8 * * *",          // every day at 08:00
 *     queueName:  "reports",
 *     type:       "generateReport",
 *     payload:    { reportType: "daily" },
 *     priority:   JobPriority.LOW,
 *   });
 *
 *   scheduler.start();   // loads all enabled schedules from DB and activates them
 */
class Scheduler {
  /**
   * @param {Map<string, import("./Queue")>} queues
   */
  constructor(queues) {
    this.queues    = queues;    // name → Queue instance
    this.tasks     = new Map(); // name → node-cron task
    this.running   = false;
  }

  // ─── Define / upsert a schedule ───────────────────────────────────────────

  async define(schedule) {
    const {
      name,
      cronExpr,
      queueName,
      type,
      payload     = {},
      priority    = JobPriority.MEDIUM,
      maxAttempts = 3,
      enabled     = true,
    } = schedule;

    await query(
      `INSERT INTO scheduled_jobs
         (name, cron_expr, queue_name, type, payload, priority, max_attempts, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (name) DO UPDATE SET
         cron_expr    = EXCLUDED.cron_expr,
         queue_name   = EXCLUDED.queue_name,
         type         = EXCLUDED.type,
         payload      = EXCLUDED.payload,
         priority     = EXCLUDED.priority,
         max_attempts = EXCLUDED.max_attempts,
         enabled      = EXCLUDED.enabled`,
      [name, cronExpr, queueName, type, JSON.stringify(payload), priority, maxAttempts, enabled]
    );

    logger.info(`Schedule defined`, { name, cronExpr, queueName, type });
  }

  // ─── Start all enabled schedules ─────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;

    const { rows } = await query(
      `SELECT * FROM scheduled_jobs WHERE enabled = TRUE`
    );

    for (const row of rows) {
      this._activate(row);
    }

    logger.info(`Scheduler started — ${rows.length} schedule(s) active`);
  }

  _activate(row) {
    if (!cron.validate(row.cron_expr)) {
      logger.error(`Invalid cron expression for schedule "${row.name}"`, {
        cron: row.cron_expr,
      });
      return;
    }

    const task = cron.schedule(row.cron_expr, async () => {
      const queue = this.queues.get(row.queue_name);
      if (!queue) {
        logger.error(`Scheduler: queue "${row.queue_name}" not found`, { name: row.name });
        return;
      }

      try {
        const jobId = await queue.add(row.type, row.payload, {
          priority:    row.priority,
          maxAttempts: row.max_attempts,
        });

        // Update last_run_at
        await query(
          `UPDATE scheduled_jobs SET last_run_at = NOW() WHERE name = $1`,
          [row.name]
        );

        logger.info(`Scheduled job enqueued`, {
          schedule: row.name,
          jobId,
          queue:    row.queue_name,
        });
      } catch (err) {
        logger.error(`Failed to enqueue scheduled job`, {
          schedule: row.name,
          error:    err.message,
        });
      }
    });

    this.tasks.set(row.name, task);
    logger.debug(`Schedule activated`, { name: row.name, cron: row.cron_expr });
  }

  // ─── Stop ────────────────────────────────────────────────────────────────

  stop() {
    for (const [name, task] of this.tasks) {
      task.stop();
      logger.debug(`Schedule stopped`, { name });
    }
    this.tasks.clear();
    this.running = false;
    logger.info("Scheduler stopped");
  }
}

module.exports = Scheduler;
