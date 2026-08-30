-- ===========================================================================
-- The identifier this platform is known by at a provider.
--
-- An ASP issues an account reference to the party that holds the contract with
-- them, and that party is this platform: it buys the capacity wholesale
-- (`asp_bundle_procurements`) and resells it to tenants. So the reference is a
-- fact about the platform's relationship with one provider, not about any one
-- merchant, and it belongs beside the endpoint rather than being retyped into
-- every tenant's connection from memory.
--
-- `tenant_asp_configs.provider_account_id` stays. It is now a default filled
-- from here when a provider is chosen, and still editable: a provider that
-- issues a sub-account per merchant can have one recorded per tenant, and
-- overwriting that from the master would lose it.
-- ===========================================================================

ALTER TABLE asp_providers
  ADD COLUMN provider_account_id TEXT;
