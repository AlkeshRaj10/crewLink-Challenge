import type { NextFunction, Response } from "express";
import type { Pool } from "pg";
import { pool } from "../db/pool.js";
import { userHasLocalRole, type LocalRole } from "../auth/localAccess.js";
import type { AuthenticatedRequest } from "../auth/request.js";

export function createRequireLocalRole(database: Pick<Pool, "query">, role: LocalRole) {
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
      if (!await userHasLocalRole(database, request.userId, localId, role)) {
        response.status(403).json({ error: "Not authorized for this local" });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireLocalRole(role: LocalRole) {
  return createRequireLocalRole(pool, role);
}
