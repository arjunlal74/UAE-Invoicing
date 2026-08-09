#!/bin/sh
# Create the runtime application role.
#
# The application connects as `uae_app`, NOT as the database owner. This matters:
# PostgreSQL row-level security is bypassed by superusers and by a table's owner
# unless FORCE is set, so if the app connected as the owner every RLS policy in
# this system would be inert and tenants could read each other's invoices.
# Migrations run as the owner; runtime queries run as this role.
#
# A shell script rather than plain .sql so the password comes from the
# environment instead of being committed — the two must agree with
# DATABASE_APP_URL or the API cannot authenticate at all.

set -e

APP_PASSWORD="${APP_DB_PASSWORD:-uae_app_dev_password}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'uae_app') THEN
            CREATE ROLE uae_app WITH LOGIN PASSWORD '${APP_PASSWORD}';
        ELSE
            ALTER ROLE uae_app WITH PASSWORD '${APP_PASSWORD}';
        END IF;
    END
    \$\$;

    GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO uae_app;
    GRANT USAGE ON SCHEMA public TO uae_app;

    -- Rights on what exists now plus everything migrations create later.
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uae_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uae_app;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uae_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO uae_app;
SQL

echo "role uae_app ready"
