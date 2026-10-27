import { createHash } from "node:crypto";
import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import type { AuthenticatedRequest } from "../auth/request.js";
import { createAuthenticator } from "../middleware/authenticate.js";
import { createRequireLocalRole } from "../middleware/requireLocalRole.js";

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

export function createAnnouncementRouter(database: Pool): Router {
  const router = Router({ mergeParams: true });
  const authenticate = createAuthenticator(database);
  const requireLeader = createRequireLocalRole(database, "leader");

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
