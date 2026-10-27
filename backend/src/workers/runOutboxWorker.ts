import { pool } from "../db/pool.js";
import { MockPushProvider, runOutboxWorker } from "./outboxWorker.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runOutboxWorker(pool, new MockPushProvider(pool), controller.signal);
} catch (error) {
  console.error("Outbox worker stopped after an error:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
