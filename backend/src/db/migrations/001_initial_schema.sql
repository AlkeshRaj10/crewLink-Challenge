CREATE TABLE locals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));

CREATE TABLE classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id uuid NOT NULL REFERENCES locals (id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT classifications_local_id_id_unique UNIQUE (local_id, id),
  CONSTRAINT classifications_local_name_unique UNIQUE (local_id, name)
);

CREATE TABLE local_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id uuid NOT NULL REFERENCES locals (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  email text NOT NULL,
  classification_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT local_members_status_check CHECK (status IN ('active', 'retired', 'suspended')),
  CONSTRAINT local_members_local_user_unique UNIQUE (local_id, user_id),
  CONSTRAINT local_members_local_id_id_unique UNIQUE (local_id, id),
  CONSTRAINT local_members_local_classification_fk
    FOREIGN KEY (local_id, classification_id)
    REFERENCES classifications (local_id, id) ON DELETE RESTRICT
);

CREATE INDEX local_members_audience_idx ON local_members (local_id, status, classification_id);

CREATE TABLE local_leaders (
  local_id uuid NOT NULL REFERENCES locals (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (local_id, user_id)
);

CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id uuid NOT NULL REFERENCES locals (id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  push_preview varchar(120),
  needs_ack boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft',
  approved_by_user_id uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcements_status_check CHECK (status IN ('draft', 'approved', 'sending', 'sent', 'failed')),
  CONSTRAINT announcements_approval_pair_check
    CHECK ((approved_by_user_id IS NULL) = (approved_at IS NULL)),
  CONSTRAINT announcements_approved_state_check
    CHECK (status = 'draft' OR approved_at IS NOT NULL),
  CONSTRAINT announcements_sent_timestamp_check
    CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT announcements_local_id_id_unique UNIQUE (local_id, id),
  CONSTRAINT announcements_author_local_leader_fk
    FOREIGN KEY (local_id, author_user_id)
    REFERENCES local_leaders (local_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT announcements_approver_local_leader_fk
    FOREIGN KEY (local_id, approved_by_user_id)
    REFERENCES local_leaders (local_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX announcements_local_created_idx ON announcements (local_id, created_at DESC);
CREATE INDEX announcements_local_status_created_idx ON announcements (local_id, status, created_at DESC);

CREATE TABLE announcement_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id uuid NOT NULL,
  announcement_id uuid NOT NULL,
  member_id uuid NOT NULL,
  push_status text NOT NULL DEFAULT 'queued',
  read_at timestamptz,
  acknowledged_at timestamptz,
  rsvp text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcement_recipients_push_status_check
    CHECK (push_status IN ('queued', 'attempting', 'accepted', 'failed', 'provider_delivered')),
  CONSTRAINT announcement_recipients_rsvp_check CHECK (rsvp IS NULL OR rsvp IN ('coming', 'cant')),
  CONSTRAINT announcement_recipients_announcement_member_unique UNIQUE (announcement_id, member_id),
  CONSTRAINT announcement_recipients_local_id_id_unique UNIQUE (local_id, id),
  CONSTRAINT announcement_recipients_local_announcement_fk
    FOREIGN KEY (local_id, announcement_id)
    REFERENCES announcements (local_id, id) ON DELETE CASCADE,
  CONSTRAINT announcement_recipients_local_member_fk
    FOREIGN KEY (local_id, member_id)
    REFERENCES local_members (local_id, id) ON DELETE RESTRICT
);

CREATE INDEX announcement_recipients_local_announcement_push_idx
  ON announcement_recipients (local_id, announcement_id, push_status);
CREATE INDEX announcement_recipients_announcement_read_idx
  ON announcement_recipients (announcement_id, read_at);
CREATE INDEX announcement_recipients_announcement_ack_idx
  ON announcement_recipients (announcement_id, acknowledged_at);
CREATE INDEX announcement_recipients_local_member_idx
  ON announcement_recipients (local_id, member_id);

CREATE TABLE send_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id uuid NOT NULL,
  leader_user_id uuid NOT NULL,
  announcement_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_requests_key_unique UNIQUE (local_id, leader_user_id, idempotency_key),
  CONSTRAINT send_requests_local_announcement_fk
    FOREIGN KEY (local_id, announcement_id)
    REFERENCES announcements (local_id, id) ON DELETE CASCADE,
  CONSTRAINT send_requests_local_leader_fk
    FOREIGN KEY (local_id, leader_user_id)
    REFERENCES local_leaders (local_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  provider_idempotency_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_jobs_status_check CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  CONSTRAINT outbox_jobs_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT outbox_jobs_local_recipient_unique UNIQUE (local_id, recipient_id),
  CONSTRAINT outbox_jobs_local_id_id_unique UNIQUE (local_id, id),
  CONSTRAINT outbox_jobs_local_recipient_fk
    FOREIGN KEY (local_id, recipient_id)
    REFERENCES announcement_recipients (local_id, id) ON DELETE CASCADE
);

CREATE INDEX outbox_jobs_claim_idx ON outbox_jobs (status, available_at);
CREATE INDEX outbox_jobs_lease_idx ON outbox_jobs (status, lease_until);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  provider_status text NOT NULL,
  provider_message_id text,
  error_code text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_attempts_attempt_number_check CHECK (attempt_number > 0),
  CONSTRAINT delivery_attempts_provider_status_check
    CHECK (provider_status IN ('accepted', 'failed', 'delivered', 'unknown')),
  CONSTRAINT delivery_attempts_recipient_attempt_unique UNIQUE (local_id, recipient_id, attempt_number),
  CONSTRAINT delivery_attempts_local_recipient_fk
    FOREIGN KEY (local_id, recipient_id)
    REFERENCES announcement_recipients (local_id, id) ON DELETE CASCADE
);

CREATE INDEX delivery_attempts_recipient_time_idx
  ON delivery_attempts (recipient_id, attempted_at);
