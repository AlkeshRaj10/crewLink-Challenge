import type { NextFunction, Response } from "express";
import type { Pool } from "pg";
import { isActiveUser } from "../auth/accounts.js";
import type { AuthenticatedRequest } from "../auth/request.js";
import { verifyAccessToken } from "../auth/token.js";
import { pool } from "../db/pool.js";

export function createAuthenticator(database: Pick<Pool, "query">) {
  return async (
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authorization = request.header("authorization");
    const match = authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }

    const claims = verifyAccessToken(match[1]);
    if (!claims) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      if (!await isActiveUser(database, claims.sub)) {
        response.status(401).json({ error: "Authentication required" });
        return;
      }

      request.userId = claims.sub;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const authenticate = createAuthenticator(pool);
