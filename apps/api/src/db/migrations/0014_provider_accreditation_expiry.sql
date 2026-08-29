-- ===========================================================================
-- When a provider's accreditation runs out.
--
-- The master already records *which* entry on the Ministry of Finance list a
-- provider holds. That entry has an end date, and a lapsed one is not a filing
-- detail: units bought on a contract signed with a provider whose accreditation
-- had expired are units the platform may not be able to file against, and the
-- first anyone would know is a rejection.
--
-- Nullable, because it is not always to hand when a provider is first added and
-- an empty date is a truthful "not recorded" — better than a guessed one that
-- would eventually raise or suppress a warning on no evidence.
-- ===========================================================================

ALTER TABLE asp_providers
  ADD COLUMN accreditation_valid_until DATE;
