import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { test } from "node:test";
import { authenticateCredentials } from "../auth/accounts.js";
import { seedDatabase } from "./seed.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("seed can be rerun without duplicating local data", {
  skip: databaseUrl ? false : "Set TEST_DATABASE_URL to run PostgreSQL seed tests",
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `crewlink_seed_test_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const testPool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });

  try {
    for (const migrationName of ["001_initial_schema.sql", "002_user_account_status.sql"]) {
      const migrationPath = fileURLToPath(new URL(`./migrations/${migrationName}`, import.meta.url));
      await testPool.query(await readFile(migrationPath, "utf8"));
    }

    const firstSeed = await seedDatabase(testPool);
    const firstCounts = await testPool.query(`
      SELECT
        (SELECT count(*)::int FROM locals) AS locals,
        (SELECT count(*)::int FROM classifications) AS classifications,
        (SELECT count(*)::int FROM local_leaders) AS leaders,
        (SELECT count(*)::int FROM local_members) AS members,
        (SELECT count(*)::int FROM announcements WHERE status = 'sent') AS sent_announcements,
        (SELECT count(*)::int FROM announcement_recipients) AS recipients
    `);
    const afterFirstSeed = firstCounts.rows[0];

    const secondSeed = await seedDatabase(testPool);
    const secondCounts = await testPool.query(`
      SELECT
        (SELECT count(*)::int FROM locals) AS locals,
        (SELECT count(*)::int FROM classifications) AS classifications,
        (SELECT count(*)::int FROM local_leaders) AS leaders,
        (SELECT count(*)::int FROM local_members) AS members,
        (SELECT count(*)::int FROM announcements WHERE status = 'sent') AS sent_announcements,
        (SELECT count(*)::int FROM announcement_recipients) AS recipients
    `);
    const afterSecondSeed = secondCounts.rows[0];

    assert.deepEqual(afterSecondSeed, afterFirstSeed);
    assert.deepEqual(firstSeed, secondSeed);
    assert.deepEqual(afterSecondSeed, {
      locals: 2,
      classifications: 8,
      leaders: 2,
      members: 2_200,
      sent_announcements: 1,
      recipients: 2_000,
    });

    const perLocalCounts = await testPool.query(`
      SELECT l.name, count(lm.id)::int AS member_count, count(DISTINCT lm.classification_id)::int AS classification_count
      FROM locals l
      JOIN local_members lm ON lm.local_id = l.id
      GROUP BY l.id, l.name
      ORDER BY l.name
    `);
    assert.deepEqual(perLocalCounts.rows, [
      { name: "Local 27", member_count: 2_000, classification_count: 4 },
      { name: "Local 99", member_count: 200, classification_count: 4 },
    ]);

    const largeLocalAccounts = firstSeed.locals[0];
    const smallLocalAccounts = firstSeed.locals[1];
    assert.equal(
      await authenticateCredentials(testPool, largeLocalAccounts.leader.email, largeLocalAccounts.leader.password),
      (await testPool.query("SELECT user_id FROM local_leaders WHERE local_id = $1", [largeLocalAccounts.id])).rows[0].user_id,
    );
    assert.equal(
      await authenticateCredentials(testPool, smallLocalAccounts.member.email, smallLocalAccounts.member.password),
      (await testPool.query("SELECT user_id FROM local_members WHERE id = $1", [smallLocalAccounts.member.id])).rows[0].user_id,
    );

    const invalidLocalMemberships = await testPool.query(`
      SELECT count(*)::int AS count
      FROM local_members lm
      JOIN classifications c ON c.id = lm.classification_id
      WHERE lm.local_id <> c.local_id
    `);
    assert.equal(invalidLocalMemberships.rows[0].count, 0);

    console.log("Seed test accounts:", JSON.stringify({
      locals: firstSeed.locals,
      largeLocalAnnouncement: firstSeed.largeLocalAnnouncement,
      smallLocalMemberId: smallLocalAccounts.member.id,
    }));
  } finally {
    await testPool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
});
