CREATE SCHEMA IF NOT EXISTS kip_feedback;

CREATE TABLE IF NOT EXISTS kip_feedback.reports (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE,
  payload_hash char(64) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bug', 'idea', 'general')),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  email text,
  contact boolean NOT NULL,
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'planned', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reports_created_at_idx
  ON kip_feedback.reports (created_at DESC);

CREATE TABLE IF NOT EXISTS kip_feedback.attachments (
  report_id uuid PRIMARY KEY REFERENCES kip_feedback.reports(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  content bytea NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kip_feedback.email_deliveries (
  report_id uuid NOT NULL REFERENCES kip_feedback.reports(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('operator', 'receipt')),
  recipient text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous', 'disabled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key text NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, audience),
  UNIQUE (idempotency_key),
  CHECK ((status = 'sending') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);

ALTER TABLE kip_feedback.email_deliveries
  ADD COLUMN IF NOT EXISTS provider_message_id text;

CREATE INDEX IF NOT EXISTS email_deliveries_pending_idx
  ON kip_feedback.email_deliveries (status, last_attempt_at)
  WHERE status IN ('pending', 'failed', 'ambiguous', 'sending');

CREATE TABLE IF NOT EXISTS kip_feedback.rate_limits (
  bucket text NOT NULL CHECK (bucket IN ('submission_ip', 'submission_recipient', 'operator_login_ip')),
  subject_hash char(64) NOT NULL,
  window_started_at timestamptz NOT NULL,
  hit_count integer NOT NULL CHECK (hit_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, subject_hash)
);
