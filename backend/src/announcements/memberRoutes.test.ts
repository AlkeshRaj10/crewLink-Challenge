import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { test } from "node:test";
import { createAccessToken } from "../auth/token.js";
import { createMemberAnnouncementRouter } from "./memberRoutes.js";

process.env.JWT_SECRET ??= "member-announcement-tests-only-secret-32-bytes";
const databaseUrl = process.env.TEST_DATABASE_URL;

test("members can only list, read, and idempotently acknowledge their own local recipients", {
  skip: databaseUrl ? false : "Set TEST_DATABASE_URL to run PostgreSQL member announcement tests",
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `crewlink_member_api_test_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const testPool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  const app = express();
  app.use(express.json());
  app.use("/locals/:localId/member/announcements", createMemberAnnouncementRouter(testPool));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error("Member announcement test app error:", error);
    response.status(500).json({ error: "Internal server error" });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const migrationName of ["001_initial_schema.sql", "002_user_account_status.sql"]) {
      const migrationPath = fileURLToPath(new URL(`../db/migrations/${migrationName}`, import.meta.url));
      await testPool.query(await readFile(migrationPath, "utf8"));
    }

    const localA = (await testPool.query("INSERT INTO locals (name) VALUES ('Member API Local A') RETURNING id")).rows[0].id as string;
    const localB = (await testPool.query("INSERT INTO locals (name) VALUES ('Member API Local B') RETURNING id")).rows[0].id as string;
    const users = (await testPool.query(
      `INSERT INTO users (email, password_hash) VALUES
        ('member-one@example.test', 'hash'), ('member-two@example.test', 'hash'),
        ('member-other@example.test', 'hash'), ('leader-a@example.test', 'hash'),
        ('leader-b@example.test', 'hash')
       RETURNING id`,
    )).rows.map((row) => row.id as string);
    const [memberOne, memberTwo, memberOther, leaderA, leaderB] = users;
    await testPool.query(
      `INSERT INTO local_leaders (local_id, user_id) VALUES ($1, $2), ($3, $4)`,
      [localA, leaderA, localB, leaderB],
    );
    const classifications = (await testPool.query(
      `INSERT INTO classifications (local_id, name) VALUES
        ($1, 'Classification A'), ($2, 'Classification B') RETURNING local_id, id`,
      [localA, localB],
    )).rows;
    const classificationA = classifications.find((row) => row.local_id === localA)?.id as string;
    const classificationB = classifications.find((row) => row.local_id === localB)?.id as string;

    const memberRows = await Promise.all([
      testPool.query(
        `INSERT INTO local_members (local_id, user_id, full_name, email, classification_id)
         VALUES ($1, $2, 'Member One', 'member-one@example.test', $3) RETURNING id`,
        [localA, memberOne, classificationA],
      ),
      testPool.query(
        `INSERT INTO local_members (local_id, user_id, full_name, email, classification_id)
         VALUES ($1, $2, 'Member Two', 'member-two@example.test', $3) RETURNING id`,
        [localA, memberTwo, classificationA],
      ),
      testPool.query(
        `INSERT INTO local_members (local_id, user_id, full_name, email, classification_id)
         VALUES ($1, $2, 'Member Other', 'member-other@example.test', $3) RETURNING id`,
        [localB, memberOther, classificationB],
      ),
    ]);
    const [memberOneId, memberTwoId, memberOtherId] = memberRows.map((result) => result.rows[0].id as string);
    const announcementA = (await testPool.query(
      `INSERT INTO announcements
         (local_id, author_user_id, title, body, needs_ack, status, approved_by_user_id, approved_at, sent_at)
       VALUES ($1, $2, 'Local A Callout', 'A body', true, 'sent', $2, now(), now()) RETURNING id`,
      [localA, leaderA],
    )).rows[0].id as string;
    const announcementB = (await testPool.query(
      `INSERT INTO announcements
         (local_id, author_user_id, title, body, needs_ack, status, approved_by_user_id, approved_at, sent_at)
       VALUES ($1, $2, 'Local B Callout', 'B body', true, 'sent', $2, now(), now()) RETURNING id`,
      [localB, leaderB],
    )).rows[0].id as string;
    const noAcknowledgementAnnouncement = (await testPool.query(
      `INSERT INTO announcements
         (local_id, author_user_id, title, body, needs_ack, status, approved_by_user_id, approved_at, sent_at)
       VALUES ($1, $2, 'Optional Response', 'No ack required', false, 'sent', $2, now(), now()) RETURNING id`,
      [localA, leaderA],
    )).rows[0].id as string;
    const queuedAnnouncement = (await testPool.query(
      `INSERT INTO announcements
         (local_id, author_user_id, title, body, needs_ack, status, approved_by_user_id, approved_at)
       VALUES ($1, $2, 'Queued Update', 'Available while push delivery is pending', false, 'sending', $2, now())
       RETURNING id`,
      [localA, leaderA],
    )).rows[0].id as string;

    await testPool.query(
      `INSERT INTO announcement_recipients (local_id, announcement_id, member_id) VALUES
        ($1, $2, $3), ($4, $5, $6), ($1, $7, $3), ($1, $8, $3)`,
      [localA, announcementA, memberOneId, localB, announcementB, memberOtherId, noAcknowledgementAnnouncement, queuedAnnouncement],
    );

    const memberOneToken = createAccessToken(memberOne);
    const memberTwoToken = createAccessToken(memberTwo);
    const memberOtherToken = createAccessToken(memberOther);
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    const memberAPath = `${baseUrl}/locals/${localA}/member/announcements`;

    const listResponse = await fetch(memberAPath, { headers: auth(memberOneToken) });
    assert.equal(listResponse.status, 200);
    const listData = await listResponse.json() as { announcements: Array<{ id: string }> };
    assert.deepEqual(listData.announcements.map((announcement) => announcement.id).sort(), [
      announcementA,
      noAcknowledgementAnnouncement,
      queuedAnnouncement,
    ].sort());

    const queuedReadResponse = await fetch(`${memberAPath}/${queuedAnnouncement}`, { headers: auth(memberOneToken) });
    assert.equal(queuedReadResponse.status, 200);

    const readResponse = await fetch(`${memberAPath}/${announcementA}`, { headers: auth(memberOneToken) });
    assert.equal(readResponse.status, 200);
    const readData = await readResponse.json() as { announcement: { read_at: string | null } };
    assert.ok(readData.announcement.read_at);
    const initialReadAt = readData.announcement.read_at;

    const acknowledgeUrl = `${memberAPath}/${announcementA}/acknowledge`;
    const [ackFirst, ackConcurrent] = await Promise.all([
      fetch(acknowledgeUrl, { method: "POST", headers: auth(memberOneToken) }),
      fetch(acknowledgeUrl, { method: "POST", headers: auth(memberOneToken) }),
    ]);
    assert.equal(ackFirst.status, 200);
    assert.equal(ackConcurrent.status, 200);
    const ackFirstData = await ackFirst.json() as { readAt: string; acknowledgedAt: string };
    const ackConcurrentData = await ackConcurrent.json() as typeof ackFirstData;
    assert.equal(ackFirstData.acknowledgedAt, ackConcurrentData.acknowledgedAt);
    assert.equal(ackFirstData.readAt, ackConcurrentData.readAt);

    const ackRepeated = await fetch(acknowledgeUrl, { method: "POST", headers: auth(memberOneToken) });
    assert.equal(ackRepeated.status, 200);
    const ackRepeatedData = await ackRepeated.json() as typeof ackFirstData;
    assert.equal(ackRepeatedData.acknowledgedAt, ackFirstData.acknowledgedAt);
    assert.equal(ackRepeatedData.readAt, initialReadAt);

    const storedAction = await testPool.query(
      `SELECT read_at, acknowledged_at FROM announcement_recipients
       WHERE local_id = $1 AND announcement_id = $2 AND member_id = $3`,
      [localA, announcementA, memberOneId],
    );
    assert.equal(storedAction.rowCount, 1);
    assert.equal(storedAction.rows[0].read_at.toISOString(), ackFirstData.readAt);
    assert.equal(storedAction.rows[0].acknowledged_at.toISOString(), ackFirstData.acknowledgedAt);

    const nonRecipientRead = await fetch(`${memberAPath}/${announcementA}`, { headers: auth(memberTwoToken) });
    assert.equal(nonRecipientRead.status, 404);
    const nonRecipientAck = await fetch(`${memberAPath}/${announcementA}/acknowledge`, {
      method: "POST",
      headers: auth(memberTwoToken),
    });
    assert.equal(nonRecipientAck.status, 404);
    const wrongLocalPath = `${baseUrl}/locals/${localB}/member/announcements`;
    assert.equal((await fetch(wrongLocalPath, { headers: auth(memberOneToken) })).status, 403);
    assert.equal((await fetch(`${memberAPath}/${announcementB}`, { headers: auth(memberOneToken) })).status, 404);

    const ackNotRequired = await fetch(`${memberAPath}/${noAcknowledgementAnnouncement}/acknowledge`, {
      method: "POST",
      headers: auth(memberOneToken),
    });
    assert.equal(ackNotRequired.status, 409);

    const counts = await testPool.query(
      `SELECT count(*)::int AS recipient_count,
         count(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledged_count
       FROM announcement_recipients
       WHERE local_id = $1 AND announcement_id = $2`,
      [localA, announcementA],
    );
    assert.deepEqual(counts.rows[0], { recipient_count: 1, acknowledged_count: 1 });
    assert.notEqual(memberTwoId, memberOneId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await testPool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
});
