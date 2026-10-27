import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const migrationName = "001_initial_schema";
const migrationPath = fileURLToPath(new URL("./migrations/001_initial_schema.sql", import.meta.url));

async function migrate(): Promise<void> {
  const migrationSql = await readFile(migrationPath, "utf8");
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

    const existing = await client.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [migrationName],
    );

    if (existing.rowCount === 0) {
      await client.query(migrationSql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migrationName]);
      console.log(`Applied migration ${migrationName}`);
    } else {
      console.log(`Migration ${migrationName} already applied`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
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
