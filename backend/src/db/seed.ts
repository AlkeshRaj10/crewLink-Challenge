import "dotenv/config";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { pathToFileURL } from "node:url";
import { hashPassword } from "../auth/password.js";
import { pool } from "./pool.js";

const memberPassword = "MemberTest123!";
const locals = [
  {
    key: "local-27",
    name: "Local 27",
    slug: "local27",
    memberCount: 2_000,
    leaderPassword: "Leader27Test!",
    memberPassword: "Member27Test!",
    classifications: ["Journeyman Wireman", "Apprentice 1st Year", "Apprentice 3rd Year", "Foreperson"],
  },
  {
    key: "local-99",
    name: "Local 99",
    slug: "local99",
    memberCount: 200,
    leaderPassword: "Leader99Test!",
    memberPassword: "Member99Test!",
    classifications: ["Journeyman Transit Operator", "Apprentice Operator", "Mechanic", "Dispatcher"],
  },
] as const;

const largeLocalAnnouncementKey = "announcement-local-27-contract-meeting";
const largeLocalAnnouncementTime = "2025-01-15T17:00:00.000Z";
const memberPasswordHash = hashPassword(memberPassword);

function stableUuid(key: string): string {
  const bytes = createHash("sha256").update(`crewlink-seed-v1:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function displayName(localName: string, index: number): string {
  return index === 0 ? `${localName} Assessment Member` : `${localName} Member ${String(index + 1).padStart(4, "0")}`;
}

async function insertRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflictSql: string,
): Promise<void> {
  const batchSize = 500;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")} ${conflictSql}`,
      values,
    );
  }
}

export interface SeedSummary {
  locals: Array<{
    id: string;
    name: string;
    memberCount: number;
    leader: { email: string; password: string };
    member: { id: string; email: string; password: string };
  }>;
  largeLocalAnnouncement: { id: string; localId: string; recipientCount: number };
}

