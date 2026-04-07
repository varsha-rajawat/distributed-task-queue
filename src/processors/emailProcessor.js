const logger = require("../utils/logger");

/**
 * emailProcessor — handles "sendEmail" jobs.
 *
 * In a real application this would call an email service (SendGrid, SES, etc.).
 * Here we simulate the work so you can see the full lifecycle.
 *
 * Expected payload:
 *   {
 *     to:      "user@example.com",
 *     subject: "Welcome!",
 *     body:    "Hello, world."
 *   }
 */
async function emailProcessor(job) {
  const { to, subject, body } = job.payload;

  if (!to || !subject) {
    throw new Error("emailProcessor: missing required fields 'to' or 'subject'");
  }

  logger.info(`Sending email`, { to, subject, jobId: job.id });

  // Simulate network latency (replace with real provider SDK call)
  await simulateSend(to, subject, body);

  logger.info(`Email sent successfully`, { to, subject, jobId: job.id });
}

async function simulateSend(to, subject, body) {
  // Simulate ~200ms send time
  await delay(200);

  // Simulate a 10% transient failure rate to demo retries
  if (Math.random() < 0.1) {
    throw new Error("SMTP connection timeout — transient error");
  }

  // In production, replace the above with something like:
  // await sgMail.send({ to, from: "noreply@example.com", subject, text: body });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = emailProcessor;
