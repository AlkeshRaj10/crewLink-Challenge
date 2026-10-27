import "dotenv/config";
import { app } from "./app.js";
import { validateAuthConfig } from "./auth/token.js";
import { pool } from "./db/pool.js";

validateAuthConfig();

const port = Number(process.env.PORT ?? 4000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const server = app.listen(port, () => {
  console.log(`CrewLink API listening on port ${port}`);
});

const shutdown = () => {
  server.close((error) => {
    if (error) {
      console.error("Error closing HTTP server:", error);
      process.exitCode = 1;
    }

    void pool.end().catch((poolError: unknown) => {
      console.error("Error closing PostgreSQL pool:", poolError);
      process.exitCode = 1;
    });
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
