import { Router } from "express";
import { hashPassword, verifyPassword } from "./password.js";
import { createAccessToken, accessTokenTtlSeconds } from "./token.js";
import { pool } from "../db/pool.js";
import { authenticate } from "../middleware/authenticate.js";
import type { AuthenticatedRequest } from "./request.js";

const dummyPasswordHash = hashPassword("nonexistent-account-password");
const router = Router();

router.post("/login", async (request, response, next) => {
  const { email, password } = request.body ?? {};
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    email.length > 320 ||
    password.length > 1024
  ) {
    response.status(400).json({ error: "Email and password are required" });
    return;
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const result = await pool.query(
      "SELECT id, password_hash FROM users WHERE lower(email) = $1",
      [normalizedEmail],
    );
    const user = result.rows[0] as { id: string; password_hash: string } | undefined;
    const matches = user
      ? verifyPassword(password, user.password_hash)
      : verifyPassword(password, dummyPasswordHash);

    if (!user || !matches) {
      response.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const accessToken = createAccessToken(user.id);
    response.status(200).json({ accessToken, tokenType: "Bearer", expiresIn: accessTokenTtlSeconds });
  } catch (error) {
    next(error);
  }
});

router.get("/me", authenticate, async (request, response, next) => {
  const userId = (request as AuthenticatedRequest).userId;
  try {
    const result = await pool.query(
      `SELECT l.id AS local_id, l.name AS local_name, 'leader' AS role
       FROM local_leaders ll
       JOIN locals l ON l.id = ll.local_id
       WHERE ll.user_id = $1
       UNION ALL
       SELECT l.id AS local_id, l.name AS local_name, 'member' AS role
       FROM local_members lm
       JOIN locals l ON l.id = lm.local_id
       WHERE lm.user_id = $1
       ORDER BY local_name, role`,
      [userId],
    );
    response.status(200).json({ userId, localAccess: result.rows });
  } catch (error) {
    next(error);
  }
});

export const authRouter = router;
