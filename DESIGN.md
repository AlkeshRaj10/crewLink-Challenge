# Requirements

## Confirmed requirements
- Build a callout/announcement feature for union locals. A leader sends to one local, optionally narrowed by work classification; members need to see callouts even if they are offline when sent.
- Enforce local-level data isolation for both members and leadership, and prevent members from using leadership permissions. Union membership/contact data is sensitive.
- Retries and worker restarts must not cause the same member to receive a callout twice. Track each recipient's outcome and actions, rather than only aggregate announcement counts.
- Push is not a reliable measure of receipt: about 5–10% of pushes may silently fail, and members may be offline for hours or days. Leaders need timely visibility into who has read, acknowledged, or plans to attend.
- AI-generated title, body, and push preview (120 characters or fewer) must remain a draft until a human leader approves sending.

## Assumptions
- Unless confirmed otherwise, the send audience is active members of the selected local, optionally filtered by classification; retired and suspended members are excluded.
- No response is required by default. Acknowledgment and an attendance RSVP ("coming" / "can't") are distinct actions; RSVP is needed for the design, but not the required build slice.
- Members can retrieve a sent callout after reconnecting; push is a prompt, not the only way to access it. No delivery-time or availability SLA is specified.
- "No duplicates" applies to both creating duplicate recipient records and sending duplicate notifications on retries. Whether this can be guaranteed at the push-provider boundary depends on provider behavior and needs to be defined.

## Concerns and gaps
- The question about members outside a local seeing apprentices' contact information may indicate an existing exposure, not just a future requirement. Treat this as a potential incident to investigate and contain before relying on a new feature's access controls.
- A unique recipient record alone does not establish that a member was notified, received the callout, read it, acknowledged it, or RSVP'd. Those states must not be conflated, especially when push can fail silently.
- "Immediately" and "before I leave the hall" have no measurable timing target; no RSVP deadline, edit policy, or rule for late audience changes is given.

## Open questions for Denise
1. Who is eligible for a callout: active members only, and how should classification changes or membership changes after sending affect it? Assumed active members at send time.
2. What does "immediately" mean, and which notification states should leadership see as sent or delivered when a push fails or a member is offline? Assumed send begins promptly, with recipient-level progress and later access.
3. Should attendance responses be optional or required, by what deadline, and may members change them? Assumed optional unless a callout explicitly requests an RSVP.

# Part A: The design

## 1. Data model

- **`locals`** stores each union local. **`users`** stores authentication identity only; it has no global member/leader role. **`local_members`** stores a user's local-specific member profile, including name, contact details, classification, and active/retired/suspended status. **`local_leaders`** grants leadership access for a specific local. Both local-access tables use `(local_id, user_id)` as a primary or unique key, with foreign keys to `locals` and `users`. A user can have different or multiple local relationships without those permissions becoming global.
- **`classifications`** stores work classifications scoped to a local, with a unique `(local_id, id)` key. `local_members` references it using `(local_id, classification_id)`, preventing a profile from using another local's classification.
- **`announcements`** belongs to a local and stores its author, title, body, push preview, acknowledgement requirement, draft/approval/send state, and relevant timestamps. Its author is constrained by a composite foreign key `(local_id, author_user_id)` to `local_leaders`; approval, when recorded, is likewise tied to a leader in that local. Give announcements a unique `(local_id, id)` key for downstream composite references.
- **`announcement_recipients`** has one row per audience member, with `(announcement_id, member_id)` unique. Store `local_id` on the row and use composite foreign keys `(local_id, announcement_id)` and `(local_id, member_id)` to the corresponding announcement and `local_members` keys. Materialize these rows from the eligible audience at send time: they are the audience snapshot, not a live query whose membership changes later. Keep push-provider state (for example queued, attempted, accepted, failed, or provider-confirmed if supported) separate from `read_at`, `acknowledged_at`, and nullable RSVP (`coming` / `can't`); no RSVP is distinct from “can't.”
- **`delivery_attempts`** records each push attempt against its recipient, including attempt time and provider outcome, so retries do not erase history. Use a foreign key to `announcement_recipients`; use a unique provider idempotency key if the provider supports one.

Use PostgreSQL `CHECK` constraints or enums for finite status/action values and checks for valid approval state/timestamp combinations. Index audience selection on `local_members (local_id, status, classification_id)`, announcement listings on `(local_id, created_at)`, recipient counts/lookups on `(local_id, announcement_id, push_status)` and `(announcement_id, read_at)` / `(announcement_id, acknowledged_at)`, the recipient member foreign key on `(local_id, member_id)`, and attempt history on `(recipient_id, attempted_at)`. Primary keys and unique constraints provide indexes for their keys; add indexes on other foreign-key columns used for joins and lookups.

These constraints reject invalid cross-local references and duplicate recipient records; they do not replace endpoint authorization checks. Likewise, a unique recipient row does not guarantee exactly-once delivery by an external push provider.
