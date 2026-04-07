require("dotenv").config();
const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432"),
  user: process.env.PG_USER || "taskqueue",
  password: process.env.PG_PASSWORD || "taskqueue_secret",
  database: process.env.PG_DATABASE || "taskqueue_db",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on("error", (err) => {
  logger.error("Unexpected PostgreSQL pool error", { error: err.message });
});

pool.on("connect", () => {
  logger.debug("New PostgreSQL client connected");
});

/**
 * Execute a query with parameters.
 * @param {string} text - SQL query string
 * @param {Array} params - Query parameters
 * @returns {Promise<import("pg").QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.debug("Executed query", { query: text, duration, rows: result.rowCount });
  return result;
}

/**
 * Run a callback inside a single transaction. Automatically commits or rolls back.
 * @param {(client: import("pg").PoolClient) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
