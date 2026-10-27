import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { test } from "node:test";
import { createAccessToken } from "../auth/token.js";
import {
  AiDraftError,
  createAiDraftGenerator,
  createOpenAiCompatibleDraftProvider,
} from "./aiDraft.js";
import { createAnnouncementRouter } from "./routes.js";

process.env.JWT_SECRET ??= "ai-draft-tests-only-secret-at-least-32-bytes";
const databaseUrl = process.env.TEST_DATABASE_URL;

test("AI draft API persists validated suggestions as unapproved drafts and requires a leader", {
  skip: databaseUrl ? false : "Set TEST_DATABASE_URL to run PostgreSQL AI draft tests",
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `crewlink_ai_draft_test_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const database = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  let providerResult: unknown = {
    title: "Safety meeting",
    body: "Join the safety meeting on Tuesday at the union hall.",
    pushPreview: "Safety meeting Tuesday at the union hall.",
  };
  let providerFailure: AiDraftError["kind"] | null = null;
  let providerCalls = 0;
  const generateDraft = createAiDraftGenerator({
    async generate(notes) {
      providerCalls += 1;
      assert.equal(notes, "meeting tue union hall");
      if (providerFailure) {
        throw new AiDraftError(providerFailure);
      }
      return providerResult;
    },
  });
  const app = express();
  app.use(express.json());
  app.use("/locals/:localId/announcements", createAnnouncementRouter(database, generateDraft));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error("AI announcement test app error:", error);
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
      await database.query(await readFile(migrationPath, "utf8"));
    }

    const localId = (await database.query(
      "INSERT INTO locals (name) VALUES ('AI Draft Local') RETURNING id",
    )).rows[0].id as string;
    const [leaderId, memberUserId] = (await database.query(
      `INSERT INTO users (email, password_hash) VALUES
         ('ai-leader@example.test', 'hash'), ('ai-member@example.test', 'hash')
       RETURNING id`,
    )).rows.map((row) => row.id as string);
    await database.query("INSERT INTO local_leaders (local_id, user_id) VALUES ($1, $2)", [localId, leaderId]);
    const classificationId = (await database.query(
      "INSERT INTO classifications (local_id, name) VALUES ($1, 'AI test class') RETURNING id",
      [localId],
    )).rows[0].id as string;
    await database.query(
      `INSERT INTO local_members (local_id, user_id, full_name, email, classification_id)
       VALUES ($1, $2, 'AI Member', 'ai-member@example.test', $3)`,
      [localId, memberUserId, classificationId],
    );

    const leaderHeaders = {
      authorization: `Bearer ${createAccessToken(leaderId)}`,
      "content-type": "application/json",
    };
    const memberHeaders = {
      authorization: `Bearer ${createAccessToken(memberUserId)}`,
      "content-type": "application/json",
    };
    const suggestionUrl = `${baseUrl}/locals/${localId}/announcements/ai-draft`;

    const unauthorized = await fetch(suggestionUrl, {
      method: "POST",
      headers: memberHeaders,
      body: JSON.stringify({ notes: "meeting tue union hall" }),
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(providerCalls, 0);

    const invalidRequest = await fetch(suggestionUrl, {
      method: "POST",
      headers: leaderHeaders,
      body: JSON.stringify({ notes: "  " }),
    });
    assert.equal(invalidRequest.status, 400);

    const createdResponse = await fetch(suggestionUrl, {
      method: "POST",
      headers: leaderHeaders,
      body: JSON.stringify({ notes: " meeting tue union hall " }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as {
      announcement: {
        id: string;
        title: string;
        body: string;
        push_preview: string;
        status: string;
        approved_by_user_id: string | null;
        approved_at: string | null;
      };
    }).announcement;
    assert.equal(created.title, "Safety meeting");
    assert.equal(created.body, "Join the safety meeting on Tuesday at the union hall.");
    assert.equal(created.push_preview, "Safety meeting Tuesday at the union hall.");
    assert.equal(created.status, "draft");
    assert.equal(created.approved_by_user_id, null);
    assert.equal(created.approved_at, null);

    const initialState = (await database.query(
      `SELECT announcement.status, announcement.approved_at,
              (SELECT count(*)::int FROM announcement_recipients WHERE announcement_id = announcement.id) AS recipients,
              (SELECT count(*)::int FROM outbox_jobs WHERE recipient_id IN
                (SELECT id FROM announcement_recipients WHERE announcement_id = announcement.id)) AS jobs
       FROM announcements AS announcement WHERE announcement.id = $1`,
      [created.id],
    )).rows[0];
    assert.deepEqual(initialState, { status: "draft", approved_at: null, recipients: 0, jobs: 0 });

    providerResult = {
      title: "Safety meeting",
      body: "Join us Tuesday.",
      pushPreview: "x".repeat(121),
    };
    const invalidOutput = await fetch(suggestionUrl, {
      method: "POST",
      headers: leaderHeaders,
      body: JSON.stringify({ notes: "meeting tue union hall" }),
    });
    assert.equal(invalidOutput.status, 502);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM announcements")).rows[0].count, 1);

    providerResult = { title: "Missing body", pushPreview: "Invalid response" };
    const malformedOutput = await fetch(suggestionUrl, {
      method: "POST",
      headers: leaderHeaders,
      body: JSON.stringify({ notes: "meeting tue union hall" }),
    });
    assert.equal(malformedOutput.status, 502);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM announcements")).rows[0].count, 1);

    providerFailure = "unavailable";
    const unavailable = await fetch(suggestionUrl, {
      method: "POST",
      headers: leaderHeaders,
      body: JSON.stringify({ notes: "meeting tue union hall" }),
    });
    assert.equal(unavailable.status, 503);
    providerFailure = null;

    const sendResponse = await fetch(`${baseUrl}/locals/${localId}/announcements/${created.id}/send`, {
      method: "POST",
      headers: { ...leaderHeaders, "idempotency-key": "human-review-approval" },
      body: JSON.stringify({}),
    });
    assert.equal(sendResponse.status, 202);
    const approvedState = (await database.query(
      `SELECT status, approved_by_user_id, approved_at
       FROM announcements WHERE local_id = $1 AND id = $2`,
      [localId, created.id],
    )).rows[0];
    assert.equal(approvedState.status, "sending");
    assert.equal(approvedState.approved_by_user_id, leaderId);
    assert.ok(approvedState.approved_at);
    const sentAudience = (await database.query(
      `SELECT count(DISTINCT recipient.id)::int AS recipients,
              count(DISTINCT job.id)::int AS jobs
       FROM announcement_recipients AS recipient
       JOIN outbox_jobs AS job
         ON job.local_id = recipient.local_id AND job.recipient_id = recipient.id
       WHERE recipient.local_id = $1 AND recipient.announcement_id = $2`,
      [localId, created.id],
    )).rows[0];
    assert.deepEqual(sentAudience, { recipients: 1, jobs: 1 });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await database.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
});

test("AI provider handles missing credentials, malformed responses, and provider errors", async () => {
  let called = false;
  const unconfigured = createOpenAiCompatibleDraftProvider({ apiKey: "" }, async () => {
    called = true;
    return new Response();
  });
  await assert.rejects(
    unconfigured.generate("messy notes"),
    (error: unknown) => error instanceof AiDraftError && error.kind === "unavailable",
  );
  assert.equal(called, false);

  const malformed = createOpenAiCompatibleDraftProvider(
    { apiKey: "test-key" },
    async () => new Response(JSON.stringify({
      choices: [{ message: { content: "not JSON" } }],
    }), { status: 200 }),
  );
  await assert.rejects(
    malformed.generate("messy notes"),
    (error: unknown) => error instanceof AiDraftError && error.kind === "invalid_output",
  );

  const failed = createOpenAiCompatibleDraftProvider(
    { apiKey: "test-key" },
    async () => new Response("provider unavailable", { status: 503 }),
  );
  await assert.rejects(
    failed.generate("messy notes"),
    (error: unknown) => error instanceof AiDraftError && error.kind === "provider_error",
  );
});
