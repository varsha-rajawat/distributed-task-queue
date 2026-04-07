const { query, withTransaction } = require("./connection");

/**
 * JobRepository — all PostgreSQL operations for jobs.
 * Redis is the hot queue; PostgreSQL is the source of truth for
 * persistence, auditing, dead-letter storage, and the dashboard API.
 */
class JobRepository {
  // ─── Writes ────────────────────────────────────────────────────────────

  async save(job) {
    const sql = `
      INSERT INTO jobs
        (id, queue_name, type, payload, status, priority,
         max_attempts, run_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await query(sql, [
      job.id,
      job.queueName,
      job.type,
      JSON.stringify(job.payload),
      job.status || "pending",
      job.priority,
      job.maxAttempts,
      job.runAt || new Date(),
    ]);
  }

  async updateStatus(jobId, status, extra = {}) {
    const sets = ["status = $2", "updated_at = NOW()"];
    const values = [jobId, status];

    if (extra.error !== undefined) {
      values.push(extra.error);
      sets.push(`error = $${values.length}`);
    }
    if (extra.workerId !== undefined) {
      values.push(extra.workerId);
      sets.push(`worker_id = $${values.length}`);
    }
    if (extra.attempts !== undefined) {
      values.push(extra.attempts);
      sets.push(`attempts = $${values.length}`);
    }
    if (status === "completed") {
      sets.push("completed_at = NOW()");
    }

    await query(
      `UPDATE jobs SET ${sets.join(", ")} WHERE id = $1`,
      values
    );
  }

  async incrementAttempts(jobId) {
    await query(
      `UPDATE jobs SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
      [jobId]
    );
  }

  async rescheduleForRetry(jobId, runAt) {
    await query(
      `UPDATE jobs
         SET status = 'pending', run_at = $2, worker_id = NULL, updated_at = NOW()
       WHERE id = $1`,
      [jobId, runAt]
    );
  }

  // ─── Dead-letter queue ─────────────────────────────────────────────────

  async moveToDeadLetter(job) {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO dead_letter_jobs
           (id, original_job_id, queue_name, type, payload, attempts, last_error, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
        [
          job.id,
          job.queueName,
          job.type,
          JSON.stringify(job.payload),
          job.attempts,
          job.error,
          job.createdAt,
        ]
      );
      await client.query(
        `UPDATE jobs SET status = 'dead', updated_at = NOW() WHERE id = $1`,
        [job.id]
      );
    });
  }

  // ─── Reads ─────────────────────────────────────────────────────────────

  async findById(id) {
    const { rows } = await query(`SELECT * FROM jobs WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  async list({ queueName, status, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const values = [];

    if (queueName) {
      values.push(queueName);
      conditions.push(`queue_name = $${values.length}`);
    }
    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(limit, offset);

    const { rows } = await query(
      `SELECT * FROM jobs ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return rows;
  }

  async listDeadLetterJobs({ limit = 50, offset = 0 } = {}) {
    const { rows } = await query(
      `SELECT * FROM dead_letter_jobs
       ORDER BY failed_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows;
  }

  async getStats() {
    const { rows } = await query(
      `SELECT queue_name, status, COUNT(*) AS count
         FROM jobs
        GROUP BY queue_name, status
        ORDER BY queue_name, status`
    );
    return rows;
  }
}

module.exports = new JobRepository();
