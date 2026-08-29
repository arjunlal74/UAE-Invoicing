-- ===========================================================================
-- When a provider's accreditation started.
--
-- 0014 recorded when it lapses, which is the date that raises an alarm. This is
-- the other end of the same fact, and it answers a question the first cannot:
-- whether the provider was accredited on the day a given contract was signed.
-- A renewal moves both, so keeping only the end date loses the history of what
-- was true last year.
--
-- Nullable like its pair, because a record is filled in from the Ministry of
-- Finance list after the provider is added, and often only the expiry is to
-- hand at that moment.
-- ===========================================================================

ALTER TABLE asp_providers
  ADD COLUMN accreditation_from DATE;

-- An accreditation cannot lapse before it starts. Enforced here as well as in
-- the API, because this is the constraint that survives a direct correction to
-- the table.
ALTER TABLE asp_providers
  ADD CONSTRAINT accreditation_period_ordered CHECK (
    accreditation_from IS NULL
    OR accreditation_valid_until IS NULL
    OR accreditation_valid_until >= accreditation_from
  );