export async function seedDatabase(database: Pool): Promise<SeedSummary> {
  const client = await database.connect();

  try {
    await client.query("BEGIN");

    const localRows = locals.map((local) => [
      stableUuid(local.key),
      local.name,
    ]);
    await insertRows(
      client,
      "locals",
      ["id", "name"],
      localRows,
      "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
    );

    const classificationRows: unknown[][] = [];
    const userRows: unknown[][] = [];
    const leaderRows: unknown[][] = [];
    const memberRows: unknown[][] = [];
    const seededLocalInfo: SeedSummary["locals"] = [];

    for (const local of locals) {
      const localId = stableUuid(local.key);
      const classificationIds = local.classifications.map((name) =>
        stableUuid(`${local.key}:classification:${name}`));

      local.classifications.forEach((name, index) => {
        classificationRows.push([classificationIds[index], localId, name]);
      });

      const leaderId = stableUuid(`${local.key}:leader`);
      const assessmentMemberUserId = stableUuid(`${local.key}:assessment-member`);
      const assessmentMemberId = stableUuid(`${local.key}:assessment-member-profile`);
      const leaderEmail = `${local.slug}.leader@crewlink.test`;
      const assessmentMemberEmail = `${local.slug}.member@crewlink.test`;

      userRows.push(
        [leaderId, leaderEmail, hashPassword(local.leaderPassword), true],
        [assessmentMemberUserId, assessmentMemberEmail, hashPassword(local.memberPassword), true],
      );
      leaderRows.push([localId, leaderId]);

      for (let index = 0; index < local.memberCount; index += 1) {
        const isAssessmentMember = index === 0;
        const memberUserId = isAssessmentMember
          ? assessmentMemberUserId
          : stableUuid(`${local.key}:member-user:${index + 1}`);
        const memberId = isAssessmentMember
          ? assessmentMemberId
          : stableUuid(`${local.key}:member-profile:${index + 1}`);
        const email = isAssessmentMember
          ? assessmentMemberEmail
          : `${local.slug}.member${String(index + 1).padStart(4, "0")}@crewlink.test`;
        const classificationId = classificationIds[index % classificationIds.length];

        if (!isAssessmentMember) {
          userRows.push([memberUserId, email, memberPasswordHash, true]);
        }

        memberRows.push([
          memberId,
          localId,
          memberUserId,
          displayName(local.name, index),
          email,
          classificationId,
          "active",
        ]);
      }

      seededLocalInfo.push({
        id: localId,
        name: local.name,
        memberCount: local.memberCount,
        leader: { email: leaderEmail, password: local.leaderPassword },
        member: { id: assessmentMemberId, email: assessmentMemberEmail, password: local.memberPassword },
      });
    }

    await insertRows(
      client,
      "classifications",
      ["id", "local_id", "name"],
      classificationRows,
      `ON CONFLICT (id) DO UPDATE SET local_id = EXCLUDED.local_id, name = EXCLUDED.name`,
    );
    await insertRows(
      client,
      "users",
      ["id", "email", "password_hash", "is_active"],
      userRows,
      `ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash, is_active = EXCLUDED.is_active`,
    );
    await insertRows(
      client,
      "local_leaders",
      ["local_id", "user_id"],
      leaderRows,
      "ON CONFLICT (local_id, user_id) DO NOTHING",
    );
    await insertRows(
      client,
      "local_members",
      ["id", "local_id", "user_id", "full_name", "email", "classification_id", "status"],
      memberRows,
      `ON CONFLICT (id) DO UPDATE SET local_id = EXCLUDED.local_id,
        user_id = EXCLUDED.user_id, full_name = EXCLUDED.full_name,
        email = EXCLUDED.email, classification_id = EXCLUDED.classification_id,
        status = EXCLUDED.status`,
    );

    const largeLocal = locals[0];
    const largeLocalId = stableUuid(largeLocal.key);
    const announcementId = stableUuid(largeLocalAnnouncementKey);
    const leaderUserId = stableUuid(`${largeLocal.key}:leader`);
    await client.query(
      `INSERT INTO announcements
         (id, local_id, author_user_id, title, body, push_preview, needs_ack,
          status, approved_by_user_id, approved_at, sent_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, 'sent', $3, $7, $7, $7)
       ON CONFLICT (id) DO UPDATE SET local_id = EXCLUDED.local_id,
         author_user_id = EXCLUDED.author_user_id, title = EXCLUDED.title,
         body = EXCLUDED.body, push_preview = EXCLUDED.push_preview,
         needs_ack = EXCLUDED.needs_ack, status = EXCLUDED.status,
         approved_by_user_id = EXCLUDED.approved_by_user_id,
         approved_at = EXCLUDED.approved_at, sent_at = EXCLUDED.sent_at`,
      [
        announcementId,
        largeLocalId,
        leaderUserId,
        "Local 27 Contract Update Meeting",
        "Join us at the union hall to discuss contract negotiations and the latest contractor updates.",
        "Local 27 contract update meeting at the union hall.",
        largeLocalAnnouncementTime,
      ],
    );

    const recipientRows: unknown[][] = Array.from({ length: largeLocal.memberCount }, (_, index) => [
      stableUuid(`${largeLocal.key}:announcement-recipient:${index + 1}`),
      largeLocalId,
      announcementId,
      index === 0
        ? stableUuid(`${largeLocal.key}:assessment-member-profile`)
        : stableUuid(`${largeLocal.key}:member-profile:${index + 1}`),
      index % 4 === 0 ? "2025-01-16T08:00:00.000Z" : null,
      index % 8 === 0 ? "2025-01-16T08:05:00.000Z" : null,
    ]);
    await insertRows(
      client,
      "announcement_recipients",
      ["id", "local_id", "announcement_id", "member_id", "read_at", "acknowledged_at"],
      recipientRows,
      `ON CONFLICT (announcement_id, member_id) DO UPDATE SET
        local_id = EXCLUDED.local_id, id = EXCLUDED.id,
        read_at = EXCLUDED.read_at, acknowledged_at = EXCLUDED.acknowledged_at`,
    );
    await client.query(
      `INSERT INTO outbox_jobs (local_id, recipient_id)
       SELECT local_id, id
       FROM announcement_recipients
       WHERE local_id = $1 AND announcement_id = $2
       ON CONFLICT (local_id, recipient_id) DO NOTHING`,
      [largeLocalId, announcementId],
    );

    await client.query("COMMIT");
    return {
      locals: seededLocalInfo,
      largeLocalAnnouncement: {
        id: announcementId,
        localId: largeLocalId,
        recipientCount: largeLocal.memberCount,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const summary = await seedDatabase(pool);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error("Database seed failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
