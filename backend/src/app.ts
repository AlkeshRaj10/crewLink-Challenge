import express from "express";
import { createAnnouncementRouter } from "./announcements/routes.js";
import { authRouter } from "./auth/routes.js";
import { pool } from "./db/pool.js";

export const app = express();

app.use(express.json({ limit: "32kb" }));

app.use("/auth", authRouter);
app.use("/locals/:localId/announcements", createAnnouncementRouter(pool));

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
