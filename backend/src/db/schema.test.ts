import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { test } from "node:test";
import { authenticateCredentials, isActiveUser } from "../auth/accounts.js";
import { userHasLocalRole } from "../auth/localAccess.js";
import { hashPassword } from "../auth/password.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("schema enforces tenant, deduplication, and retry-key constraints", {
  skip: databaseUrl ? false : "Set TEST_DATABASE_URL to run PostgreSQL schema tests",
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `crewlink_test_${randomUUID().replaceAll("-", "")}`;
  const adminClient = await adminPool.connect();

  try {
    await adminClient.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    adminClient.release();
  }

  const testPool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });

  try {
    for (const migrationName of ["001_initial_schema.sql", "002_user_account_status.sql"]) {
      const migrationPath = fileURLToPath(new URL(`./migrations/${migrationName}`, import.meta.url));
      await testPool.query(await readFile(migrationPath, "utf8"));
    }

    const localA = (await testPool.query("INSERT INTO locals (name) VALUES ('Test Local A') RETURNING id")).rows[0].id as string;
    const localB = (await testPool.query("INSERT INTO locals (name) VALUES ('Test Local B') RETURNING id")).rows[0].id as string;
    const userIds = (await testPool.query(
      `INSERT INTO users (email, password_hash) VALUES
        ('leader-a@example.test', 'hash'), ('member-a@example.test', 'hash'),
        ('leader-b@example.test', 'hash'), ('member-b@example.test', 'hash')
       RETURNING id`,
    )).rows.map((row) => row.id as string);
    const [leaderA, memberA, leaderB, memberB] = userIds;

    const [classificationA, classificationB] = (await testPool.query(
      `INSERT INTO classifications (local_id, name) VALUES ($1, 'A classification'), ($2, 'B classification') RETURNING id`,
      [localA, localB],
    )).rows.map((row) => row.id as string);

    await testPool.query(
      `INSERT INTO local_leaders (local_id, user_id) VALUES ($1, $2), ($3, $4)`,
      [localA, leaderA, localB, leaderB],
    );
    const memberRowA = (await testPool.query(
      `INSERT INTO local_members (local_id, user_id, full_name, email, classification_id)
       VALUES ($1, $2, 'Member A', 'member-a@example.test', $3) RETURNING id`,
      [localA, memberA, classificationA],
    )).rows[0].id as string;
    const memberRowB = (await testPool.query(
      `INSERT INTO local_members (local_id, user_id, full_name, email, classification_id)
       VALUES ($1, $2, 'Member B', 'member-b@example.test', $3) RETURNING id`,
      [localB, memberB, classificationB],
    )).rows[0].id as string;
    assert.equal(await userHasLocalRole(testPool, leaderA, localA, "leader"), true);
    assert.equal(await userHasLocalRole(testPool, leaderA, localB, "leader"), false);
    assert.equal(await userHasLocalRole(testPool, leaderA, localA, "member"), false);
    assert.equal(await userHasLocalRole(testPool, memberA, localA, "member"), true);
    assert.equal(await userHasLocalRole(testPool, memberA, localB, "member"), false);
    await testPool.query("UPDATE users SET password_hash = $1 WHERE id IN ($2, $3)", [
      hashPassword("test-password"),
      leaderA,
      memberA,
    ]);
    assert.equal(await authenticateCredentials(testPool, "LEADER-A@example.test", "wrong-password"), null);
    assert.equal(await authenticateCredentials(testPool, "MEMBER-A@example.test", "test-password"), memberA);
    assert.equal(await isActiveUser(testPool, leaderA), true);
    await testPool.query("UPDATE users SET is_active = false WHERE id = $1", [leaderA]);
    assert.equal(await isActiveUser(testPool, leaderA), false);
    assert.equal(await authenticateCredentials(testPool, "leader-a@example.test", "test-password"), null);
    await testPool.query("UPDATE users SET is_active = true WHERE id = $1", [leaderA]);

    const announcementA = (await testPool.query(
      `INSERT INTO announcements (local_id, author_user_id, title, body, status, approved_by_user_id, approved_at)
       VALUES ($1, $2, 'A announcement', 'Body', 'approved', $2, now()) RETURNING id`,
      [localA, leaderA],
    )).rows[0].id as string;
    const announcementB = (await testPool.query(
       `INSERT INTO announcements (local_id, author_user_id, title, body, status, approved_by_user_id, approved_at)
        VALUES ($1, $2, 'B announcement', 'Body', 'approved', $2, now()) RETURNING id`,
       [localB, leaderB],
    )).rows[0].id as string;

    const expectConstraintError = async (query: string, values: unknown[], code: string) => {
       await assert.rejects(
         testPool.query(query, values),
         (error: unknown) => (error as { code?: string }).code === code,
       );
    };

    const recipientA = (await testPool.query(
       `INSERT INTO announcement_recipients (local_id, announcement_id, member_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [localA, announcementA, memberRowA],
    )).rows[0].id as string;

    await testPool.query(
      `INSERT INTO send_requests (local_id, leader_user_id, announcement_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3, 'send-key', 'hash-1')`,
      [localA, leaderA, announcementA],
    );
    await expectConstraintError(
      `INSERT INTO send_requests (local_id, leader_user_id, announcement_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3, 'send-key', 'hash-1')`,
      [localB, leaderB, announcementA],
      "23503",
    );
    await expectConstraintError(
      `INSERT INTO send_requests (local_id, leader_user_id, announcement_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3, 'other-key', 'hash-1')`,
      [localA, leaderB, announcementA],
      "23503",
    );

    await expectConstraintError(
      `UPDATE local_members SET classification_id = $1 WHERE local_id = $2 AND id = $3`,
      [classificationB, localA, memberRowA],
      "23503",
    );
    await expectConstraintError(
      `INSERT INTO announcements (local_id, author_user_id, title, body)
       VALUES ($1, $2, 'Invalid author', 'Body')`,
      [localA, leaderB],
      "23503",
    );
    await expectConstraintError(
      `INSERT INTO announcements
         (local_id, author_user_id, title, body, status, approved_by_user_id, approved_at)
       VALUES ($1, $2, 'Invalid approver', 'Body', 'approved', $3, now())`,
      [localA, leaderA, leaderB],
      "23503",
    );
    await expectConstraintError(
      `INSERT INTO announcement_recipients (local_id, announcement_id, member_id)
       VALUES ($1, $2, $3)`,
      [localB, announcementA, memberRowB],
      "23503",
    );
    await expectConstraintError(
      `INSERT INTO announcement_recipients (local_id, announcement_id, member_id)
       VALUES ($1, $2, $3)`,
      [localA, announcementA, memberRowB],
      "23503",
    );
    await expectConstraintError(
      `INSERT INTO outbox_jobs (local_id, recipient_id) VALUES ($1, $2)`,
      [localB, recipientA],
      "23503",
    );
    await expectConstraintError(
      `INSERT INTO delivery_attempts (local_id, recipient_id, attempt_number, provider_status)
       VALUES ($1, $2, 1, 'accepted')`,
      [localB, recipientA],
      "23503",
    );
    await expectConstraintError(
      `INSERT INTO announcement_recipients (local_id, announcement_id, member_id)
       VALUES ($1, $2, $3)`,
      [localA, announcementA, memberRowA],
      "23505",
    );
    const job = (await testPool.query(
      `INSERT INTO outbox_jobs (local_id, recipient_id) VALUES ($1, $2)
       RETURNING provider_idempotency_key`,
      [localA, recipientA],
    )).rows[0];
    await expectConstraintError(
      `INSERT INTO send_requests (local_id, leader_user_id, announcement_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3, 'send-key', 'different-hash')`,
      [localA, leaderA, announcementA],
      "23505",
    );
    await expectConstraintError(
      `INSERT INTO outbox_jobs (local_id, recipient_id) VALUES ($1, $2)`,
      [localA, recipientA],
      "23505",
    );

    const sendKeyOtherLocal = await testPool.query(
      `INSERT INTO send_requests (local_id, leader_user_id, announcement_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3, 'send-key', 'hash-1')`,
      [localB, leaderB, announcementB],
    );
    assert.equal(sendKeyOtherLocal.rowCount, 1);

    await testPool.query(
      `UPDATE outbox_jobs SET status = 'pending', attempt_count = attempt_count + 1,
       available_at = now() + interval '1 second', lease_until = NULL WHERE local_id = $1 AND recipient_id = $2`,
      [localA, recipientA],
    );
    const retriedJob = (await testPool.query(
      `SELECT provider_idempotency_key FROM outbox_jobs WHERE local_id = $1 AND recipient_id = $2`,
      [localA, recipientA],
    )).rows[0];
    assert.equal(retriedJob.provider_idempotency_key, job.provider_idempotency_key);
  } finally {
    await testPool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
});
