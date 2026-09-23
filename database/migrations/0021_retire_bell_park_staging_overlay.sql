-- Retire the staging-only Bell Park row while preserving account visit history.
-- Clearing the scope also keeps an N-1 API with the old staging id allowlist
-- from returning the row during a rolling deployment.
UPDATE places
SET active = FALSE,
    field_test_scope = NULL
WHERE id = 'regional-bell-park'
  AND field_test_scope = 'staging';
