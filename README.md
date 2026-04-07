# Distributed Task Queue

A production-grade distributed task queue built with **Node.js**, **Redis**, and **PostgreSQL**.

Redis serves as the hot, low-latency queue. PostgreSQL is the persistent source of truth for job history, the dead-letter queue, and scheduled job definitions.

---

## Features

| Feature | How it works |
|---|---|
| **Priority queues** | Redis sorted sets scored by `priority × 1e13 + timestamp` — HIGH always beats MEDIUM/LOW; FIFO within the same tier |
| **Retries with exponential backoff** | Failed jobs re-enter a delayed sorted set; delay = `base × 2^attempt` (1 s → 2 s → 4 s …) |
| **Dead-letter queue** | After `maxAttempts` failures the job row is marked `dead` and copied to `dead_letter_jobs` for inspection and manual replay |
| **Cron scheduling** | `scheduled_jobs` table + `node-cron` fires recurring jobs. Definitions are upserted via code — no manual SQL needed |
| **Atomic job claiming** | A Lua script atomically pops from the pending sorted set and writes to the processing hash — eliminates double-processing across workers |
| **Graceful shutdown** | Workers drain in-flight jobs before exiting; Redis and PG connections close cleanly |
| **REST API** | Express endpoints for enqueueing jobs, checking status, viewing stats, and replaying dead-letter jobs |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Node.js Process                        │
│                                                                 │
│  ┌──────────┐   add()    ┌──────────────┐                      │
│  │  API /   │──────────▶│   Queue.js   │                      │
│  │ Scheduler│            │  (ioredis)   │                      │
│  └──────────┘            └──────┬───────┘                      │
│                                 │ dequeue() [Lua atomic]        │
│                          ┌──────▼───────┐                      │
│                          │  Worker.js   │──▶ processor fn()    │
│                          │ (poll loop)  │                      │
│                          └──────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
           │  persist/update                    │
           ▼                                    ▼
   ┌───────────────┐                  ┌──────────────────┐
   │  PostgreSQL   │                  │     Redis        │
   │               │                  │                  │
   │  jobs         │                  │  queue:*:pending │  sorted set
   │  dead_letter  │                  │  queue:*:delayed │  sorted set
   │  scheduled    │                  │  queue:*:processing│ hash
   └───────────────┘                  └──────────────────┘
```

### Redis key layout

| Key | Type | Purpose |
|---|---|---|
| `queue:<name>:pending` | Sorted Set | Ready jobs, scored by priority+time |
| `queue:<name>:delayed` | Sorted Set | Future/retry jobs, scored by `run_at` ms |
| `queue:<name>:processing` | Hash | In-flight jobs; value = worker ID |

---

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js ≥ 18

### 1. Clone and install
```bash
git clone https://github.com/<you>/distributed-task-queue.git
cd distributed-task-queue
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env if you need non-default ports or passwords
```

### 3. Start Redis and PostgreSQL
```bash
docker compose up -d
```

### 4. Run database migrations
```bash
npm run migrate
```

### 5. Start the application
```bash
npm run dev          # development (nodemon)
# or
npm start            # production
```

The API will be available at `http://localhost:3000`.

---

## API Reference

### Enqueue a job
```bash
POST /api/jobs
Content-Type: application/json

{
  "queueName":   "email",
  "type":        "sendEmail",
  "payload":     { "to": "alice@example.com", "subject": "Hi!", "body": "Hello" },
  "priority":    "high",          // "high" | "medium" | "low"  (default: "medium")
  "maxAttempts": 5,               // optional, default from .env
  "runAt":       "2024-06-01T09:00:00Z"  // optional — schedules a delayed job
}
```

**Response `202 Accepted`:**
```json
{ "jobId": "uuid", "status": "accepted" }
```

### Get job status
```bash
GET /api/jobs/:id
```

### List jobs
```bash
GET /api/jobs?queueName=email&status=failed&limit=20&offset=0
```

### View dead-letter queue
```bash
GET /api/dead-letter?limit=20
```

### Replay a dead-letter job
```bash
POST /api/dead-letter/:id/retry
```

### Queue stats
```bash
GET /api/stats
```

### Health check
```bash
GET /api/health
```

---

## Adding a New Job Type

1. **Write a processor** in `src/processors/`:

```js
// src/processors/smsProcessor.js
async function smsProcessor(job) {
  const { phone, message } = job.payload;
  // call your SMS provider SDK here
}
module.exports = smsProcessor;
```

2. **Register it on a worker** in `src/index.js`:

```js
const smsProcessor = require("./processors/smsProcessor");

emailWorker.process("sendSMS", smsProcessor);
```

3. **Enqueue via API** or code:

```js
await emailQueue.add("sendSMS", { phone: "+1555000000", message: "Your code: 123456" });
```

---

## Adding a Scheduled Job

```js
await scheduler.define({
  name:      "hourly-cleanup",
  cronExpr:  "0 * * * *",      // every hour
  queueName: "email",
  type:      "sendEmail",
  payload:   { to: "ops@example.com", subject: "Hourly digest" },
  priority:  JobPriority.LOW,
});
```

Definitions are upserted in `scheduled_jobs`; changing `cronExpr` takes effect on the next `scheduler.start()`.

---

## Project Structure

```
src/
├── api/
│   ├── routes.js          REST API endpoints
│   └── server.js          Express app factory
├── db/
│   ├── connection.js      pg Pool + transaction helper
│   ├── migrations.js      Schema setup  (npm run migrate)
│   └── JobRepository.js   All DB queries
├── processors/
│   ├── emailProcessor.js  "sendEmail" job handler
│   └── reportProcessor.js "generateReport" job handler
├── queue/
│   ├── JobPriority.js     Priority constants
│   ├── Queue.js           Redis queue (add/dequeue/ack/nack)
│   ├── Worker.js          Poll loop + concurrency control
│   └── Scheduler.js       Cron scheduler
├── utils/
│   └── logger.js          Winston logger
└── index.js               Entry point
```

---

## Design Decisions

**Why Redis sorted sets instead of lists?**
Sorted sets give O(log N) priority ordering for free. A plain `LPUSH/RPOP` list only supports FIFO; getting priority would require multiple lists and complex polling logic.

**Why persist to PostgreSQL before Redis?**
If the process crashes after writing to Redis but before persisting to PG, the job would be lost. Writing PG first means we can always recover jobs from the database.

**Why a Lua script for `dequeue`?**
A Lua script in Redis executes atomically. Without it, two workers could both read the same top-scored job from `ZRANGE` before either removes it — leading to double processing.

**Why exponential backoff into the delayed set?**
Immediately re-queuing a failed job would hammer a failing downstream service. Backoff gives it time to recover while keeping the main pending set clean.

---

## License

MIT
