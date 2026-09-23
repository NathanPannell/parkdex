-- Field-test places are runtime-managed overlays. Nullable scope preserves
-- compatibility with N-1 application instances and every canonical row.
ALTER TABLE places
    ADD COLUMN IF NOT EXISTS field_test_scope TEXT;

ALTER TABLE places
    ADD CONSTRAINT places_field_test_scope_check
        CHECK (
            field_test_scope IS NULL
            OR (field_test_scope = 'staging' AND active = FALSE)
        );

CREATE INDEX IF NOT EXISTS places_field_test_scope_idx
    ON places (field_test_scope)
    WHERE field_test_scope IS NOT NULL;
