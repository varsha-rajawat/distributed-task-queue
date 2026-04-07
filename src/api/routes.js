const { Router } = require("express");
const JobRepository = require("../db/JobRepository");
const JobPriority = require("../queue/JobPriority");
const logger = require("../utils/logger");

/**
 * createRouter — builds and returns the Express router.
 *
 * @param {Map<string, import("../queue/Queue")>} queues   name → Queue
 * @returns {Router}
 */
function createRouter(queues) {
  const router = Router();

  // ─── POST /api/jobs ─────────────────────────────────────────────────────
  // Enqueue a new job.
  //
  // Body: { queueName, type, payload, priority?, maxAttempts?, runAt? }
  // priority: "high" | "medium" | "low"  (default: "medium")
  router.post("/jobs", async (req, res) => {
    try {
      const { queueName, type, payload = {}, priority, maxAttempts, runAt } = req.body;

      if (!queueName || !type) {
        return res.status(400).json({ error: "queueName and type are required" });
      }

      const queue = queues.get(queueName);
      if (!queue) {
        return res.status(404).json({
          error: `Queue "${queueName}" not found`,
          available: [...queues.keys()],
        });
      }

      const priorityMap = { high: JobPriority.HIGH, medium: JobPriority.MEDIUM, low: JobPriority.LOW };
      const resolvedPriority = priorityMap[priority] ?? JobPriority.MEDIUM;
      const resolvedRunAt    = runAt ? new Date(runAt) : undefined;

      const jobId = await queue.add(type, payload, {
        priority:    resolvedPriority,
        maxAttempts: maxAttempts ? parseInt(maxAttempts) : undefined,
        runAt:       resolvedRunAt,
      });

      return res.status(202).json({ jobId, status: "accepted" });
    } catch (err) {
      logger.error("POST /jobs error", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/jobs ──────────────────────────────────────────────────────
  // List jobs with optional filters.
  // Query params: queueName?, status?, limit?, offset?
  router.get("/jobs", async (req, res) => {
    try {
      const { queueName, status, limit = 50, offset = 0 } = req.query;
      const jobs = await JobRepository.list({
        queueName,
        status,
        limit: parseInt(limit),
        offset: parseInt(offset),
      });
      return res.json({ jobs, count: jobs.length });
    } catch (err) {
      logger.error("GET /jobs error", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/jobs/:id ──────────────────────────────────────────────────
  router.get("/jobs/:id", async (req, res) => {
    try {
      const job = await JobRepository.findById(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      return res.json(job);
    } catch (err) {
      logger.error("GET /jobs/:id error", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/dead-letter ───────────────────────────────────────────────
  // Inspect permanently failed jobs.
  router.get("/dead-letter", async (req, res) => {
    try {
      const { limit = 50, offset = 0 } = req.query;
      const jobs = await JobRepository.listDeadLetterJobs({
        limit: parseInt(limit),
        offset: parseInt(offset),
      });
      return res.json({ jobs, count: jobs.length });
    } catch (err) {
      logger.error("GET /dead-letter error", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /api/dead-letter/:id/retry ───────────────────────────────────
  // Manually re-enqueue a dead-letter job.
  router.post("/dead-letter/:id/retry", async (req, res) => {
    try {
      const { rows } = await require("../db/connection").query(
        `SELECT * FROM dead_letter_jobs WHERE id = $1`,
        [req.params.id]
      );
      const dlJob = rows[0];
      if (!dlJob) return res.status(404).json({ error: "Dead-letter job not found" });

      const queue = queues.get(dlJob.queue_name);
      if (!queue) {
        return res.status(404).json({ error: `Queue "${dlJob.queue_name}" not found` });
      }

      const jobId = await queue.add(dlJob.type, dlJob.payload, {
        priority:    JobPriority.HIGH,   // retries get bumped to HIGH priority
        maxAttempts: 3,
      });

      return res.status(202).json({ jobId, status: "requeued" });
    } catch (err) {
      logger.error("POST /dead-letter/:id/retry error", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/stats ─────────────────────────────────────────────────────
  // Aggregate stats: DB counts + Redis queue depths.
  router.get("/stats", async (req, res) => {
    try {
      const [dbStats, redisStats] = await Promise.all([
        JobRepository.getStats(),
        Promise.all([...queues.values()].map((q) => q.stats())),
      ]);
      return res.json({ db: dbStats, redis: redisStats });
    } catch (err) {
      logger.error("GET /stats error", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/health ────────────────────────────────────────────────────
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), ts: new Date() });
  });

  return router;
}

module.exports = createRouter;
