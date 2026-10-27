import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const migrationsDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));

async function migrate(): Promise<void> {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(741203, 1)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("COMMIT");

    for (const migrationName of migrationNames) {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(741203, 1)");
      const existing = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [migrationName],
      );

      if (existing.rowCount === 0) {
        const migrationPath = fileURLToPath(new URL(`./migrations/${migrationName}`, import.meta.url));
        const migrationSql = await readFile(migrationPath, "utf8");
        await client.query(migrationSql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migrationName]);
        console.log(`Applied migration ${migrationName}`);
      } else {
        console.log(`Migration ${migrationName} already applied`);
      }

      await client.query("COMMIT");
    }

    if (migrationNames.length === 0) {
      console.log("No database migrations found");
    }
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Could not roll back failed migration transaction:", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

try {
  await migrate();
} catch (error) {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
