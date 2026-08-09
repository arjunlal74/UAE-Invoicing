-- The application connects as `uae_app`, NOT as the database owner.
--
-- This matters: PostgreSQL row-level security is bypassed by superusers and,
-- by default, by the owner of the table. If the app connected as the owner,
-- every RLS policy in this system would be silently inert and tenants could
-- read each other's invoices. Migrations run as the owner (`uae`); runtime
-- queries run as `uae_app`.

CREATE ROLE uae_app WITH LOGIN PASSWORD 'uae_app_dev_password';

GRANT CONNECT ON DATABASE uae_einvoice TO uae_app;
GRANT USAGE ON SCHEMA public TO uae_app;

-- Rights on tables that already exist plus everything migrations create later.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uae_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uae_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uae_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO uae_app;
