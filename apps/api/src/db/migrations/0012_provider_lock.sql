-- ===========================================================================
-- Locking a provider record.
--
-- Retirement (`is_active`) answers "may we still buy from them". This answers a
-- different question: "may this record still be edited". A provider that has
-- been checked against the MoF's published list, had its accreditation
-- reference confirmed and its rate agreed is a record you want to stop drifting
-- — a mistyped accreditation reference on a provider with contracts against it
-- is a due-diligence trail that no longer leads anywhere.
--
-- The two are independent on purpose. A locked provider is still bought from;
-- a retired one is still editable; either, both or neither is a valid state.
-- ===========================================================================

ALTER TABLE asp_providers
  ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Not a partial index on the flag: the master is a handful of rows and every
-- read of it is a full scan already. The column exists to be enforced by the
-- API, which refuses any edit but the unlock while it is set.
