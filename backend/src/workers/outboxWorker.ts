import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type PushOutcome =
  | { status: "delivered"; providerMessageId: string }
  | { status: "transient_failure" | "permanent_failure"; errorCode: string };

export interface PushJob {
  id: string;
  localId: string;
  recipientId: string;
  providerIdempotencyKey: string;
  attemptNumber: number;
}

export interface PushProvider {
  send(job: PushJob): Promise<PushOutcome>;
}

export interface WorkerOptions {
  batchSize?: number;
  leaseMilliseconds?: number;
  maxAttempts?: number;
  baseBackoffMilliseconds?: number;
}

interface ClaimedJob extends PushJob {
  leaseToken: string;
}

const defaultOptions = {
  batchSize: 10,
  leaseMilliseconds: 30_000,
  maxAttempts: 5,
  baseBackoffMilliseconds: 1_000,
};

function assertWorkerOptions(options: Required<WorkerOptions>): void {
  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    !Number.isInteger(options.leaseMilliseconds) ||
    options.leaseMilliseconds < 1 ||
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    !Number.isInteger(options.baseBackoffMilliseconds) ||
    options.baseBackoffMilliseconds < 1
  ) {
    throw new Error("Outbox worker options must be positive integers");
  }
}

async function claimJobs(
  database: Pool,
  batchSize: number,
  leaseMilliseconds: number,
): Promise<ClaimedJob[]> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH candidates AS (
         SELECT id
         FROM outbox_jobs
         WHERE (status = 'pending' AND available_at <= now())
            OR (status = 'processing' AND lease_until <= now())
         ORDER BY available_at, created_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_jobs AS job
       SET status = 'processing',
           attempt_count = job.attempt_count + 1,
           lease_until = now() + ($2 * interval '1 millisecond'),
           lease_token = gen_random_uuid(),
           updated_at = now()
       FROM candidates
       WHERE job.id = candidates.id
       RETURNING job.id, job.local_id, job.recipient_id, job.provider_idempotency_key,
                 job.attempt_count, job.lease_token`,
      [batchSize, leaseMilliseconds],
    );
    const jobs = result.rows.map((row) => ({
      id: row.id as string,
      localId: row.local_id as string,
      recipientId: row.recipient_id as string,
      providerIdempotencyKey: row.provider_idempotency_key as string,
      attemptNumber: row.attempt_count as number,
      leaseToken: row.lease_token as string,
    }));

    if (jobs.length > 0) {
      await client.query(
        `INSERT INTO delivery_attempts (local_id, recipient_id, attempt_number, provider_status)
         SELECT local_id, recipient_id, attempt_count, 'unknown'
         FROM outbox_jobs
         WHERE id = ANY($1::uuid[])
         ON CONFLICT (local_id, recipient_id, attempt_number) DO NOTHING`,
        [jobs.map((job) => job.id)],
      );
      await client.query(
        `UPDATE announcement_recipients AS recipient
         SET push_status = 'attempting'
         FROM outbox_jobs AS job
         WHERE job.id = ANY($1::uuid[])
           AND recipient.local_id = job.local_id
           AND recipient.id = job.recipient_id
           AND recipient.push_status = 'queued'`,
        [jobs.map((job) => job.id)],
      );
    }

    await client.query("COMMIT");
    return jobs;
  } catch (error) {
    await rollback(client, error);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback(client: PoolClient, originalError: unknown): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    console.error("Could not roll back outbox worker transaction:", rollbackError);
  }
  throw originalError;
}

async function saveOutcome(
  database: Pool,
  job: ClaimedJob,
  outcome: PushOutcome,
  options: Required<WorkerOptions>,
): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const exhausted = outcome.status === "transient_failure" && job.attemptNumber >= options.maxAttempts;
    const attemptStatus = exhausted ? "transient_failure" : outcome.status;
    const providerMessageId = outcome.status === "delivered" ? outcome.providerMessageId : null;
    const errorCode = outcome.status === "delivered" ? null : outcome.errorCode;

    await client.query(
      `UPDATE delivery_attempts
       SET provider_status = $1, provider_message_id = $2, error_code = $3
       WHERE local_id = $4 AND recipient_id = $5 AND attempt_number = $6`,
      [attemptStatus, providerMessageId, errorCode, job.localId, job.recipientId, job.attemptNumber],
    );

    let nextStatus: "pending" | "done" | "failed";
    let nextPushStatus: "queued" | "delivered" | "failed";
    let nextAvailableAt: Date | null = null;
    if (outcome.status === "delivered") {
      nextStatus = "done";
      nextPushStatus = "delivered";
    } else if (outcome.status === "permanent_failure" || exhausted) {
      nextStatus = "failed";
      nextPushStatus = "failed";
    } else {
      nextStatus = "pending";
      nextPushStatus = "queued";
      const delay = Math.min(
        options.baseBackoffMilliseconds * 2 ** (job.attemptNumber - 1),
        60 * 60 * 1_000,
      );
      nextAvailableAt = new Date(Date.now() + delay);
    }

    const updated = await client.query(
      `UPDATE outbox_jobs
       SET status = $1,
           available_at = COALESCE($2, available_at),
           lease_until = NULL,
           lease_token = NULL,
           updated_at = now()
       WHERE local_id = $3 AND id = $4
         AND status = 'processing' AND lease_token = $5`,
      [nextStatus, nextAvailableAt, job.localId, job.id, job.leaseToken],
    );

    if (updated.rowCount === 1) {
      await client.query(
        `UPDATE announcement_recipients
         SET push_status = $1
         WHERE local_id = $2 AND id = $3`,
        [nextPushStatus, job.localId, job.recipientId],
      );
      await client.query(
        `UPDATE announcements AS announcement
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM announcement_recipients AS failed_recipient
                 JOIN outbox_jobs AS failed_job
                   ON failed_job.local_id = failed_recipient.local_id
                  AND failed_job.recipient_id = failed_recipient.id
                 WHERE failed_recipient.local_id = announcement.local_id
                   AND failed_recipient.announcement_id = announcement.id
                   AND failed_job.status = 'failed'
               ) THEN 'failed'
               ELSE 'sent'
             END,
             sent_at = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM announcement_recipients AS failed_recipient
                 JOIN outbox_jobs AS failed_job
                   ON failed_job.local_id = failed_recipient.local_id
                  AND failed_job.recipient_id = failed_recipient.id
                 WHERE failed_recipient.local_id = announcement.local_id
                   AND failed_recipient.announcement_id = announcement.id
                   AND failed_job.status = 'failed'
               ) THEN NULL
               ELSE COALESCE(sent_at, now())
             END
         WHERE announcement.local_id = $1
           AND announcement.id = (
             SELECT recipient.announcement_id
             FROM announcement_recipients AS recipient
             WHERE recipient.local_id = $1 AND recipient.id = $2
           )
           AND announcement.status = 'sending'
           AND NOT EXISTS (
             SELECT 1
             FROM announcement_recipients AS recipient
             JOIN outbox_jobs AS pending_job
               ON pending_job.local_id = recipient.local_id
              AND pending_job.recipient_id = recipient.id
             WHERE recipient.local_id = announcement.local_id
               AND recipient.announcement_id = announcement.id
               AND pending_job.status IN ('pending', 'processing')
           )`,
        [job.localId, job.recipientId],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await rollback(client, error);
  } finally {
    client.release();
  }
}

export async function processOutboxBatch(
  database: Pool,
  provider: PushProvider,
  suppliedOptions: WorkerOptions = {},
): Promise<number> {
  const options = { ...defaultOptions, ...suppliedOptions };
  assertWorkerOptions(options);
  const jobs = await claimJobs(database, options.batchSize, options.leaseMilliseconds);

  const results = await Promise.allSettled(jobs.map(async (job) => {
    let outcome: PushOutcome;
    try {
      outcome = await provider.send(job);
    } catch (error) {
      console.error(`Push provider failed for outbox job ${job.id}:`, error);
      outcome = { status: "transient_failure", errorCode: "provider_exception" };
    }
    await saveOutcome(database, job, outcome, options);
  }));
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more outbox jobs could not be finalized");
  }
  return jobs.length;
}

export class MockPushProvider implements PushProvider {
  constructor(
    private readonly database: Pool,
    private readonly outcomeForAttempt: (job: PushJob) => PushOutcome | Promise<PushOutcome> = () => ({
      status: "delivered",
      providerMessageId: `mock-${randomUUID()}`,
    }),
  ) {}

  async send(job: PushJob): Promise<PushOutcome> {
    const previousDelivery = await this.database.query(
      `SELECT provider_message_id
       FROM mock_push_deliveries
       WHERE provider_idempotency_key = $1`,
      [job.providerIdempotencyKey],
    );
    if (previousDelivery.rowCount === 1) {
      return {
        status: "delivered",
        providerMessageId: previousDelivery.rows[0].provider_message_id as string,
      };
    }

    const outcome = await this.outcomeForAttempt(job);
    if (outcome.status !== "delivered") {
      console.info(`Mock push ${outcome.status}: job=${job.id} recipient=${job.recipientId}`);
      return outcome;
    }

    await this.database.query(
      `INSERT INTO mock_push_deliveries
         (local_id, outbox_job_id, recipient_id, provider_idempotency_key, provider_message_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider_idempotency_key) DO NOTHING`,
      [job.localId, job.id, job.recipientId, job.providerIdempotencyKey, outcome.providerMessageId],
    );
    const persistedDelivery = await this.database.query(
      `SELECT local_id, outbox_job_id, recipient_id, provider_message_id
       FROM mock_push_deliveries
       WHERE provider_idempotency_key = $1`,
      [job.providerIdempotencyKey],
    );
    const delivery = persistedDelivery.rows[0] as {
      local_id: string;
      outbox_job_id: string;
      recipient_id: string;
      provider_message_id: string;
    } | undefined;
    if (
      !delivery ||
      delivery.local_id !== job.localId ||
      delivery.outbox_job_id !== job.id ||
      delivery.recipient_id !== job.recipientId
    ) {
      throw new Error("Mock provider idempotency key is associated with a different outbox job");
    }

    console.info(`Mock push delivered: job=${job.id} recipient=${job.recipientId}`);
    return { status: "delivered", providerMessageId: delivery.provider_message_id };
  }
}

export async function runOutboxWorker(
  database: Pool,
  provider: PushProvider,
  signal: AbortSignal,
  pollIntervalMilliseconds = 1_000,
): Promise<void> {
  if (!Number.isInteger(pollIntervalMilliseconds) || pollIntervalMilliseconds < 1) {
    throw new Error("Worker poll interval must be a positive integer");
  }
  while (!signal.aborted) {
    const claimed = await processOutboxBatch(database, provider);
    if (claimed === 0) {
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, pollIntervalMilliseconds);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      });
    }
  }
}
