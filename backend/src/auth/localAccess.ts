import type { Pool } from "pg";

export type LocalRole = "leader" | "member";

export async function userHasLocalRole(
  database: Pick<Pool, "query">,
  userId: string,
  localId: string,
  role: LocalRole,
): Promise<boolean> {
  const membershipTable = role === "leader" ? "local_leaders" : "local_members";
  const result = await database.query(
    `SELECT 1 FROM ${membershipTable} WHERE local_id = $1 AND user_id = $2`,
    [localId, userId],
  );
  return result.rowCount === 1;
}
