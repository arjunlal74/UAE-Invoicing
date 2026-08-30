-- ===========================================================================
-- Locking a tenant record.
--
-- Suspension (`status`) answers "may they still file". This answers a different
-- question: "may this record still be edited". A tenant whose legal name and
-- TRN have been checked against their trade licence is a record you want to
-- stop drifting — a name corrected by somebody who thought they were fixing a
-- typo no longer matches the documents already filed under it.
--
-- The two are independent on purpose, and the mistake worth guarding against is
-- treating them as one thing: locking a record must never stop a merchant
-- filing, and suspending a merchant must never freeze their details from
-- correction. Either, both or neither is a valid state.
--
-- Mirrors `asp_providers.is_locked`, which exists for the same reason and is
-- enforced the same way: the API refuses any edit but the unlock while it is
-- set.
-- ===========================================================================

ALTER TABLE tenants
  ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT FALSE;
