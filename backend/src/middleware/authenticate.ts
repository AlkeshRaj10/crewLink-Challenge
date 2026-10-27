import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../auth/request.js";
import { verifyAccessToken } from "../auth/token.js";

export function authenticate(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): void {
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

  request.userId = claims.sub;
  next();
}
