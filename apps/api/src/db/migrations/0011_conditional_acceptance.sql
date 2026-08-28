-- ===========================================================================
-- Closing the loop on a conditional acceptance (§11).
--
-- A buyer who answers CA has accepted the invoice — `applyBuyerResponse` marks
-- the dispute resolved and the document reads as ACCEPTED_BY_BUYER, the same as
-- a clean AP. But the condition itself rides in free text in
-- `latest_response_comment`, and until now nothing recorded whether anyone had
-- read it, let alone met it.
--
-- So the accounts-receivable side had a class of invoice that was legally
-- settled and commercially outstanding, with no way to tell the two apart and
-- nowhere to work them from. These columns give a conditional acceptance the
-- one thing it lacked: a state that a person can move.
--
-- Deliberately separate from `dispute_resolved`. That flag answers "is the
-- buyer still refusing to pay?" and CA already answers it with no. This one
-- answers "has our side done what they asked?", which is a different question
-- with a different owner, and folding them together would reopen a dispute that
-- was never opened.
-- ===========================================================================

ALTER TABLE invoices
  ADD COLUMN condition_met BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN condition_met_at TIMESTAMPTZ,
  ADD COLUMN condition_met_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- What was actually done about it. The buyer's demand is already stored in
  -- `latest_response_comment`; this is our answer to it, and an auditor asking
  -- why a conditional acceptance was signed off needs both halves.
  ADD COLUMN condition_met_note TEXT;

-- The conditional-acceptance worklist: outstanding conditions, oldest first.
-- Mirrors `invoices_open_disputes_idx` for the dispute desk next door.
CREATE INDEX invoices_open_conditions_idx
  ON invoices (tenant_id, issue_date)
  WHERE latest_response_code = 'CA' AND NOT condition_met;
