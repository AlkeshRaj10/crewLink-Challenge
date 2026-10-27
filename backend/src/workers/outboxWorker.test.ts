import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { test } from "node:test";
import {
  MockPushProvider,
  processOutboxBatch,
  type PushJob,
  type PushOutcome,
} from "./outboxWorker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("outbox workers claim concurrently, retry safely, and recover abandoned leases", {
  skip: databaseUrl ? false : "Set TEST_DATABASE_URL to run PostgreSQL outbox worker tests",
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `crewlink_worker_test_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const database = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });

  try {
    for (const migrationName of [
      "001_initial_schema.sql",
      "002_user_account_status.sql",
      "003_outbox_worker.sql",
    ]) {
      const migrationPath = fileURLToPath(new URL(`../db/migrations/${migrationName}`, import.meta.url));
      await database.query(await readFile(migrationPath, "utf8"));
    }

    const localId = (await database.query(
      "INSERT INTO locals (name) VALUES ('Worker test local') RETURNING id",
    )).rows[0].id as string;
    const [leaderId, memberUserId] = (await database.query(
      `INSERT INTO users (email, password_hash) VALUES
         ('worker-leader@example.test', 'hash'), ('worker-member@example.test', 'hash')
       RETURNING id`,
    )).rows.map((row) => row.id as string);
    await database.query("INSERT INTO local_leaders (local_id, user_id) VALUES ($1, $2)", [localId, leaderId]);
    const classificationId = (await database.query(
      "INSERT INTO classifications (local_id, name) VALUES ($1, 'Worker class') RETURNING id",
      [localId],
    )).rows[0].id as string;
    const memberId = (await database.query(
      `INSERT INTO local_members (local_id, user_id, full_name, email, classification_id)
       VALUES ($1, $2, 'Worker Member', 'worker-member@example.test', $3) RETURNING id`,
      [localId, memberUserId, classificationId],
    )).rows[0].id as string;

    const createJobs = async (count: number, title: string): Promise<PushJob[]> => {
      const announcementId = (await database.query(
        `INSERT INTO announcements
           (local_id, author_user_id, title, body, status, approved_by_user_id, approved_at)
         VALUES ($1, $2, $3, 'Worker test body', 'sending', $2, now())
         RETURNING id`,
        [localId, leaderId, title],
      )).rows[0].id as string;
      const jobs: PushJob[] = [];
      for (let index = 0; index < count; index += 1) {
        let recipientMemberId = memberId;
        if (index > 0) {
          const userId = (await database.query(
            "INSERT INTO users (email, password_hash) VALUES ($1, 'hash') RETURNING id",
            [`worker-member-${randomUUID()}@example.test`],
          )).rows[0].id as string;
          recipientMemberId = (await database.query(
            `INSERT INTO local_members (local_id, user_id, full_name, email, classification_id)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [localId, userId, `Worker Member ${userId}`, `member-${userId}@example.test`, classificationId],
          )).rows[0].id as string;
        }
        const recipientId = (await database.query(
          `INSERT INTO announcement_recipients (local_id, announcement_id, member_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [localId, announcementId, recipientMemberId],
        )).rows[0].id as string;
        const job = (await database.query(
          `INSERT INTO outbox_jobs (local_id, recipient_id)
           VALUES ($1, $2)
           RETURNING id, local_id, recipient_id, provider_idempotency_key`,
          [localId, recipientId],
        )).rows[0];
        jobs.push({
          id: job.id as string,
          localId: job.local_id as string,
          recipientId: job.recipient_id as string,
          providerIdempotencyKey: job.provider_idempotency_key as string,
          attemptNumber: 1,
        });
      }
      return jobs;
    };

    const waitForCalls = async (count: number, calls: PushJob[]): Promise<void> => {
      for (let attempt = 0; attempt < 100 && calls.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(calls.length, count);
    };

    const concurrentJobs = await createJobs(4, "Concurrent delivery");
    const started: PushJob[] = [];
    let releaseFirstWorker!: () => void;
    const firstWorkerGate = new Promise<void>((resolve) => {
      releaseFirstWorker = resolve;
    });
    const firstWorker = processOutboxBatch(database, {
      async send(job) {
        started.push(job);
        await firstWorkerGate;
        return { status: "delivered", providerMessageId: `concurrent-${job.id}` };
      },
    }, { batchSize: 2 });
    await waitForCalls(2, started);
    const secondWorkerCalls: PushJob[] = [];
    const secondWorkerCount = await processOutboxBatch(database, {
      async send(job) {
        secondWorkerCalls.push(job);
        return { status: "delivered", providerMessageId: `second-${job.id}` };
      },
    }, { batchSize: 4 });
    releaseFirstWorker();
    assert.equal(await firstWorker, 2);
    assert.equal(secondWorkerCount, 2);
    assert.equal(new Set([...started, ...secondWorkerCalls].map((job) => job.id)).size, 4);
    const concurrentState = await database.query(
      `SELECT count(*) FILTER (WHERE job.status = 'done')::int AS done_jobs,
              count(*) FILTER (WHERE recipient.push_status = 'delivered')::int AS delivered_recipients,
              count(*)::int AS attempts
       FROM outbox_jobs AS job
       JOIN announcement_recipients AS recipient
         ON recipient.local_id = job.local_id AND recipient.id = job.recipient_id
       WHERE job.id = ANY($1::uuid[])`,
      [concurrentJobs.map((job) => job.id)],
    );
    assert.deepEqual(concurrentState.rows[0], { done_jobs: 4, delivered_recipients: 4, attempts: 4 });

    const [transientJob] = await createJobs(1, "Transient retry");
    const seenKeys: string[] = [];
    const retryProvider = new MockPushProvider(database, (job) => {
      seenKeys.push(job.providerIdempotencyKey);
      return job.attemptNumber === 1
        ? { status: "transient_failure", errorCode: "temporary_unavailable" }
        : { status: "delivered", providerMessageId: "retry-success" };
    });
    assert.equal(await processOutboxBatch(database, retryProvider, { baseBackoffMilliseconds: 10 }), 1);
    let retryState = (await database.query(
      `SELECT job.status, recipient.push_status, job.attempt_count
       FROM outbox_jobs AS job
       JOIN announcement_recipients AS recipient
         ON recipient.local_id = job.local_id AND recipient.id = job.recipient_id
       WHERE job.id = $1`,
      [transientJob.id],
    )).rows[0];
    assert.deepEqual(retryState, { status: "pending", push_status: "queued", attempt_count: 1 });
    await database.query("UPDATE outbox_jobs SET available_at = now() WHERE id = $1", [transientJob.id]);
    assert.equal(await processOutboxBatch(database, retryProvider, { baseBackoffMilliseconds: 10 }), 1);
    retryState = (await database.query(
      `SELECT job.status, recipient.push_status, job.attempt_count
       FROM outbox_jobs AS job
       JOIN announcement_recipients AS recipient
         ON recipient.local_id = job.local_id AND recipient.id = job.recipient_id
       WHERE job.id = $1`,
      [transientJob.id],
    )).rows[0];
    assert.deepEqual(retryState, { status: "done", push_status: "delivered", attempt_count: 2 });
    assert.equal(seenKeys.length, 2);
    assert.equal(seenKeys[0], seenKeys[1]);
    const retryAttempts = await database.query(
      `SELECT provider_status FROM delivery_attempts
       WHERE local_id = $1 AND recipient_id = $2 ORDER BY attempt_number`,
      [transientJob.localId, transientJob.recipientId],
    );
    assert.deepEqual(retryAttempts.rows.map((row) => row.provider_status), ["transient_failure", "delivered"]);

    const [permanentJob] = await createJobs(1, "Permanent failure");
    assert.equal(await processOutboxBatch(database, {
      async send(): Promise<PushOutcome> {
        return { status: "permanent_failure", errorCode: "invalid_device_token" };
      },
    }), 1);
    const permanentState = (await database.query(
      `SELECT job.status, recipient.push_status, count(delivery.id)::int AS deliveries
       FROM outbox_jobs AS job
       JOIN announcement_recipients AS recipient
         ON recipient.local_id = job.local_id AND recipient.id = job.recipient_id
       LEFT JOIN mock_push_deliveries AS delivery ON delivery.outbox_job_id = job.id
       WHERE job.id = $1
       GROUP BY job.status, recipient.push_status`,
      [permanentJob.id],
    )).rows[0];
    assert.deepEqual(permanentState, { status: "failed", push_status: "failed", deliveries: 0 });

    const [abandonedJob] = await createJobs(1, "Abandoned lease");
    await database.query(
      `UPDATE outbox_jobs
       SET status = 'processing', attempt_count = 1, lease_until = now() - interval '1 minute'
       WHERE id = $1`,
      [abandonedJob.id],
    );
    await database.query(
      "UPDATE announcement_recipients SET push_status = 'attempting' WHERE id = $1",
      [abandonedJob.recipientId],
    );
    let providerInvocations = 0;
    const restartProvider = new MockPushProvider(database, () => {
      providerInvocations += 1;
      return { status: "delivered", providerMessageId: "first-process-delivery" };
    });
    const staleWorkerJob = { ...abandonedJob, attemptNumber: 1 };
    await restartProvider.send(staleWorkerJob);
    assert.equal(await processOutboxBatch(database, new MockPushProvider(database, () => {
      throw new Error("Persisted provider success should be reused after restart");
    })), 1);
    assert.equal(providerInvocations, 1);
    const recoveryState = (await database.query(
      `SELECT job.status, recipient.push_status,
              (SELECT count(*)::int FROM mock_push_deliveries WHERE outbox_job_id = job.id) AS provider_deliveries,
              (SELECT count(*)::int FROM delivery_attempts WHERE local_id = job.local_id AND recipient_id = job.recipient_id) AS attempts
       FROM outbox_jobs AS job
       JOIN announcement_recipients AS recipient
         ON recipient.local_id = job.local_id AND recipient.id = job.recipient_id
       WHERE job.id = $1`,
      [abandonedJob.id],
    )).rows[0];
    assert.deepEqual(recoveryState, {
      status: "done",
      push_status: "delivered",
      provider_deliveries: 1,
      attempts: 1,
    });
    const recoveryRecordCounts = (await database.query(
      `SELECT count(DISTINCT recipient.id)::int AS recipients,
              count(DISTINCT job.id)::int AS jobs
       FROM announcement_recipients AS recipient
       JOIN outbox_jobs AS job
         ON job.local_id = recipient.local_id AND job.recipient_id = recipient.id
       WHERE recipient.id = $1`,
      [abandonedJob.recipientId],
    )).rows[0];
    assert.deepEqual(recoveryRecordCounts, { recipients: 1, jobs: 1 });

    const [exhaustedJob] = await createJobs(1, "Retry exhaustion");
    await processOutboxBatch(database, {
      async send(): Promise<PushOutcome> {
        return { status: "transient_failure", errorCode: "still_unavailable" };
      },
    }, { maxAttempts: 1 });
    const exhaustedState = (await database.query(
      `SELECT job.status, recipient.push_status, delivery.provider_status
       FROM outbox_jobs AS job
       JOIN announcement_recipients AS recipient
         ON recipient.local_id = job.local_id AND recipient.id = job.recipient_id
       JOIN delivery_attempts AS delivery
         ON delivery.local_id = job.local_id AND delivery.recipient_id = job.recipient_id
       WHERE job.id = $1`,
      [exhaustedJob.id],
    )).rows[0];
    assert.deepEqual(exhaustedState, {
      status: "failed",
      push_status: "failed",
      provider_status: "transient_failure",
    });
  } finally {
    await database.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
});
