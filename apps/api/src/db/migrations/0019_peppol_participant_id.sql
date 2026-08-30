-- ===========================================================================
-- The tenant's address on the Peppol network.
--
-- Not the TRN, and not derivable by anyone who has not been told the rule: the
-- participant identifier is the UAE scheme code 0235 joined to the *first ten*
-- digits of the fifteen-digit TRN — the TIN. Storing it rather than deriving it
-- at every call site means the transformation is written once, and a tenant
-- whose ASP issued something other than the default can hold that instead.
--
-- Null is a valid state. A channel partner has no TRN because it never files,
-- and a tenant onboarded before its EmaraTax registration completes has no
-- identifier yet — the ASP registers it on the network during onboarding, so
-- until they do, the address does not exist.
-- ===========================================================================

ALTER TABLE tenants
  ADD COLUMN peppol_participant_id TEXT;

-- Backfill from the TRN every existing filing tenant already holds, using the
-- same rule the API applies from here on.
UPDATE tenants
   SET peppol_participant_id = '0235:' || left(trn, 10)
 WHERE trn IS NOT NULL
   AND length(trn) >= 10;
