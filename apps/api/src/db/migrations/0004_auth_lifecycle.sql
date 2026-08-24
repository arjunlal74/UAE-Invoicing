-- ===========================================================================
-- SRS v2.3 §3–§4 — credential lifecycle
-- ===========================================================================
-- v2.1 had one token store for one purpose: invitations, valid for seven days.
-- v2.3 adds password reset and forced rotation, puts a hard 24-hour ceiling on
-- every activation vector, and requires a password history. Two token tables
-- would mean two expiry rules and two revocation paths, so the invite table is
-- folded into a general one keyed by purpose.

CREATE TYPE token_type AS ENUM ('ACTIVATION_INVITE', 'PASSWORD_RESET', 'MFA_CHALLENGE');

CREATE TABLE auth_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Only ever the SHA-256 of the value that was e-mailed. A database
  -- disclosure must not hand over a working activation link.
  token_hash  CHAR(64) NOT NULL UNIQUE,
  token_type  token_type NOT NULL DEFAULT 'ACTIVATION_INVITE',

  is_used     BOOLEAN NOT NULL DEFAULT FALSE,
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),

  -- Kept for the audit trail: who asked, and from where.
  requested_ip INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The lookup every redemption performs, in the order the planner wants it.
CREATE INDEX auth_tokens_lookup_idx ON auth_tokens (token_hash, is_used, expires_at);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, token_type);

-- Carry the outstanding invitations across rather than stranding anyone who was
-- invited before this migration and has not signed in yet.
INSERT INTO auth_tokens (user_id, token_hash, token_type, is_used, used_at, expires_at, created_at)
SELECT user_id, token_hash, 'ACTIVATION_INVITE', accepted_at IS NOT NULL, accepted_at,
       expires_at, created_at
FROM user_invites;

DROP TABLE user_invites;

-- --- Credential state on the user ------------------------------------------

ALTER TABLE users
  -- §4.2: the new secret is checked against the last three. Hashes only, and
  -- capped at three by the application — an unbounded array here would grow
  -- without limit and is a list of things to attack offline.
  ADD COLUMN password_history JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- §4.4 tracks the lock explicitly rather than inferring it from a timestamp,
  -- so an administrator can see the state without doing date arithmetic.
  ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT FALSE,

  -- §4.4 counts failures "within a 15-minute window", which needs the time of
  -- the last one: without it the counter never resets and a user who mistypes
  -- once a month is eventually locked out by history.
  ADD COLUMN last_failed_login_at TIMESTAMPTZ,

  -- §4.3: set by an administrator, cleared the moment the user sets a password.
  ADD COLUMN must_rotate_password BOOLEAN NOT NULL DEFAULT FALSE,

  ADD COLUMN password_last_changed_at TIMESTAMPTZ;

-- Existing accounts have a password of unknown age; recording "now" would claim
-- a rotation that never happened, so it stays NULL until one actually occurs.

COMMENT ON COLUMN users.password_history IS
  'Argon2 hashes of the previous passwords, newest first, capped at 3 (SRS v2.3 §4.2).';
COMMENT ON COLUMN users.must_rotate_password IS
  'Blocks every route but password change until the user sets a new secret (SRS v2.3 §4.3).';
