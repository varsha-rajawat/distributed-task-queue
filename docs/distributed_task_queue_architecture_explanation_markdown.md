# Architecture and Project Explanation

## The Problem This Project Solves

Imagine you run a website where users can sign up. When someone signs up, you want to send them a welcome email.

You have two choices:

### Option A — Do It Immediately in the Same Request

The user clicks **"Sign Up"**, your server sends the email, then responds **"Welcome!"**

The problem:
- If the email service is slow (for example, 2 seconds), the user stares at a loading spinner for 2 seconds.
- If the email service crashes, the entire signup fails.

### Option B — Hand It Off to a Background Worker

The user clicks **"Sign Up"**, your server instantly responds **"Welcome!"**, and separately, a background process sends the email a moment later.

The user never waits, and a crash in the email service does not affect the signup.

Option B is a **task queue**.

This project builds that system.

---

# The Three Technologies and What Each One Does

## Node.js — The Language / Runtime

Node.js is just JavaScript running on your computer (not in a browser). It is what runs your server code.

Everything in this project — the queue logic, the API, and the workers — is written in JavaScript and executed by Node.js.

Think of Node.js as the chef in a kitchen. It is the one actually doing the work.

---

## Redis — The Fast Short-Term Memory

Redis is a database, but a very unusual one: it stores everything in RAM instead of on disk.

Because of that, it is extremely fast. Reading and writing data takes microseconds.

In this project, Redis holds the list of jobs that are waiting to be processed right now.

Think of Redis as a whiteboard in the kitchen where new order tickets are posted. Workers constantly look at the whiteboard to grab the next job.

The tradeoff:

Because Redis stores data in memory, if the server crashes and restarts, that data can be lost.

So Redis is not where permanent information is stored.

---

## PostgreSQL — The Reliable Long-Term Record

PostgreSQL (usually called Postgres) is a traditional database that stores data on disk.

It is slower than Redis, but it is durable and does not lose data if the server crashes.

Postgres is also very good at:
- Filtering
- Searching
- Relationships
- Complex queries

In this project, Postgres is the permanent record of:
- Every job ever created
- Who created it
- When it ran
- Whether it succeeded or failed
- Dead-letter queue entries
- Scheduled cron jobs

Think of Postgres as the kitchen's order history binder — every ticket is permanently archived.

---

# The Core Concept: What Is a "Job"?

A job is simply a task you want to run in the background.

Each job contains:

```json
{
  "type": "sendEmail",
  "payload": {
    "to": "alice@example.com",
    "subject": "Hi"
  },
  "priority": "HIGH",
  "status": "pending",
  "attempts": 0
}
```

### Job Fields

- `type` — what kind of task this is, for example `sendEmail` or `generateReport`
- `payload` — the data needed to perform the task
- `priority` — `HIGH`, `MEDIUM`, or `LOW`
- `status` — `pending → processing → completed` or `failed → dead`
- `attempts` — how many times the system has tried this job

---

# How the Pieces Fit Together — Full Lifecycle of a Job

Imagine your application wants to send a welcome email.

## Step 1 — Someone Calls the API

Your application sends:

```http
POST /api/jobs
```

```json
{
  "queueName": "email",
  "type": "sendEmail",
  "payload": {
    "to": "alice@example.com"
  }
}
```

---

## Step 2 — Queue.js Saves the Job in Two Places

`Queue.js` receives the request and does two things at the same time:

1. Saves the job in PostgreSQL as the permanent record with status `pending`
2. Adds the job to Redis so workers can immediately see it

The Redis queue uses a **sorted set**.

A sorted set is like a ranked list where every item has a score.

This project calculates the score using:

```text
priority × large_number + timestamp
```

This ensures:
- Higher-priority jobs are processed first
- Jobs with the same priority are processed oldest-first (FIFO)

For example:

- `HIGH` priority jobs always come before `MEDIUM`
- `MEDIUM` comes before `LOW`
- If two jobs have the same priority, the older one is processed first

---

## Step 3 — Worker.js Picks Up the Job

`Worker.js` runs continuously.

Every second (configurable), it asks:

> "Is there anything waiting in the queue?"

If there is, it tries to claim the next job.

The claiming is done through a Lua script running inside Redis.

Why Lua?

Because the script runs atomically.

That means Redis guarantees that if two workers try to grab the same job at the exact same time, only one worker gets it.

Without this protection, you could accidentally send the same email twice.

After a worker successfully claims a job:

- The job is removed from the pending queue
- The job status in Postgres becomes `processing`

---

## Step 4 — The Processor Runs

The worker checks the job type.

If the type is:

```text
sendEmail
```

then the worker calls:

```text
emailProcessor.js
```

