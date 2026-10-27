import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import type { AuthenticatedRequest } from "../auth/request.js";
import { createAuthenticator } from "../middleware/authenticate.js";
import { createRequireLocalRole } from "../middleware/requireLocalRole.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createMemberAnnouncementRouter(database: Pool): Router {
  const router = Router({ mergeParams: true });
  const authenticate = createAuthenticator(database);
  const requireMember = createRequireLocalRole(database, "member");

  router.get("/", authenticate, requireMember, async (request, response, next) => {
    const localId = request.params.localId as string;
    const userId = (request as AuthenticatedRequest).userId!;
    try {
      const result = await database.query(
        `SELECT a.id, a.local_id, a.title, a.body, a.push_preview, a.needs_ack,
           a.sent_at, ar.read_at, ar.acknowledged_at, ar.rsvp
         FROM announcement_recipients ar
         JOIN announcements a
           ON a.local_id = ar.local_id AND a.id = ar.announcement_id
         JOIN local_members lm
           ON lm.local_id = ar.local_id AND lm.id = ar.member_id
         WHERE ar.local_id = $1 AND lm.user_id = $2 AND a.status = 'sent'
         ORDER BY a.sent_at DESC, a.id`,
        [localId, userId],
      );
      response.status(200).json({ announcements: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:announcementId", authenticate, requireMember, async (request, response, next) => {
    const localId = request.params.localId as string;
    const announcementId = request.params.announcementId;
    const userId = (request as AuthenticatedRequest).userId!;
    if (typeof announcementId !== "string" || !uuidPattern.test(announcementId)) {
      response.status(400).json({ error: "Invalid announcement ID" });
      return;
    }

    try {
      const result = await database.query(
        `UPDATE announcement_recipients ar
         SET read_at = COALESCE(ar.read_at, now())
         FROM announcements a, local_members lm
         WHERE ar.local_id = $1 AND ar.announcement_id = $2
           AND a.local_id = ar.local_id AND a.id = ar.announcement_id
           AND a.status = 'sent'
           AND lm.local_id = ar.local_id AND lm.id = ar.member_id AND lm.user_id = $3
         RETURNING a.id, a.local_id, a.title, a.body, a.push_preview, a.needs_ack,
           a.sent_at, ar.read_at, ar.acknowledged_at, ar.rsvp`,
        [localId, announcementId, userId],
      );
      if (result.rowCount !== 1) {
        response.status(404).json({ error: "Announcement not found for this member" });
        return;
      }

      response.status(200).json({ announcement: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:announcementId/acknowledge", authenticate, requireMember, async (request, response, next) => {
    const localId = request.params.localId as string;
    const announcementId = request.params.announcementId;
    const userId = (request as AuthenticatedRequest).userId!;
    if (typeof announcementId !== "string" || !uuidPattern.test(announcementId)) {
      response.status(400).json({ error: "Invalid announcement ID" });
      return;
    }

    let client: PoolClient | undefined;
    try {
      client = await database.connect();
      await client.query("BEGIN");
      const recipient = await client.query(
        `SELECT ar.id, a.needs_ack
         FROM announcement_recipients ar
         JOIN announcements a
           ON a.local_id = ar.local_id AND a.id = ar.announcement_id
         JOIN local_members lm
           ON lm.local_id = ar.local_id AND lm.id = ar.member_id
         WHERE ar.local_id = $1 AND ar.announcement_id = $2
           AND lm.user_id = $3 AND a.status = 'sent'
         FOR UPDATE OF ar`,
        [localId, announcementId, userId],
      );
      if (recipient.rowCount !== 1) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "Announcement not found for this member" });
        return;
      }

      if (!recipient.rows[0].needs_ack) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "Acknowledgement is not required for this announcement" });
        return;
      }

      const updated = await client.query(
        `UPDATE announcement_recipients
         SET read_at = COALESCE(read_at, now()),
             acknowledged_at = COALESCE(acknowledged_at, now())
         WHERE id = $1
         RETURNING announcement_id, read_at, acknowledged_at`,
        [recipient.rows[0].id],
      );
      await client.query("COMMIT");
      response.status(200).json({
        announcementId: updated.rows[0].announcement_id,
        readAt: updated.rows[0].read_at,
        acknowledgedAt: updated.rows[0].acknowledged_at,
      });
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Could not roll back member acknowledgement:", rollbackError);
        }
      }
      next(error);
    } finally {
      client?.release();
    }
  });

  return router;
}
