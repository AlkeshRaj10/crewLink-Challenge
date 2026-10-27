import "dotenv/config";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set");
}

export const pool = new Pool({ connectionString });

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});
