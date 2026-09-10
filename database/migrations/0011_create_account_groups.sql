CREATE TABLE account_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (CHAR_LENGTH(BTRIM(name)) BETWEEN 1 AND 200),
    is_wishlist BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (is_wishlist AND name = 'Wishlist')
        OR (NOT is_wishlist AND LOWER(BTRIM(name)) <> 'wishlist')
    )
);

CREATE INDEX account_groups_account_id_updated_idx
    ON account_groups (account_id, updated_at DESC, id);

CREATE UNIQUE INDEX account_groups_account_wishlist_idx
    ON account_groups (account_id)
    WHERE is_wishlist;

CREATE TABLE account_group_places (
    group_id UUID NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE,
    place_id TEXT NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, place_id)
);

CREATE INDEX account_group_places_place_id_idx ON account_group_places (place_id);
