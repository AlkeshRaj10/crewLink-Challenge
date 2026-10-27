import { createHash } from "node:crypto";
import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import type { AuthenticatedRequest } from "../auth/request.js";
import { createAuthenticator } from "../middleware/authenticate.js";
import { createRequireLocalRole } from "../middleware/requireLocalRole.js";
import {
  AiDraftError,
  generateAnnouncementDraft,
  type AiDraftGenerator,
} from "./aiDraft.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CreateAnnouncementBody {
  title: string;
  body: string;
  needsAck?: boolean;
  pushPreview?: string | null;
}

interface SendAnnouncementBody {
  classificationId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendRequestHash(announcementId: string, classificationId: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({
      announcementId: announcementId.toLowerCase(),
      classificationId: classificationId?.toLowerCase() ?? null,
    }))
    .digest("hex");
}

export function createAnnouncementRouter(
  database: Pool,
  generateDraft: AiDraftGenerator = generateAnnouncementDraft,
): Router {
  const router = Router({ mergeParams: true });
  const authenticate = createAuthenticator(database);
  const requireLeader = createRequireLocalRole(database, "leader");

  router.get("/classifications", authenticate, requireLeader, async (request, response, next) => {
    try {
      const result = await database.query(
        `SELECT id, name
         FROM classifications
         WHERE local_id = $1
         ORDER BY name`,
        [request.params.localId],
      );
      response.status(200).json({ classifications: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/", authenticate, requireLeader, async (request, response, next) => {
    try {
      const result = await database.query(
        `SELECT announcement.id, announcement.local_id, announcement.title, announcement.body,
                announcement.push_preview, announcement.needs_ack, announcement.status,
                announcement.approved_at, announcement.sent_at, announcement.created_at,
                (SELECT count(*)::int
                 FROM announcement_recipients recipient
                 WHERE recipient.local_id = announcement.local_id
                   AND recipient.announcement_id = announcement.id) AS recipient_count,
                (SELECT count(*)::int
                 FROM announcement_recipients recipient
                 WHERE recipient.local_id = announcement.local_id
                   AND recipient.announcement_id = announcement.id
                   AND recipient.push_status = 'delivered') AS sent_count,
                (SELECT count(*)::int
                 FROM announcement_recipients recipient
                 WHERE recipient.local_id = announcement.local_id
                   AND recipient.announcement_id = announcement.id
                   AND recipient.read_at IS NOT NULL) AS read_count,
                (SELECT count(*)::int
                 FROM announcement_recipients recipient
                 WHERE recipient.local_id = announcement.local_id
                   AND recipient.announcement_id = announcement.id
                   AND recipient.acknowledged_at IS NOT NULL) AS acknowledged_count
         FROM announcements announcement
         WHERE announcement.local_id = $1
         ORDER BY announcement.created_at DESC
         LIMIT 100`,
        [request.params.localId],
      );
      response.status(200).json({ announcements: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:announcementId", authenticate, requireLeader, async (request, response, next) => {
    const announcementId = request.params.announcementId;
    if (typeof announcementId !== "string" || !uuidPattern.test(announcementId)) {
      response.status(400).json({ error: "Invalid announcement ID" });
      return;
    }
    try {
      const result = await database.query(
        `SELECT id, local_id, title, body, push_preview, needs_ack, status, approved_at, sent_at, created_at
         FROM announcements
         WHERE local_id = $1 AND id = $2`,
        [request.params.localId, announcementId],
      );
      if (result.rowCount !== 1) {
        response.status(404).json({ error: "Announcement not found in this local" });
        return;
      }
      response.status(200).json({ announcement: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.put("/:announcementId", authenticate, requireLeader, async (request, response, next) => {
    const announcementId = request.params.announcementId;
    const userId = (request as AuthenticatedRequest).userId!;
    if (typeof announcementId !== "string" || !uuidPattern.test(announcementId)) {
      response.status(400).json({ error: "Invalid announcement ID" });
      return;
    }
    if (!isRecord(request.body)) {
      response.status(400).json({ error: "Request body must be a JSON object" });
      return;
    }

    const { title, body, needsAck = false, pushPreview = null } = request.body as Partial<CreateAnnouncementBody>;
    const allowedKeys = new Set(["title", "body", "needsAck", "pushPreview"]);
    if (
      Object.keys(request.body).some((key) => !allowedKeys.has(key)) ||
      typeof title !== "string" ||
      title.trim().length === 0 ||
      title.trim().length > 200 ||
      typeof body !== "string" ||
      body.trim().length === 0 ||
      body.trim().length > 20_000 ||
      typeof needsAck !== "boolean" ||
      (pushPreview !== null &&
        (typeof pushPreview !== "string" || pushPreview.trim().length > 120))
    ) {
      response.status(400).json({
        error: "Provide a title (1-200 characters), body (1-20000 characters), optional boolean needsAck, and pushPreview (up to 120 characters)",
      });
      return;
    }

    try {
      const result = await database.query(
        `UPDATE announcements
         SET title = $3, body = $4, needs_ack = $5, push_preview = $6
         WHERE local_id = $1 AND id = $2 AND author_user_id = $7 AND status = 'draft'
         RETURNING id, local_id, title, body, push_preview, needs_ack, status, approved_at, sent_at, created_at`,
        [
          request.params.localId,
          announcementId,
          title.trim(),
          body.trim(),
          needsAck,
          typeof pushPreview === "string" ? pushPreview.trim() : null,
          userId,
        ],
      );
      if (result.rowCount !== 1) {
        response.status(409).json({ error: "Only your own unsent drafts can be edited" });
        return;
      }
      response.status(200).json({ announcement: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/ai-draft",
    authenticate,
    requireLeader,
    async (request, response, next) => {
      if (
        !isRecord(request.body) ||
        Object.keys(request.body).some((key) => key !== "notes") ||
        typeof request.body.notes !== "string" ||
        request.body.notes.trim().length === 0 ||
        request.body.notes.trim().length > 10_000
      ) {
        response.status(400).json({ error: "Provide leadership notes containing 1-10000 characters" });
        return;
      }

      const localId = request.params.localId as string;
      const userId = (request as AuthenticatedRequest).userId!;
      try {
        const suggestion = await generateDraft(request.body.notes.trim());
        const result = await database.query(
          `INSERT INTO announcements
             (local_id, author_user_id, title, body, push_preview, status)
           VALUES ($1, $2, $3, $4, $5, 'draft')
           RETURNING id, local_id, title, body, push_preview, needs_ack, status, approved_by_user_id, approved_at, created_at`,
          [localId, userId, suggestion.title, suggestion.body, suggestion.pushPreview],
        );
        response.status(201).json({ announcement: result.rows[0] });
      } catch (error) {
        if (error instanceof AiDraftError) {
          if (error.kind === "unavailable") {
            response.status(503).json({ error: "AI drafting is not configured; create a draft manually" });
            return;
          }
          console.error("AI announcement draft generation failed:", error.kind);
          response.status(502).json({ error: "AI could not produce a valid draft; create a draft manually" });
          return;
        }
        next(error);
      }
    },
  );

  router.post(
    "/",
    authenticate,
    requireLeader,
    async (request, response, next) => {
      if (!isRecord(request.body)) {
        response.status(400).json({ error: "Request body must be a JSON object" });
        return;
      }

      const { title, body, needsAck = false, pushPreview = null } = request.body as Partial<CreateAnnouncementBody>;
      const allowedKeys = new Set(["title", "body", "needsAck", "pushPreview"]);
      if (
        Object.keys(request.body).some((key) => !allowedKeys.has(key)) ||
        typeof title !== "string" ||
        title.trim().length === 0 ||
        title.trim().length > 200 ||
        typeof body !== "string" ||
        body.trim().length === 0 ||
        body.trim().length > 20_000 ||
        typeof needsAck !== "boolean" ||
        (pushPreview !== null &&
          (typeof pushPreview !== "string" || pushPreview.length > 120))
      ) {
        response.status(400).json({
          error: "Provide a title (1-200 characters), body (1-20000 characters), optional boolean needsAck, and pushPreview (up to 120 characters)",
        });
        return;
      }

      const localId = request.params.localId as string;
      const userId = (request as AuthenticatedRequest).userId!;
      try {
        const result = await database.query(
          `INSERT INTO announcements (local_id, author_user_id, title, body, needs_ack, push_preview)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, local_id, title, body, needs_ack, push_preview, status, created_at`,
          [localId, userId, title.trim(), body.trim(), needsAck, pushPreview],
        );
        response.status(201).json({ announcement: result.rows[0] });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:announcementId/send",
    authenticate,
    requireLeader,
    async (request, response, next) => {
      const localId = request.params.localId as string;
      const announcementId = request.params.announcementId;
      const userId = (request as AuthenticatedRequest).userId!;
      const idempotencyKey = request.header("idempotency-key");

      if (typeof announcementId !== "string" || !uuidPattern.test(announcementId)) {
        response.status(400).json({ error: "Invalid announcement ID" });
        return;
      }
      if (!idempotencyKey || idempotencyKey.trim().length === 0 || idempotencyKey.length > 200) {
        response.status(400).json({ error: "A non-empty Idempotency-Key header of at most 200 characters is required" });
        return;
      }
      if (request.body !== undefined && !isRecord(request.body)) {
        response.status(400).json({ error: "Request body must be a JSON object" });
        return;
      }

      const body = (request.body ?? {}) as SendAnnouncementBody;
      if (Object.keys(body).some((key) => key !== "classificationId")) {
        response.status(400).json({ error: "Unsupported send option" });
        return;
      }
      const classificationId = body.classificationId ?? null;
      if (classificationId !== null && (typeof classificationId !== "string" || !uuidPattern.test(classificationId))) {
        response.status(400).json({ error: "classificationId must be a valid UUID or null" });
        return;
      }

      const normalizedKey = idempotencyKey.trim();
      const requestHash = sendRequestHash(announcementId, classificationId);
      let client: PoolClient | undefined;

      try {
        client = await database.connect();
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`${localId}:${userId}:${normalizedKey}`],
        );

        const previousRequest = await client.query(
          `SELECT sr.request_hash, a.id, a.status,
             (SELECT count(*)::int FROM announcement_recipients ar
              WHERE ar.local_id = sr.local_id AND ar.announcement_id = sr.announcement_id) AS recipient_count
           FROM send_requests sr
           JOIN announcements a ON a.local_id = sr.local_id AND a.id = sr.announcement_id
           WHERE sr.local_id = $1 AND sr.leader_user_id = $2 AND sr.idempotency_key = $3`,
          [localId, userId, normalizedKey],
        );

        if (previousRequest.rowCount === 1) {
          const previous = previousRequest.rows[0] as {
            request_hash: string;
            id: string;
            status: string;
            recipient_count: number;
          };
          if (previous.request_hash !== requestHash) {
            await client.query("ROLLBACK");
            response.status(409).json({ error: "Idempotency key was already used with different send content" });
            return;
          }

          await client.query("COMMIT");
          response.status(202).json({
            announcementId: previous.id,
            status: previous.status,
            recipientCount: previous.recipient_count,
            replayed: true,
          });
          return;
        }

        const announcementResult = await client.query(
          `SELECT id, status, approved_at
           FROM announcements
           WHERE local_id = $1 AND id = $2
           FOR UPDATE`,
          [localId, announcementId],
        );
        if (announcementResult.rowCount !== 1) {
          await client.query("ROLLBACK");
          response.status(404).json({ error: "Announcement not found in this local" });
          return;
        }

        const announcement = announcementResult.rows[0] as {
          id: string;
          status: string;
          approved_at: Date | null;
        };
        if (!["draft", "approved"].includes(announcement.status)) {
          await client.query("ROLLBACK");
          response.status(409).json({ error: "Announcement has already been sent or is not sendable" });
          return;
        }

        if (classificationId !== null) {
          const classification = await client.query(
            "SELECT 1 FROM classifications WHERE local_id = $1 AND id = $2",
            [localId, classificationId],
          );
          if (classification.rowCount !== 1) {
            await client.query("ROLLBACK");
            response.status(400).json({ error: "Classification does not belong to this local" });
            return;
          }
        }

        await client.query(
          `INSERT INTO send_requests
             (local_id, leader_user_id, announcement_id, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [localId, userId, announcementId, normalizedKey, requestHash],
        );

        const recipients = await client.query(
          `INSERT INTO announcement_recipients (local_id, announcement_id, member_id)
           SELECT lm.local_id, $2, lm.id
           FROM local_members lm
           WHERE lm.local_id = $1
             AND lm.status = 'active'
             AND ($3::uuid IS NULL OR lm.classification_id = $3)
           RETURNING id`,
          [localId, announcementId, classificationId],
        );
        if (recipients.rowCount === 0) {
          await client.query("ROLLBACK");
          response.status(422).json({ error: "No active members match this audience" });
          return;
        }

        await client.query(
          `INSERT INTO outbox_jobs (local_id, recipient_id)
           SELECT local_id, id
           FROM announcement_recipients
           WHERE local_id = $1 AND announcement_id = $2`,
          [localId, announcementId],
        );

        const timestamp = new Date();
        await client.query(
          `UPDATE announcements
           SET status = 'sending',
               approved_by_user_id = COALESCE(approved_by_user_id, $3),
               approved_at = COALESCE(approved_at, $4)
           WHERE local_id = $1 AND id = $2`,
          [localId, announcementId, userId, timestamp],
        );

        await client.query("COMMIT");
        response.status(202).json({
          announcementId,
          status: "sending",
          recipientCount: recipients.rowCount,
          replayed: false,
        });
      } catch (error) {
        if (client) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            console.error("Could not roll back announcement send:", rollbackError);
          }
        }
        next(error);
      } finally {
        client?.release();
      }
    },
  );

  return router;
}
