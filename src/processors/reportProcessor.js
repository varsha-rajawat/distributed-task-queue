const logger = require("../utils/logger");

/**
 * reportProcessor — handles "generateReport" jobs.
 *
 * Expected payload:
 *   {
 *     reportType: "daily" | "weekly" | "monthly",
 *     userId:     "uuid",
 *     filters:    { startDate: "2024-01-01", endDate: "2024-01-31" }   (optional)
 *   }
 */
async function reportProcessor(job) {
  const { reportType, userId, filters = {} } = job.payload;

  if (!reportType) {
    throw new Error("reportProcessor: missing required field 'reportType'");
  }

  logger.info(`Generating report`, { reportType, userId, jobId: job.id });

  const report = await buildReport(reportType, userId, filters);

  // In production: store report in S3 / DB, notify user, etc.
  logger.info(`Report generated`, {
    reportType,
    userId,
    jobId:  job.id,
    rows:   report.rowCount,
    sizeKB: report.sizeKB,
  });
}

async function buildReport(reportType, userId, filters) {
  // Simulate variable processing time based on report size
  const processingTime = { daily: 300, weekly: 700, monthly: 1500 }[reportType] ?? 500;
  await delay(processingTime);

  // Simulate occasional failures for longer jobs
  if (reportType === "monthly" && Math.random() < 0.15) {
    throw new Error("Report service timeout — data warehouse unreachable");
  }

  return {
    rowCount: Math.floor(Math.random() * 10000) + 100,
    sizeKB:   Math.floor(Math.random() * 5000) + 50,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = reportProcessor;
