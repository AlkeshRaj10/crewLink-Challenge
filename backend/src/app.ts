import express from "express";
import { authRouter } from "./auth/routes.js";
import { pool } from "./db/pool.js";

export const app = express();

app.use(express.json({ limit: "32kb" }));

app.use("/auth", authRouter);

app.get("/health", async (_request, response, next) => {
  try {
    await pool.query("SELECT 1");
    response.status(200).json({ status: "ok" });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error:", error);
  response.status(500).json({ error: "Internal server error" });
});
