-- Feedback archive. "Clear done" on the operator board sets archived_at instead of deleting, so
-- reports stay searchable and can be restored. The daily retention job deletes archived reports
-- (with their attachments and email rows, through ON DELETE CASCADE) 90 days after archiving.
--
-- Migrations replay on every deploy, so each step checks the catalog first and only takes a lock
-- on kip_feedback.reports the first time it runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kip_feedback' AND table_name = 'reports' AND column_name = 'archived_at'
  ) THEN
    ALTER TABLE kip_feedback.reports ADD COLUMN archived_at timestamptz;
  END IF;

  -- The board lists live reports per status, newest first.
  IF to_regclass('kip_feedback.reports_board_idx') IS NULL THEN
    CREATE INDEX reports_board_idx ON kip_feedback.reports (status, created_at DESC, id DESC) WHERE archived_at IS NULL;
  END IF;

  -- The archive view lists newest archived first, and retention finds the oldest.
  IF to_regclass('kip_feedback.reports_archived_idx') IS NULL THEN
    CREATE INDEX reports_archived_idx ON kip_feedback.reports (archived_at DESC, id DESC) WHERE archived_at IS NOT NULL;
  END IF;
END
$$;
