require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const Redis = require("ioredis");
const JobPriority = require("./JobPriority");
const JobRepository = require("../db/JobRepository");
const logger = require("../utils/logger");

// ─── Redis key helpers ────────────────────────────────────────────────────────
const Keys = {
  pending:    (name) => `queue:${name}:pending`,    // sorted set  (score = priority + time)
  processing: (name) => `queue:${name}:processing`, // hash        jobId → serialised job
  delayed:    (name) => `queue:${name}:delayed`,    // sorted set  (score = run_at ms)
  jobData:    (name, id) => `queue:${name}:job:${id}`, // string  (TTL = lock TTL)
};

class Queue {
  /**
   * @param {string} name  - Unique queue name (e.g. "email", "reports")
   * @param {object} [opts]
   * @param {number} [opts.defaultMaxAttempts=3]
   * @param {number} [opts.backoffBaseDelayMs=1000]
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.defaultMaxAttempts = opts.defaultMaxAttempts
      ?? parseInt(process.env.DEFAULT_MAX_ATTEMPTS || "3");
    this.backoffBaseDelayMs = opts.backoffBaseDelayMs
      ?? parseInt(process.env.BACKOFF_BASE_DELAY_MS || "1000");

    this.redis = new Redis({
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });

    this.redis.on("error", (err) =>
      logger.error("Redis connection error", { queue: this.name, error: err.message })
    );

    logger.info(`Queue "${this.name}" initialised`);
  }

  // ─── Add a job ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a new job.
   *
   * @param {string} type         - Job type identifier (matched to a processor)
   * @param {object} payload      - Arbitrary job data
   * @param {object} [opts]
   * @param {number} [opts.priority]       - JobPriority.HIGH | MEDIUM | LOW
   * @param {number} [opts.maxAttempts]
   * @param {Date}   [opts.runAt]          - Schedule for the future (delayed job)
   * @returns {Promise<string>}   jobId
   */
  async add(type, payload = {}, opts = {}) {
    const job = {
      id:          uuidv4(),
      queueName:   this.name,
      type,
      payload,
      status:      "pending",
      priority:    opts.priority    ?? JobPriority.MEDIUM,
      maxAttempts: opts.maxAttempts ?? this.defaultMaxAttempts,
      attempts:    0,
      runAt:       opts.runAt ?? new Date(),
      createdAt:   new Date(),
    };

    // Persist to PostgreSQL first (source of truth)
    await JobRepository.save(job);

    const runAtMs = job.runAt.getTime();
    const now     = Date.now();

    if (runAtMs > now) {
      // Delayed job — put it in the delayed sorted set; a promoter will move it later
      await this.redis.zadd(
        Keys.delayed(this.name),
        runAtMs,
        JSON.stringify(job)
      );
      logger.info(`Job delayed`, { jobId: job.id, type, runAt: job.runAt });
    } else {
      await this._enqueueReady(job);
    }

    return job.id;
  }

  // ─── Internal enqueue (ready-to-run) ──────────────────────────────────────

  async _enqueueReady(job) {
    // Score = priority * 1e13 + timestamp  →  high-priority + older = lowest score
    const score = job.priority * 1e13 + Date.now();
    await this.redis.zadd(
      Keys.pending(this.name),
      score,
      JSON.stringify(job)
    );
    logger.debug(`Job enqueued`, { jobId: job.id, type: job.type, priority: job.priority });
  }

  // ─── Claim next job (atomic) ───────────────────────────────────────────────

