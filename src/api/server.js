const express = require("express");
const createRouter = require("./routes");
const logger = require("../utils/logger");

/**
 * createServer — builds and returns the Express app.
 * Kept separate from listen() so it's easy to test.
 *
 * @param {Map<string, import("../queue/Queue")>} queues
 * @returns {import("express").Express}
 */
function createServer(queues) {
  const app = express();

  app.use(express.json());

  // Request logging middleware
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.url}`);
    next();
  });

  // Mount API routes
  app.use("/api", createRouter(queues));

  // 404 fallback
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Global error handler
  app.use((err, _req, res, _next) => {
    logger.error("Unhandled error", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

module.exports = createServer;
