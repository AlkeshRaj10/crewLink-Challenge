ALTER TABLE announcement_recipients
  DROP CONSTRAINT announcement_recipients_push_status_check;

UPDATE announcement_recipients
SET push_status = 'delivered'
WHERE push_status IN ('accepted', 'provider_delivered');

ALTER TABLE announcement_recipients
  ADD CONSTRAINT announcement_recipients_push_status_check
  CHECK (push_status IN ('queued', 'attempting', 'delivered', 'failed'));

ALTER TABLE outbox_jobs
  ADD COLUMN lease_token uuid;

ALTER TABLE outbox_jobs
  ADD CONSTRAINT outbox_jobs_local_job_recipient_unique UNIQUE (local_id, id, recipient_id);

ALTER TABLE delivery_attempts
  DROP CONSTRAINT delivery_attempts_provider_status_check;

ALTER TABLE delivery_attempts
  ADD CONSTRAINT delivery_attempts_provider_status_check
  CHECK (provider_status IN (
    'accepted',
    'failed',
    'delivered',
    'unknown',
    'transient_failure',
    'permanent_failure'
  ));

CREATE TABLE mock_push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id uuid NOT NULL,
  outbox_job_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  provider_idempotency_key uuid NOT NULL UNIQUE,
  provider_message_id text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mock_push_deliveries_job_unique UNIQUE (local_id, outbox_job_id),
  CONSTRAINT mock_push_deliveries_job_recipient_fk
    FOREIGN KEY (local_id, outbox_job_id, recipient_id)
    REFERENCES outbox_jobs (local_id, id, recipient_id) ON DELETE CASCADE,
  CONSTRAINT mock_push_deliveries_recipient_fk
    FOREIGN KEY (local_id, recipient_id)
    REFERENCES announcement_recipients (local_id, id) ON DELETE CASCADE
);
