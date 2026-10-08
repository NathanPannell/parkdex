-- Drafts can start from a player's proposal with no legacy match, so the boundary may be
-- drawn later in the dashboard. Publication still requires one.
ALTER TABLE kip_park_drafts.drafts ALTER COLUMN geometry DROP NOT NULL;
