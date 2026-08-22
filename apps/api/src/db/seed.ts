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
 * Covers every tier of the v2.1 hierarchy and every role, because the ones that
 * are awkward to reach are exactly the ones worth exercising: a merchant that
 * cannot submit yet, an accountant who cannot file, an approver who can, and a
 * channel partner with a sub-tenant hanging off it.
 *
 * Refuses to run against production. Seeded accounts have known passwords.
 */

const DEV_PASSWORD = '123';

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
    // v2.1 collapses the platform tier to a single role, so there is one
    // account here rather than the admin/support pair v1.x seeded.
    await tx`
      INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active)
      VALUES (NULL, 'admin@platform.local', 'Platform Administrator', 'GLOBAL_ADMIN',
              ${passwordHash}, TRUE)
    `;

    // --- Direct enterprise tenant, fully live ------------------------------
    const active = await tx<{ id: string }[]>`
      INSERT INTO tenants (
        tenant_type, company_code, legal_name_en, legal_name_ar, trn, is_vat_group,
        registered_address, status
      ) VALUES (
        'ENTERPRISE_TENANT', 'ALBAHAR', 'Al-Bahar Enterprises LLC',
        'شركة البحار للمقاولات ذ.م.م',
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
      ['admin@albahar.local', 'Fatima Al-Mansoori', 'COMPANY_ADMIN'],
      ['finance@albahar.local', 'Rashid Khan', 'TAX_APPROVER_CFO'],
      ['clerk@albahar.local', 'Priya Nair', 'ACCOUNTANT'],
      ['auditor@albahar.local', 'James Whitfield', 'AUDITOR'],
    ] as const) {
      await tx`
        INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active)
        VALUES (${activeId}, ${email}, ${name}, ${role}::user_role, ${passwordHash}, TRUE)
      `;
    }

    // --- Direct enterprise tenant, still waiting on registration -----------
    const pending = await tx<{ id: string }[]>`
      INSERT INTO tenants (
        tenant_type, company_code, legal_name_en, legal_name_ar, trn, is_vat_group,
        registered_address, status
      ) VALUES (
        'ENTERPRISE_TENANT', 'GULFTECH', 'Gulf Tech Solutions FZE',
        'شركة الخليج للحلول التقنية',
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
      VALUES (${pendingId}, 'admin@gulftech.local', 'Omar Haddad', 'COMPANY_ADMIN',
              ${passwordHash}, TRUE)
    `;

    // --- Channel partner ----------------------------------------------------
    // No TRN: an advisory firm resells capacity, it does not file under its own
    // number. The schema allows that for this tier only.
    const partner = await tx<{ id: string }[]>`
      INSERT INTO tenants (
        tenant_type, company_code, legal_name_en, legal_name_ar, is_vat_group,
        registered_address, status
      ) VALUES (
        'CHANNEL_PARTNER', 'GULFADV', 'Gulf Advisory Partners',
        'شركاء الخليج الاستشاريون', FALSE,
        ${jsonb(tx, {
          street: 'Al Maryah Island',
          city: 'Abu Dhabi',
          emirate: 'Abu Dhabi',
          postalCode: '00000',
          countryCode: 'AE',
        })},
        'ACTIVE'
      )
      RETURNING id
    `;
    const partnerId = partner[0]!.id;

    await tx`
      INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active)
      VALUES (${partnerId}, 'partner@gulfadvisory.local', 'Layla Haddad', 'PARTNER_ADMIN',
              ${passwordHash}, TRUE)
    `;

    // --- Managed sub-tenant under that partner ------------------------------
    const subTenant = await tx<{ id: string }[]>`
      INSERT INTO tenants (
        tenant_type, parent_tenant_id, company_code, legal_name_en, legal_name_ar,
        trn, is_vat_group, registered_address, status
      ) VALUES (
        'MANAGED_SUB_TENANT', ${partnerId}, 'DESERTLOG', 'Desert Logistics LLC',
        'الصحراء للخدمات اللوجستية ذ.م.م',
        '100583920100003', FALSE,
        ${jsonb(tx, {
          street: 'Jebel Ali Industrial Area',
          city: 'Dubai',
          emirate: 'Dubai',
          postalCode: '00000',
          countryCode: 'AE',
        })},
        'ACTIVE'
      )
      RETURNING id
    `;
    const subTenantId = subTenant[0]!.id;

    await tx`
      INSERT INTO tenant_asp_configs (
        tenant_id, provider_type, display_name, api_endpoint,
        credentials_cipher, webhook_secret_hash, provider_account_id, status, notes
      ) VALUES (
        ${subTenantId}, 'MOCK', 'Simulated Accredited Provider', '',
        ${encryptSecret(JSON.stringify({ apiKey: 'mock-api-key', webhookSecret }))},
        ${sha256Hex(webhookSecret)},
        'MOCK-ACCT-0002', 'ACTIVE',
        'Simulated provider, shared settings with the partner book.'
      )
    `;

    for (const [email, name, role] of [
      ['admin@desertlog.local', 'Yusuf Rahman', 'COMPANY_ADMIN'],
      ['cfo@desertlog.local', 'Aisha Belhoul', 'TAX_APPROVER_CFO'],
    ] as const) {
      await tx`
        INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active)
        VALUES (${subTenantId}, ${email}, ${name}, ${role}::user_role, ${passwordHash}, TRUE)
      `;
    }

    logger.info({ activeId, pendingId, partnerId, subTenantId }, 'seed data created');
  });

  const banner = `
────────────────────────────────────────────────────────────────────
  Seed complete. All accounts use the password: ${DEV_PASSWORD}

  HOST GLOBAL ADMIN    admin@platform.local

  Al-Bahar Enterprises — enterprise tenant, ACTIVE
    COMPANY ADMIN      admin@albahar.local
    TAX APPROVER/CFO   finance@albahar.local     (the only one who can file)
    ACCOUNTANT         clerk@albahar.local       (prepares, cannot file)
    AUDITOR            auditor@albahar.local

  Gulf Tech Solutions — enterprise tenant, PENDING (upload only)
    COMPANY ADMIN      admin@gulftech.local

  Gulf Advisory Partners — channel partner
    PARTNER ADMIN      partner@gulfadvisory.local

  Desert Logistics — managed sub-tenant of Gulf Advisory, ACTIVE
    COMPANY ADMIN      admin@desertlog.local
    TAX APPROVER/CFO   cfo@desertlog.local

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
