-- ===========================================================================
-- What a provider is, as opposed to what one merchant's account with them is.
--
-- Onboarding a tenant meant typing the provider's name and endpoint again for
-- every merchant, from memory, per tenant. Those two are facts about the
-- provider and identical for every merchant on it; only the credentials and the
-- account identifier are issued per merchant. Holding the shared half on the
-- master means onboarding can fill it in, and a provider that changes its
-- endpoint is one edit rather than one per tenant.
--
-- `provider_type` defaults to MOCK rather than GENERIC_REST on purpose: no real
-- ASP contract exists yet, and a tenant onboarded against a real driver would
-- attempt live HTTP to an endpoint nobody has filled in. The simulator is the
-- honest default until a contract is signed, and the field is editable.
-- ===========================================================================

ALTER TABLE asp_providers
  ADD COLUMN provider_type asp_provider_type NOT NULL DEFAULT 'MOCK',
  ADD COLUMN api_endpoint  TEXT NOT NULL DEFAULT '';

-- Which accredited provider a tenant's connection is with.
--
-- The connection row already carried a display name, which is a label rather
-- than a link: two tenants on the same provider could spell it differently, and
-- "who is on EDICOM" could not be answered at all.
ALTER TABLE tenant_asp_configs
  ADD COLUMN asp_provider_id UUID REFERENCES asp_providers(id) ON DELETE SET NULL;

CREATE INDEX idx_tenant_asp_configs_provider ON tenant_asp_configs (asp_provider_id);