  /**
   * Atomically pop the highest-priority ready job and mark it as processing.
   * Uses a Lua script so no other worker can claim the same job.
   *
   * @param {string} workerId
   * @returns {Promise<object|null>}
   */
  async dequeue(workerId) {
    // First promote any delayed jobs whose run_at has arrived
    await this._promoteDelayedJobs();

    const luaScript = `
      local job = redis.call('ZPOPMIN', KEYS[1])
      if #job == 0 then return nil end
      local jobData = job[1]
      redis.call('HSET', KEYS[2], jobData, ARGV[1])
      return jobData
    `;

    const result = await this.redis.eval(
      luaScript,
      2,
      Keys.pending(this.name),
      Keys.processing(this.name),
      workerId
    );

    if (!result) return null;

    const job = JSON.parse(result);
    job.workerId = workerId;

    await JobRepository.updateStatus(job.id, "processing", { workerId });
    logger.debug(`Job claimed`, { jobId: job.id, workerId });

    return job;
  }

  // ─── Acknowledge ───────────────────────────────────────────────────────────

  async ack(job) {
    await this.redis.hdel(Keys.processing(this.name), JSON.stringify({ ...job, workerId: undefined }));
    await JobRepository.updateStatus(job.id, "completed");
    logger.info(`Job completed`, { jobId: job.id, type: job.type });
  }

  // ─── Retry or dead-letter ──────────────────────────────────────────────────

  /**
   * Called when a job fails. Increments attempts, applies exponential backoff,
   * and either re-queues or moves to the dead-letter queue.
   *
   * @param {object} job
   * @param {Error}  error
   */
  async nack(job, error) {
    job.attempts = (job.attempts || 0) + 1;

    await JobRepository.incrementAttempts(job.id);

    // Remove from the processing hash (the raw key stored by dequeue)
    const raw = JSON.stringify({ ...job, workerId: undefined, attempts: job.attempts - 1 });
    await this.redis.hdel(Keys.processing(this.name), raw);

    if (job.attempts >= job.maxAttempts) {
      // Permanently failed — move to dead-letter queue
      job.error = error.message;
      await JobRepository.moveToDeadLetter(job);
      logger.warn(`Job moved to dead-letter queue`, {
        jobId: job.id,
        type:  job.type,
        attempts: job.attempts,
        error: error.message,
      });
    } else {
      // Exponential backoff: delay = base * 2^(attempts-1)  e.g. 1s, 2s, 4s …
      const delayMs  = this.backoffBaseDelayMs * Math.pow(2, job.attempts - 1);
      const runAt    = new Date(Date.now() + delayMs);
      job.runAt      = runAt;
      job.status     = "pending";

      await JobRepository.rescheduleForRetry(job.id, runAt);

      // Put back into the delayed set so it waits for the backoff window
      await this.redis.zadd(
        Keys.delayed(this.name),
        runAt.getTime(),
        JSON.stringify(job)
      );

      logger.warn(`Job failed, retrying`, {
        jobId:     job.id,
        attempt:   job.attempts,
        maxAttempts: job.maxAttempts,
        retryIn:   `${delayMs}ms`,
      });
    }
  }

  // ─── Promote delayed jobs ─────────────────────────────────────────────────

  async _promoteDelayedJobs() {
    const now  = Date.now();
    // Fetch all delayed jobs whose run_at score <= now
    const jobs = await this.redis.zrangebyscore(
      Keys.delayed(this.name),
      "-inf",
      now
    );

    if (jobs.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const raw of jobs) {
      const job  = JSON.parse(raw);
      const score = job.priority * 1e13 + Date.now();
      pipeline.zadd(Keys.pending(this.name), score, raw);
      pipeline.zrem(Keys.delayed(this.name), raw);
    }
    await pipeline.exec();

    logger.debug(`Promoted ${jobs.length} delayed job(s) to pending`, { queue: this.name });
  }

  // ─── Queue metrics ────────────────────────────────────────────────────────

  async stats() {
    const [pending, processing, delayed] = await Promise.all([
      this.redis.zcard(Keys.pending(this.name)),
      this.redis.hlen(Keys.processing(this.name)),
      this.redis.zcard(Keys.delayed(this.name)),
    ]);
    return { queue: this.name, pending, processing, delayed };
  }

  async close() {
    await this.redis.quit();
  }
}

module.exports = Queue;
