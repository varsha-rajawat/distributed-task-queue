require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const logger = require("../utils/logger");

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "1000");
const DEFAULT_CONCURRENCY = parseInt(process.env.DEFAULT_CONCURRENCY || "5");

/**
 * Worker — polls a Queue and dispatches jobs to registered processor functions.
 *
 * Usage:
 *   const worker = new Worker(queue, { concurrency: 3 });
 *   worker.process("sendEmail", emailProcessor);
 *   worker.process("generateReport", reportProcessor);
 *   worker.start();
 */
class Worker {
  /**
   * @param {import("./Queue")} queue
   * @param {object} [opts]
   * @param {number} [opts.concurrency]  - Max parallel jobs
   */
  constructor(queue, opts = {}) {
    this.queue       = queue;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.workerId    = `worker:${uuidv4()}`;
    this.processors  = new Map();  // type → async function(job)
    this.running     = 0;
    this.active      = false;
    this._timer      = null;
  }

  /**
   * Register a processor function for a job type.
   * The function receives the full job object and should throw on failure.
   *
   * @param {string}   type
   * @param {Function} fn   async (job) => void
   */
  process(type, fn) {
    this.processors.set(type, fn);
    logger.info(`Worker registered processor`, { workerId: this.workerId, type });
    return this;   // chainable
  }

  /** Start polling the queue. */
  start() {
    if (this.active) return;
    this.active = true;
    logger.info(`Worker started`, {
      workerId: this.workerId,
      queue:    this.queue.name,
      concurrency: this.concurrency,
    });
    this._poll();
  }

  /** Gracefully stop — lets in-flight jobs finish. */
  async stop() {
    this.active = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    // Wait until all active jobs complete
    while (this.running > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
    logger.info(`Worker stopped`, { workerId: this.workerId });
  }

  // ─── Poll loop ─────────────────────────────────────────────────────────────

  _poll() {
    if (!this.active) return;

    const slots = this.concurrency - this.running;
    const tasks = [];
    for (let i = 0; i < slots; i++) {
      tasks.push(this._tryProcessOne());
    }

    Promise.all(tasks).then(() => {
      this._timer = setTimeout(() => this._poll(), POLL_INTERVAL_MS);
    });
  }

  async _tryProcessOne() {
    let job;
    try {
      job = await this.queue.dequeue(this.workerId);
    } catch (err) {
      logger.error("Error dequeueing job", { error: err.message });
      return;
    }

    if (!job) return;  // queue is empty

    this.running++;
    this._executeJob(job).finally(() => {
      this.running--;
    });
  }

  async _executeJob(job) {
    const processor = this.processors.get(job.type);

    if (!processor) {
      // No processor registered for this type — nack without retry to avoid looping
      logger.error(`No processor registered for job type "${job.type}"`, { jobId: job.id });
      const fakeError = new Error(`No processor for type: ${job.type}`);
      job.maxAttempts = 0;  // force dead-letter immediately
      await this.queue.nack(job, fakeError);
      return;
    }

    logger.info(`Processing job`, {
      jobId:  job.id,
      type:   job.type,
      attempt: job.attempts + 1,
      workerId: this.workerId,
    });

    try {
      await processor(job);
      await this.queue.ack(job);
    } catch (err) {
      logger.error(`Job failed`, {
        jobId: job.id,
        type:  job.type,
        error: err.message,
      });
      await this.queue.nack(job, err);
    }
  }
}

module.exports = Worker;
