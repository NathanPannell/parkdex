CREATE TABLE mcp_oauth_clients (
    client_id UUID PRIMARY KEY,
    metadata JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mcp_oauth_authorization_requests (
    request_hash CHAR(64) PRIMARY KEY CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    client_id UUID NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    state TEXT,
    scopes TEXT[] NOT NULL,
    code_challenge CHAR(43) NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
    resource TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at)
);

CREATE TABLE mcp_oauth_authorization_codes (
    code_hash CHAR(64) PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    client_id UUID NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    redirect_uri_provided_explicitly BOOLEAN NOT NULL,
    scopes TEXT[] NOT NULL,
    code_challenge CHAR(43) NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
    resource TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at)
);

CREATE TABLE mcp_oauth_tokens (
    token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    token_kind TEXT NOT NULL CHECK (token_kind IN ('access', 'refresh')),
    grant_id UUID NOT NULL,
    family_id UUID NOT NULL,
    parent_grant_id UUID,
    client_id UUID NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    scopes TEXT[] NOT NULL,
    resource TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at)
);

CREATE INDEX mcp_oauth_tokens_grant_idx ON mcp_oauth_tokens (grant_id);
CREATE INDEX mcp_oauth_tokens_family_idx ON mcp_oauth_tokens (family_id);
CREATE INDEX mcp_oauth_clients_cleanup_idx ON mcp_oauth_clients (last_used_at);
CREATE INDEX mcp_oauth_tokens_account_idx ON mcp_oauth_tokens (account_id, expires_at);
CREATE INDEX mcp_oauth_authorization_requests_expiry_idx ON mcp_oauth_authorization_requests (expires_at);
CREATE INDEX mcp_oauth_authorization_codes_expiry_idx ON mcp_oauth_authorization_codes (expires_at);
CREATE INDEX mcp_oauth_tokens_expiry_idx ON mcp_oauth_tokens (expires_at);
