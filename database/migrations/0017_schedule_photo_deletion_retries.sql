-- Failed object deletions must yield to newly queued work instead of occupying
-- the oldest slots in every worker batch. This migration is separate from
-- 0016 so environments that have already applied the initial outbox migration
-- keep their immutable migration checksum.
ALTER TABLE photo_object_deletions
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

UPDATE photo_object_deletions
SET next_attempt_at = COALESCE(last_attempted_at, enqueued_at, NOW())
WHERE next_attempt_at IS NULL;

ALTER TABLE photo_object_deletions
    ALTER COLUMN next_attempt_at SET DEFAULT NOW(),
    ALTER COLUMN next_attempt_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS photo_object_deletions_due_idx
    ON photo_object_deletions (next_attempt_at, enqueued_at, object_key);
