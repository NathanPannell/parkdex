ALTER TABLE account_visit_claims
ADD COLUMN photo_account_modified BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE guest_visit_claims
DROP CONSTRAINT guest_visit_claims_check4,
ADD CONSTRAINT guest_visit_claims_photo_version_check
    CHECK (photo_bytes IS NULL OR photo_updated_at IS NOT NULL);

ALTER TABLE account_visit_claims
DROP CONSTRAINT account_visit_claims_check4,
ADD CONSTRAINT account_visit_claims_photo_version_check
    CHECK (photo_bytes IS NULL OR photo_updated_at IS NOT NULL);