The processor receives the entire job object and performs the actual work.

Examples of work:
- Sending an email
- Generating a PDF report
- Calling another API
- Uploading a file

---

# Step 5 — What Happens Next?

## Step 5a — Success

If the processor finishes successfully:

```js
queue.ack(job)
```

The queue:
- Marks the job as `completed` in Postgres
- Removes it from the Redis processing list

The job is now finished.

---

## Step 5b — Failure With Retry

If the processor throws an error:

```js
queue.nack(job, error)
```

The queue now uses retry logic.

This project uses **exponential backoff**:

```text
1000ms × 2^(attempt number)
```

That means:

| Attempt | Delay |
|---------|--------|
| 1st retry | 1 second |
| 2nd retry | 2 seconds |
| 3rd retry | 4 seconds |
| 4th retry | 8 seconds |

This prevents the system from repeatedly hammering a broken service.

The failed job is moved into Redis's delayed queue.

The delayed queue is another sorted set where the score is the future timestamp when the job should become active again.

Every poll cycle, a promoter checks:

> "Has this job's retry time arrived yet?"

If yes, the promoter moves it back into the normal pending queue.

---

## Step 5c — Permanent Failure (Dead-Letter Queue)

If the job keeps failing and exceeds `maxAttempts`, the queue stops retrying.

The job is moved into a separate Postgres table:

```text
dead_letter_jobs
```

This is called the **dead-letter queue**.

The dead-letter queue exists so that:
- Failed jobs are not lost
- A developer or administrator can inspect them later
- The job can optionally be retried manually

You can replay a failed job through:

```http
POST /api/dead-letter/:id/retry
```

---

# The Scheduler — Cron Jobs

Sometimes you do not want to create jobs manually.

Instead, you want them to happen automatically on a schedule.

Example:

> Generate a report every day at 8:00 AM

`Scheduler.js` uses the `node-cron` library.

`node-cron` understands cron expressions.

For example:

```text
0 8 * * *
```

means:

> At minute 0 of hour 8, every day

When that time arrives, the scheduler automatically creates a new job and inserts it into the queue.

Exactly the same flow happens as if a user had manually called `POST /api/jobs`.

The scheduled definitions are stored in the Postgres table:

```text
scheduled_jobs
```

Because they are stored in Postgres, they survive restarts.

---

# The API — The Control Panel

`routes.js` and `server.js` expose an Express API.

The API allows you to:

| Action | Endpoint |
|--------|-----------|
| Add a job | `POST /api/jobs` |
| Get one job by ID | `GET /api/jobs/:id` |
| List all jobs with filters | `GET /api/jobs` |
| View dead-letter jobs | `GET /api/dead-letter` |
| Retry a dead-letter job | `POST /api/dead-letter/:id/retry` |
| View system statistics | `GET /api/stats` |

`GET /api/stats` combines:
- Redis queue sizes
- Postgres job counts
- Completed / failed totals

---

# Database Schema

This project uses three PostgreSQL tables.

## 1. `jobs`

Stores every job ever created.

Typical columns:
- `id`
- `type`
- `payload`
- `status`
- `priority`
- `attempts`
- `run_at`
- `completed_at`
- `error_message`

---

## 2. `dead_letter_jobs`

Stores permanently failed jobs.

This table usually contains:
- A copy of the original job
- The final error message
- Metadata about when it failed

This makes it easy to inspect or replay failed jobs without cluttering the main `jobs` table.

---

## 3. `scheduled_jobs`

Stores recurring job definitions.

Typical columns:
- `queue_name`
- `cron_expression`
- `job_type`
- `payload`
- `last_run_at`

---

# Putting It All Together — The Mental Model

```text
Your App / API
     │
     │  "please send this email"
     ▼
  Queue.js  ──── saves permanently ────▶ PostgreSQL
     │                                   (source of truth)
     │
     │ adds to hot list
     ▼
   Redis
 (fast in-memory sorted set)
     │
     │ worker polls every second
     ▼
  Worker.js ──── calls ────▶ emailProcessor.js
     │                        (does the real work)
     │
     ├── success ──▶ mark completed in Postgres, remove from Redis
     │
     └── failure ──▶ retry with backoff ──▶ eventually dead-letter queue
```

---

# Summary

This project demonstrates how to build a reliable distributed task queue using:

- Node.js for the application logic
- Redis for fast in-memory queueing
- PostgreSQL for durable storage

It includes:
- Priority-based processing
- Retry logic with exponential backoff
- Delayed jobs
- Dead-letter queues
- Cron scheduling
- Atomic worker coordination using Redis Lua scripts

The result is a system that is much faster and more reliable than performing long-running work directly inside a web request.

