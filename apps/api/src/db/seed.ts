import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/service.js';
import { config } from '../config.js';
import { encryptSecret, sha256Hex } from '../lib/crypto.js';
import { logger } from '../logger.js';
import { closeDb, jsonb, sql, withPlatformAccess } from './client.js';
import { runMigrations } from './migrate.js';

/**
 * Development seed.
 *
 * Creates a platform administrator and two merchants: one fully active with a
 * working (mock) provider connection, and one still PENDING_REGISTRATION — so
 * the "you cannot submit yet" path is visible without having to contrive it.
 *
 * Refuses to run against production. Seeded accounts have known passwords.
 */

const DEV_PASSWORD = 'ChangeMe_Dev_2026!';

async function seed() {
  const cfg = config();
  if (cfg.isProduction) {
    throw new Error('Refusing to seed a production database.');
  }

  await runMigrations();

  const passwordHash = await hashPassword(DEV_PASSWORD);
  const webhookSecret = randomBytes(24).toString('hex');

  await withPlatformAccess(async (tx) => {
    const existing = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM tenants
    `;
    if (Number(existing[0]!.count) > 0) {
      logger.info('database already contains tenants; skipping seed');
      return;
    }

    // --- Platform staff ----------------------------------------------------
    await tx`
      INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active)
      VALUES (NULL, 'admin@platform.local', 'Platform Administrator', 'PLATFORM_ADMIN',
              ${passwordHash}, TRUE)
    `;
    await tx`
      INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active)
      VALUES (NULL, 'support@platform.local', 'Platform Support', 'PLATFORM_SUPPORT',
              ${passwordHash}, TRUE)
    `;

    // --- Active merchant ---------------------------------------------------
    const active = await tx<{ id: string }[]>`
      INSERT INTO tenants (
        company_code, legal_name_en, legal_name_ar, trn, is_vat_group,
        registered_address, status
      ) VALUES (
        'ALBAHAR', 'Al-Bahar Enterprises LLC', 'شركة البحار للمقاولات ذ.م.م',
        '100293847500003', FALSE,
        ${jsonb(tx, {
          street: 'Sheikh Zayed Road',
          city: 'Dubai',
          emirate: 'Dubai',
          postalCode: '00000',
          countryCode: 'AE',
        })},
        'ACTIVE'
      )
      RETURNING id
    `;
    const activeId = active[0]!.id;

    await tx`
      INSERT INTO tenant_asp_configs (
        tenant_id, provider_type, display_name, api_endpoint,
        credentials_cipher, webhook_secret_hash, provider_account_id, status, notes
      ) VALUES (
        ${activeId}, 'MOCK', 'Simulated Accredited Provider', '',
        ${encryptSecret(JSON.stringify({ apiKey: 'mock-api-key', webhookSecret }))},
        ${sha256Hex(webhookSecret)},
        'MOCK-ACCT-0001', 'ACTIVE',
        'Simulated provider. Replace with a real ASP once one is selected.'
      )
    `;

    for (const [email, name, role] of [
      ['admin@albahar.local', 'Fatima Al-Mansoori', 'TENANT_ADMIN'],
      ['finance@albahar.local', 'Rashid Khan', 'FINANCE_USER'],
      ['clerk@albahar.local', 'Priya Nair', 'DATA_ENTRY_CLERK'],
      ['auditor@albahar.local', 'James Whitfield', 'AUDITOR'],
    ] as const) {
      await tx`
        INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active)
        VALUES (${activeId}, ${email}, ${name}, ${role}::user_role, ${passwordHash}, TRUE)
      `;
    }

    // --- Merchant still waiting on provider registration -------------------
    const pending = await tx<{ id: string }[]>`
      INSERT INTO tenants (
        company_code, legal_name_en, legal_name_ar, trn, is_vat_group,
        registered_address, status
      ) VALUES (
        'GULFTECH', 'Gulf Tech Solutions FZE', 'شركة الخليج للحلول التقنية',
        '100492817400003', FALSE,
        ${jsonb(tx, {
          street: 'Corniche Road',
          city: 'Abu Dhabi',
          emirate: 'Abu Dhabi',
          postalCode: '00000',
          countryCode: 'AE',
        })},
        'PENDING'
      )
      RETURNING id
    `;
    const pendingId = pending[0]!.id;

    await tx`
      INSERT INTO tenant_asp_configs (
        tenant_id, provider_type, display_name, api_endpoint, status, notes
      ) VALUES (
        ${pendingId}, 'GENERIC_REST', 'Awaiting provider selection', '',
        'PENDING_REGISTRATION',
        'Registration with the accredited provider has not completed. This tenant can upload and correct invoices but cannot submit.'
      )
    `;

    await tx`
      INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active)
      VALUES (${pendingId}, 'admin@gulftech.local', 'Omar Haddad', 'TENANT_ADMIN',
              ${passwordHash}, TRUE)
    `;

    logger.info({ activeId, pendingId }, 'seed data created');
  });

  const banner = `
────────────────────────────────────────────────────────────────────
  Seed complete. All accounts use the password: ${DEV_PASSWORD}

  PLATFORM ADMIN     admin@platform.local
  PLATFORM SUPPORT   support@platform.local

  Al-Bahar Enterprises (ACTIVE — can submit)
    TENANT ADMIN     admin@albahar.local
    FINANCE USER     finance@albahar.local
    DATA ENTRY       clerk@albahar.local
    AUDITOR          auditor@albahar.local

  Gulf Tech Solutions (PENDING — upload only, cannot submit)
    TENANT ADMIN     admin@gulftech.local

  Mock provider webhook secret: ${webhookSecret}
────────────────────────────────────────────────────────────────────
`;
  process.stdout.write(banner);
}

seed()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'seed failed');
    await sql().end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
