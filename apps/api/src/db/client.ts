import postgres from 'postgres';
import { config } from '../config.js';

/**
 * Database access with tenant isolation enforced by PostgreSQL, not by us
 * remembering to add `WHERE tenant_id = ?` to every query.
 *
 * The rule: any query touching tenant data goes through `withTenant` (or
 * `withPlatformAccess` for admin screens). Both run inside a transaction and
 * set a local GUC that the RLS policies read. `SET LOCAL` is scoped to the
 * transaction, so a connection returned to the pool can never carry another
 * request's tenant with it.
 */

let sqlInstance: postgres.Sql | null = null;

export function sql(): postgres.Sql {
  if (!sqlInstance) {
    const cfg = config();
    sqlInstance = postgres(cfg.appDatabaseUrl, {
      max: 20,
      idle_timeout: 30,
      connect_timeout: 15,
      // Amounts must never round-trip through a float. postgres.js hands back
      // NUMERIC as a string by default, which is what we want; this makes it
      // explicit and immune to a future default change.
      types: {
        numeric: {
          to: 1700,
          from: [1700],
          serialize: (v: string | number) => String(v),
          parse: (v: string) => v,
        },
      },
      onnotice: () => {},
    });
  }
  return sqlInstance;
}

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/**
 * Bind a value as jsonb.
 *
 * Always use this instead of `${JSON.stringify(value)}::jsonb`. That form looks
 * correct and is not: postgres.js applies its own JSON serialisation on top of
 * the already-serialised string, so the column ends up holding a jsonb *string
 * scalar* rather than the document. Reads then return a string, and
 * `jsonb_typeof` reports 'string' — a failure that surfaces far from its cause.
 *
 * The cast to `never` is here because postgres.js's JSONValue type only admits
 * types with an index signature, which plain interfaces do not have. Confining
 * it to this one function keeps that noise out of the call sites.
 */
export function jsonb(client: Sql | Tx, value: unknown) {
  return (client as Sql).json(value as never);
}

/**
 * Run `fn` with tenant scoping applied. Every statement inside sees only rows
 * belonging to `tenantId`.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return sql().begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    await tx`SELECT set_config('app.platform_access', 'off', true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Run `fn` with cross-tenant visibility, for platform admin and support
 * screens and for background workers that legitimately process every tenant's
 * queue. Deliberately named so that its use stands out in review.
 */
export async function withPlatformAccess<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql().begin(async (tx) => {
    await tx`SELECT set_config('app.platform_access', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Scope by tenant when one is known, otherwise fall back to platform access.
 * Used by request handlers shared between merchant and admin callers.
 */
export async function withScope<T>(
  tenantId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tenantId ? withTenant(tenantId, fn) : withPlatformAccess(fn);
}

export async function closeDb(): Promise<void> {
  if (sqlInstance) {
    await sqlInstance.end({ timeout: 5 });
    sqlInstance = null;
  }
}
