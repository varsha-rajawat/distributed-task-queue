/**
 * JobPriority — numeric scores used in Redis sorted sets.
 * Lower score = higher priority (ZPOPMIN picks the smallest score first).
 *
 * The final Redis score is computed as:
 *   PRIORITY_SCORE * 1e13 + unix_timestamp_ms
 *
 * This ensures HIGH jobs always beat MEDIUM, MEDIUM always beat LOW,
 * and within the same priority level, older jobs are processed first (FIFO).
 */
const JobPriority = Object.freeze({
  HIGH:   1,
  MEDIUM: 2,
  LOW:    3,
});

module.exports = JobPriority;
