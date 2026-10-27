import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { test } from "node:test";
import { createAccessToken } from "../auth/token.js";
import { createAnnouncementRouter } from "./routes.js";

process.env.JWT_SECRET ??= "announcement-tests-only-secret-at-least-32-bytes";
const databaseUrl = process.env.TEST_DATABASE_URL;

test("announcement draft and send endpoints enforce local scope and transactional idempotency", {
  skip: databaseUrl ? false : "Set TEST_DATABASE_URL to run PostgreSQL announcement tests",
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `crewlink_announcement_test_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const testPool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  const app = express();
  app.use(express.json());
  app.use("/locals/:localId/announcements", createAnnouncementRouter(testPool));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error("Announcement test app error:", error);
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

    const localA = (await testPool.query("INSERT INTO locals (name) VALUES ('API Local A') RETURNING id")).rows[0].id as string;
    const localB = (await testPool.query("INSERT INTO locals (name) VALUES ('API Local B') RETURNING id")).rows[0].id as string;
    const users = (await testPool.query(
      `INSERT INTO users (email, password_hash) VALUES
        ('leader-a@example.test', 'hash'), ('leader-b@example.test', 'hash'),
        ('member-one@example.test', 'hash'), ('member-two@example.test', 'hash'),
        ('other-member@example.test', 'hash')
       RETURNING id`,
    )).rows.map((row) => row.id as string);
    const [leaderA, leaderB, memberOne, memberTwo, memberOtherLocal] = users;
    await testPool.query(
      `INSERT INTO local_leaders (local_id, user_id) VALUES ($1, $2), ($3, $4)`,
      [localA, leaderA, localB, leaderB],
    );

    const classificationsA = (await testPool.query(
      `INSERT INTO classifications (local_id, name) VALUES
       ($1, 'Wireman'), ($1, 'Apprentice'), ($2, 'Mechanic') RETURNING local_id, id`,
      [localA, localB],
    )).rows;
    const wiremanClass = classificationsA.find((item) => item.local_id === localA)?.id as string;
    const apprenticeClass = classificationsA
      .filter((item) => item.local_id === localA)
      .map((item) => item.id as string)[1];
    const otherClass = classificationsA.find((item) => item.local_id === localB)?.id as string;

    const members = [
      [localA, memberOne, "Member One", wiremanClass],
      [localA, memberTwo, "Member Two", apprenticeClass],
      [localB, memberOtherLocal, "Other Local Member", otherClass],
    ];
    for (const [memberLocalId, userId, name, classificationId] of members) {
      await testPool.query(
        `INSERT INTO local_members (local_id, user_id, full_name, email, classification_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [memberLocalId, userId, name, `${name.toLowerCase().replaceAll(" ", ".")}@example.test`, classificationId],
      );
    }

    const leaderToken = createAccessToken(leaderA);
    const otherLeaderToken = createAccessToken(leaderB);
    const headers = { authorization: `Bearer ${leaderToken}`, "content-type": "application/json" };
    const createDraft = async (token = leaderToken) => fetch(`${baseUrl}/locals/${localA}/announcements`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Contract meeting",
        body: "Join us at the union hall.",
        needsAck: true,
        pushPreview: "Contract meeting at the union hall.",
      }),
    });

    const unauthorizedCreate = await createDraft(otherLeaderToken);
    assert.equal(unauthorizedCreate.status, 403);
    const invalidDraft = await fetch(`${baseUrl}/locals/${localA}/announcements`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: " ", body: "" }),
    });
    assert.equal(invalidDraft.status, 400);

    const draftResponse = await createDraft();
    assert.equal(draftResponse.status, 201);
    const { announcement } = await draftResponse.json() as { announcement: { id: string; status: string } };
    assert.equal(announcement.status, "draft");

    const otherLocalDraft = await fetch(`${baseUrl}/locals/${localB}/announcements`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Should not be created", body: "Wrong tenant." }),
    });
    assert.equal(otherLocalDraft.status, 403);

    const send = async (idempotencyKey: string, classificationId: string | null, token = leaderToken, targetId = announcement.id) =>
      fetch(`${baseUrl}/locals/${localA}/announcements/${targetId}/send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ classificationId }),
      });

    const crossLocalClassification = await send("cross-local-class", otherClass);
    assert.equal(crossLocalClassification.status, 400);

    const [concurrentFirst, concurrentSecond] = await Promise.all([
      send("same-key", wiremanClass),
      send("same-key", wiremanClass.toUpperCase()),
    ]);
    assert.equal(concurrentFirst.status, 202);
    assert.equal(concurrentSecond.status, 202);
    const firstResult = await concurrentFirst.json() as {
      announcementId: string;
      status: string;
      recipientCount: number;
      replayed: boolean;
    };
    const secondResult = await concurrentSecond.json() as typeof firstResult;
    assert.equal(firstResult.announcementId, announcement.id);
    assert.equal(firstResult.status, "sending");
    assert.equal(firstResult.recipientCount, 1);
    assert.equal(firstResult.replayed || secondResult.replayed, true);

    const replay = await send("same-key", wiremanClass);
    assert.equal(replay.status, 202);
    assert.equal((await replay.json() as typeof firstResult).replayed, true);

    const conflictingKey = await send("same-key", apprenticeClass);
    assert.equal(conflictingKey.status, 409);

    const differentKey = await send("new-key", wiremanClass);
    assert.equal(differentKey.status, 409);

    const inaccessibleAnnouncement = await send("other-leader", wiremanClass, otherLeaderToken);
    assert.equal(inaccessibleAnnouncement.status, 403);
    const nonexistentLocalAnnouncement = await send("foreign-announcement", null, leaderToken, randomUUID());
    assert.equal(nonexistentLocalAnnouncement.status, 404);

    const counts = await testPool.query(
      `SELECT
         (SELECT count(*)::int FROM announcement_recipients WHERE announcement_id = $1) AS recipients,
         (SELECT count(*)::int FROM outbox_jobs WHERE recipient_id IN
           (SELECT id FROM announcement_recipients WHERE announcement_id = $1)) AS jobs,
         (SELECT count(*)::int FROM send_requests WHERE announcement_id = $1) AS send_requests,
         (SELECT status FROM announcements WHERE id = $1) AS status`,
      [announcement.id],
    );
    assert.deepEqual(counts.rows[0], {
      recipients: 1,
      jobs: 1,
      send_requests: 1,
      status: "sending",
    });

    const concurrentDraft = await createDraft();
    const concurrentDraftData = await concurrentDraft.json() as { announcement: { id: string } };
    const simultaneousSends = await Promise.all([
      send("racer-key-one", null, leaderToken, concurrentDraftData.announcement.id),
      send("racer-key-two", null, leaderToken, concurrentDraftData.announcement.id),
    ]);
    assert.deepEqual(simultaneousSends.map((result) => result.status).sort(), [202, 409]);
    const raceCounts = await testPool.query(
      `SELECT
         (SELECT count(*)::int FROM announcement_recipients WHERE announcement_id = $1) AS recipients,
         (SELECT count(*)::int FROM outbox_jobs WHERE recipient_id IN
           (SELECT id FROM announcement_recipients WHERE announcement_id = $1)) AS jobs,
         (SELECT count(*)::int FROM send_requests WHERE announcement_id = $1) AS send_requests`,
      [concurrentDraftData.announcement.id],
    );
    assert.deepEqual(raceCounts.rows[0], { recipients: 2, jobs: 2, send_requests: 1 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await testPool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
});
