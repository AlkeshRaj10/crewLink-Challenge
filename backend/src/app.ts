import express from "express";
import { createMemberAnnouncementRouter } from "./announcements/memberRoutes.js";
import { createAnnouncementRouter } from "./announcements/routes.js";
import { authRouter } from "./auth/routes.js";
import { pool } from "./db/pool.js";

export const app = express();

const allowedOrigins = new Set(
  (process.env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

app.use((request, response, next) => {
  const origin = request.header("origin");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key");
  }
  if (request.method === "OPTIONS") {
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).end();
      return;
    }
    response.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: "32kb" }));

app.use("/auth", authRouter);
app.use("/locals/:localId/announcements", createAnnouncementRouter(pool));
app.use("/locals/:localId/member/announcements", createMemberAnnouncementRouter(pool));

app.get("/health", async (_request, response, next) => {
  try {
    await pool.query("SELECT 1");
    response.status(200).json({ status: "ok" });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (typeof error === "object" && error !== null && "type" in error) {
    const type = (error as { type?: string }).type;
    if (type === "entity.parse.failed") {
      response.status(400).json({ error: "Malformed JSON request body" });
      return;
    }
    if (type === "entity.too.large") {
      response.status(413).json({ error: "Request body is too large" });
      return;
    }
  }

  console.error("Unhandled request error:", error);
  response.status(500).json({ error: "Internal server error" });
});
