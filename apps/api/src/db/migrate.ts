import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Migration runner.
 *
 * Connects as the database OWNER (DATABASE_URL), not the runtime app role,
 * because creating tables, types and RLS policies requires ownership. The
 * application itself never uses this connection.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

export async function runMigrations(): Promise<void> {
  const cfg = config();
  const sql = postgres(cfg.DATABASE_URL, { max: 1, onnotice: () => {} });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
    );

    for (const file of files) {
      if (applied.has(file)) continue;

      const contents = await readFile(join(migrationsDir, file), 'utf8');
      logger.info({ migration: file }, 'applying migration');

      // Each migration is one transaction: a failure half-way leaves nothing
      // behind, so re-running after a fix is always safe.
      await sql.begin(async (tx) => {
        await tx.unsafe(contents);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });

      logger.info({ migration: file }, 'migration applied');
    }

    if (files.length === applied.size) {
      logger.info('database schema is up to date');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
