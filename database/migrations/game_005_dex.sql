-- My Dex (#174): backup of each photo's display choices, and photo claims kept out of visit history.
-- Additive and idempotent: runs on every deploy after progress_001_init.sql and game_001_init.sql.

-- A photo is its own immutable claim (docs/accounts-implementation-contract.md). Its 3:4 crop, the
-- player's cover choice and a removal are mutable display choices, so they live beside the claim
-- instead of in it. One row per claim, written whole by `PUT /api/claims/:claimId/display`; the last
-- write wins. The crop is normalised 0–1 to the upright photo (src/lib/photoCrop.ts); null means
-- the largest centred 3:4 fit. The row goes with its claim, so account deletion removes it too.
CREATE TABLE IF NOT EXISTS kip_account.claim_display (
  account_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  crop jsonb CHECK (crop IS NULL OR (
    jsonb_typeof(crop) = 'object'
    AND crop ?& ARRAY['x', 'y', 'width', 'height']
    AND crop - ARRAY['x', 'y', 'width', 'height'] = '{}'::jsonb
    AND jsonb_typeof(crop->'x') = 'number' AND jsonb_typeof(crop->'y') = 'number'
    AND jsonb_typeof(crop->'width') = 'number' AND jsonb_typeof(crop->'height') = 'number'
    AND (crop->>'x')::numeric >= 0 AND (crop->>'y')::numeric >= 0
    AND (crop->>'width')::numeric > 0 AND (crop->>'height')::numeric > 0
    AND (crop->>'x')::numeric + (crop->>'width')::numeric <= 1.000001
    AND (crop->>'y')::numeric + (crop->>'height')::numeric <= 1.000001
  )),
  -- When the player made this photo their park's cover. The latest choice per park wins.
  cover_at timestamptz,
  -- Removed photos are hidden on every device. The photo itself stays backed up.
  removed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, claim_id),
  FOREIGN KEY (account_id, claim_id) REFERENCES kip_account.claims (account_id, claim_id) ON DELETE CASCADE
);

-- game_001_init.sql imports every claim as visit history on each deploy. A photo taken after a
-- visit (My Dex "Add a photo") is a claim too, and must not count as another visit: skip a claim
-- import when the account already has a real visit to that park at or before the claim's time.
-- Claims from before the flag game have no earlier visit, so they are still imported.
CREATE OR REPLACE FUNCTION kip_game.skip_photo_claim_import()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'claim_import' AND EXISTS (
    SELECT 1 FROM kip_game.visits v
    WHERE v.account_id = NEW.account_id AND v.park_id = NEW.park_id AND v.source = 'visit' AND v.visited_at <= NEW.visited_at
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;

-- Created once; a replay leaves the trigger alone, so it takes no lock on visits.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'visits_skip_photo_claim_import' AND tgrelid = 'kip_game.visits'::regclass
  ) THEN
    CREATE TRIGGER visits_skip_photo_claim_import
      BEFORE INSERT ON kip_game.visits
      FOR EACH ROW WHEN (NEW.source = 'claim_import')
      EXECUTE FUNCTION kip_game.skip_photo_claim_import();
  END IF;
END
$$;
