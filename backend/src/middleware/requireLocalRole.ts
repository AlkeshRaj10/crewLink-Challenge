import type { NextFunction, Response } from "express";
import { pool } from "../db/pool.js";
import type { AuthenticatedRequest } from "../auth/request.js";

export type LocalRole = "leader" | "member";

export function requireLocalRole(role: LocalRole) {
  return async (
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const localId = request.params.localId;
    if (!request.userId) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    if (typeof localId !== "string") {
      response.status(400).json({ error: "Invalid local ID" });
      return;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localId)) {
      response.status(400).json({ error: "Invalid local ID" });
      return;
    }

    try {
      const membershipTable = role === "leader" ? "local_leaders" : "local_members";
      const result = await pool.query(
        `SELECT 1 FROM ${membershipTable} WHERE local_id = $1 AND user_id = $2`,
        [localId, request.userId],
      );

      if (result.rowCount !== 1) {
        response.status(403).json({ error: "Not authorized for this local" });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
