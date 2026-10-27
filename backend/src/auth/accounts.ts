import type { Pool } from "pg";
import { hashPassword, verifyPassword } from "./password.js";

const dummyPasswordHash = hashPassword("nonexistent-account-password");

export async function authenticateCredentials(
  database: Pick<Pool, "query">,
  email: string,
  password: string,
): Promise<string | null> {
  const result = await database.query(
    "SELECT id, password_hash, is_active FROM users WHERE lower(email) = $1",
    [email.trim().toLowerCase()],
  );
  const user = result.rows[0] as {
    id: string;
    password_hash: string;
    is_active: boolean;
  } | undefined;
  const matches = user
    ? verifyPassword(password, user.password_hash)
    : verifyPassword(password, dummyPasswordHash);

  if (!user || !user.is_active || !matches) {
    return null;
  }

  return user.id;
}

export async function isActiveUser(
  database: Pick<Pool, "query">,
  userId: string,
): Promise<boolean> {
  const result = await database.query(
    "SELECT 1 FROM users WHERE id = $1 AND is_active = true",
    [userId],
  );
  return result.rowCount === 1;
}
