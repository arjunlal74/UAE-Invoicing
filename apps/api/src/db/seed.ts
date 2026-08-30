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
  // One per tenant. The mock provider signs each callback with the receiving
  // tenant's own secret, so a shared one would hide a signature bug that only
  // shows up against a real provider, where they genuinely differ.
  const albaharWebhookSecret = randomBytes(24).toString('hex');
  const gulftechWebhookSecret = randomBytes(24).toString('hex');
  const desertlogWebhookSecret = randomBytes(24).toString('hex');

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
        ${encryptSecret(JSON.stringify({ apiKey: 'mock-api-key', webhookSecret: albaharWebhookSecret }))},
        ${sha256Hex(albaharWebhookSecret)},
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

    // --- A second live enterprise tenant, so the two can trade -------------
    // It used to be the can't-submit fixture. It is live now because the two
    // enterprise tenants bill each other, and the receiving half of that only
    // works if the buyer can file too — a counterparty that can accept an
    // invoice but never issue one exercises half a trading relationship.
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
        'ACTIVE'
      )
      RETURNING id
    `;
    const pendingId = pending[0]!.id;

    // Its own webhook secret rather than a copy of Al-Bahar's. The mock
    // provider signs each callback with the receiving tenant's secret, so two
    // tenants sharing one would hide a signature bug that only appears when a
    // real provider is connected and the secrets genuinely differ.
    await tx`
      INSERT INTO tenant_asp_configs (
        tenant_id, provider_type, display_name, api_endpoint,
        credentials_cipher, webhook_secret_hash, provider_account_id, status, notes
      ) VALUES (
        ${pendingId}, 'MOCK', 'Simulated Accredited Provider', '',
        ${encryptSecret(JSON.stringify({ apiKey: 'mock-api-key', webhookSecret: gulftechWebhookSecret }))},
        ${sha256Hex(gulftechWebhookSecret)},
        'MOCK-ACCT-0002', 'ACTIVE',
        'Simulated provider. Replace with a real ASP once one is selected.'
      )
    `;

    for (const [email, name, role] of [
      ['admin@gulftech.local', 'Omar Haddad', 'COMPANY_ADMIN'],
      ['finance@gulftech.local', 'Noura Al-Suwaidi', 'TAX_APPROVER_CFO'],
      ['clerk@gulftech.local', 'Daniel Fernandes', 'ACCOUNTANT'],
      ['auditor@gulftech.local', 'Hana Darwish', 'AUDITOR'],
    ] as const) {
      await tx`
        INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active)
        VALUES (${pendingId}, ${email}, ${name}, ${role}::user_role, ${passwordHash}, TRUE)
      `;
    }

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
        ${encryptSecret(JSON.stringify({ apiKey: 'mock-api-key', webhookSecret: desertlogWebhookSecret }))},
        ${sha256Hex(desertlogWebhookSecret)},
        'MOCK-ACCT-0003', 'ACTIVE',
        'Simulated provider. Its own credentials, like every other tenant.'
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

    // ======================================================================
    // SRS v2.7 — the two modules
    // ======================================================================
    // Enough data on the live tenant that both desks are worth opening: buyers
    // to invoice, a supplier whose bill is waiting, and the prepaid capacity
    // that lets any of it be filed.

    // --- §6 Customer Master Directory (AR) --------------------------------
    // Held on to: the seeded invoices below are billed to this one, and an
    // invoice with no customer link cannot be opened in the builder.
    let gulftechCustomerId: string | null = null;

    for (const customer of [
      {
        code: 'CUST-001',
        nameEn: 'Emirates Trading Co',
        nameAr: 'شركة الإمارات للتجارة',
        type: 'B2B',
        trn: '100384759200003',
        emirate: 'Dubai',
        street: 'Al-Maktoum Street, Deira',
        email: 'accounts@emiratestrading.ae',
      },
      {
        code: 'CUST-002',
        nameEn: 'Northern Gulf Contracting LLC',
        nameAr: 'الخليج الشمالي للمقاولات ذ.م.م',
        type: 'B2B',
        trn: '100671928300003',
        emirate: 'Sharjah',
        street: 'Industrial Area 12',
        email: 'ap@northerngulf.ae',
      },
      {
        // The other seeded tenant, so the two can bill each other: Al-Bahar
        // files against this TRN and Gulf Tech receives its own document on
        // the verification desk, which is the only way to exercise a buyer
        // accept/reject against a real cleared invoice rather than a pasted one.
        code: 'CUST-004',
        nameEn: 'Gulf Tech Solutions FZE',
        nameAr: 'شركة الخليج للحلول التقنية',
        type: 'B2B',
        trn: '100492817400003',
        emirate: 'Abu Dhabi',
        street: 'Corniche Road',
        email: 'ap@gulftech.ae',
      },
      {
        code: 'CUST-003',
        nameEn: 'Walk-in retail customer',
        nameAr: null,
        // §6: a B2C party has no TRN, which is what makes their document a 388.
        type: 'B2C',
        trn: null,
        emirate: 'Dubai',
        street: 'Point of sale',
        email: null,
      },
    ] as const) {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO customers (
          tenant_id, customer_code, customer_name_en, customer_name_ar, customer_type,
          trn, emirate, street_address, contact_email, default_payment_means
        ) VALUES (
          ${activeId}, ${customer.code}, ${customer.nameEn}, ${customer.nameAr},
          ${customer.type}::party_type, ${customer.trn}, ${customer.emirate},
          ${customer.street}, ${customer.email}, '30'
        )
        RETURNING id
      `;
      if (customer.code === 'CUST-004') gulftechCustomerId = inserted[0]!.id;
    }

    // The mirror of CUST-004: Gulf Tech bills Al-Bahar back. Gulf Tech is
    // PENDING, so it can compose and validate against this customer but cannot
    // file until its provider registration completes — which is the point, it
    // is the fixture for the blocked-submission path.
    await tx`
      INSERT INTO customers (
        tenant_id, customer_code, customer_name_en, customer_name_ar, customer_type,
        trn, emirate, street_address, contact_email, default_payment_means
      ) VALUES (
        ${pendingId}, 'CUST-001', 'Al-Bahar Enterprises LLC', 'شركة البحار للمقاولات ذ.م.م',
        'B2B'::party_type, '100293847500003', 'Dubai',
        'Sheikh Zayed Road', 'ap@albahar.ae', '30'
      )
    `;

    // --- §12.1 Supplier Master Directory (AP) ------------------------------
    await tx`
      INSERT INTO suppliers (
        tenant_id, supplier_code, supplier_name_en, supplier_name_ar, trn, emirate,
        street_address, bank_name, bank_iban, payment_terms_days, contact_email
      ) VALUES (
        ${activeId}, 'SUP-001', 'Gulf Tech Solutions FZE', 'شركة الخليج للحلول التقنية',
        '100492817400003', 'Abu Dhabi', 'Corniche Road',
        'First Abu Dhabi Bank', 'AE070331234567890123456', 30, 'billing@gulftech.ae'
      )
    `;

    // The other side of SUP-001: Gulf Tech buys from Al-Bahar too, and the
    // purchase invoices below are its bills. The reception path creates a
    // supplier from the document when one arrives over the network; seeding
    // the rows directly means seeding this as well, or the AP desk would show
    // a bill from a company its own directory has never heard of.
    const albaharSupplier = await tx<{ id: string }[]>`
      INSERT INTO suppliers (
        tenant_id, supplier_code, supplier_name_en, supplier_name_ar, trn, emirate,
        street_address, payment_terms_days, contact_email
      ) VALUES (
        ${pendingId}, 'SUP-001', 'Al-Bahar Enterprises LLC', 'شركة البحار للمقاولات ذ.م.م',
        '100293847500003', 'Dubai', 'Sheikh Zayed Road', 30, 'ar@albahar.ae'
      )
      RETURNING id
    `;

    // --- §15 the data bundle supply chain -----------------------------------
    // v2.8 makes this a chain rather than a set of standalone balances, so the
    // seed builds the whole of it: the host buys wholesale from a provider,
    // sells to a direct tenant and to a partner, and the partner carves a slice
    // for its own client. Without the procurement at the top the console would
    // open on a platform that has sold 110,000 units it never bought — which is
    // exactly the state v2.8 exists to make impossible.
    //
    // The accredited list, rather than one invented placeholder.
    //
    // A provider is a master record rather than a name typed onto a contract,
    // so that two purchases from the same company add up in a cost report
    // instead of becoming two providers because somebody spelled it
    // differently. Seeding the real names means the first purchase an operator
    // registers picks from the list they would actually pick from, and the
    // "no accredited provider on file" path is not the first thing they meet.
    //
    // Only the accreditation details that are actually known are filled in.
    // Inventing a reference number for the other five would put five plausible
    // fabrications in front of someone whose job is to check them.
    const providers = await tx<{ id: string; name: string }[]>`
      INSERT INTO asp_providers (name, accreditation_reference, accreditation_from, accreditation_valid_until)
      VALUES
        ('BDO Digital Solutions FZ-LLC', NULL, NULL, NULL),
        ('ComarchFynamics', NULL, NULL, NULL),
        ('EDICOM Middle East Services', NULL, NULL, NULL),
        ('InvoiceNow Biz F.Z.C', '184465', DATE '2026-07-01', DATE '2028-07-01'),
        ('Marmin AI Software Design LLC', NULL, NULL, NULL),
        ('TronStride FZC', NULL, NULL, NULL)
      RETURNING id, name
    `;

    // The wholesale contract has to belong to one of them. Any would do; this
    // is the one the demo data is written around.
    const provider = providers.filter((row) => row.name.startsWith('Marmin'));

    const procurement = await tx<{ id: string }[]>`
      INSERT INTO asp_bundle_procurements (
        asp_provider_id, contract_reference, total_units,
        cost_per_unit_aed, total_cost_aed, purchase_date, notes
      ) VALUES (
        ${provider[0]!.id}, 'MARMIN-2026-001', 500000,
        0.0850, 42500.00, CURRENT_DATE - 30,
        'Opening wholesale purchase. Everything below is sold out of this contract.'
      )
      RETURNING id
    `;
    const procurementId = procurement[0]!.id;

    await tx`
      INSERT INTO data_bundles (
        tenant_id, reference, purchased_units, consumed_units, notes,
        asp_procurement_id, minimum_buffer_units
      ) VALUES (
        ${activeId}, 'BNDL-ALBAHAR-2026', 10000, 0,
        'Annual prepaid capacity sold directly by the host.',
        ${procurementId}, 2000
      )
    `;

    // Metering is a separate gate from registration: without capacity this
    // tenant would be live, connected, and still refused at submission.
    await tx`
      INSERT INTO data_bundles (
        tenant_id, reference, purchased_units, consumed_units, notes,
        asp_procurement_id, minimum_buffer_units
      ) VALUES (
        ${pendingId}, 'BNDL-GULFTECH-2026', 5000, 0,
        'Annual prepaid capacity sold directly by the host.',
        ${procurementId}, 1000
      )
    `;

    const masterBundle = await tx<{ id: string }[]>`
      INSERT INTO data_bundles (
        tenant_id, reference, purchased_units, consumed_units, notes,
        asp_procurement_id, minimum_buffer_units
      ) VALUES (
        ${partnerId}, 'BNDL-GULFADV-MASTER', 100000, 0,
        'Channel partner master pool. Sub-tenant slices are carved from this.',
        ${procurementId}, 10000
      )
      RETURNING id
    `;

    // No procurement link on a slice: these units left the host when the
    // partner bought the master pool, and pointing the slice at the contract
    // as well would have one purchase counted against it twice.
    await tx`
      INSERT INTO data_bundles (
        tenant_id, parent_bundle_id, reference, purchased_units, consumed_units,
        notes, minimum_buffer_units
      ) VALUES (
        ${subTenantId}, ${masterBundle[0]!.id}, 'BNDL-DESERTLOG-2026', 5000, 0,
        'Slice allocated by Gulf Advisory Partners. Consumption is also deducted from their master pool.',
        500
      )
    `;


    // --- Three filed invoices, awaiting the buyer -------------------------
    //
    // Al-Bahar has billed Gulf Tech and the FTA has cleared all three. The
    // buyer has not answered any of them: no response code, no dispute. That
    // is the state the §11 response tiles and the AP verification desk are
    // both written for, and an empty database shows neither.
    //
    // Cleared rather than merely validated, because a document the buyer could
    // act on is one the authority has already passed - anything earlier is
    // still ours to correct, and the buyer has never seen it.
    for (const [offset, number, quantity, unitPrice] of [
      [21, 'INV-2026-00001', 10, '450.00'],
      [14, 'INV-2026-00002', 4, '1250.00'],
      [7, 'INV-2026-00003', 25, '96.00'],
    ] as const) {
      const net = (quantity * Number(unitPrice)).toFixed(2);
      const vat = (Number(net) * 0.05).toFixed(2);
      const gross = (Number(net) + Number(vat)).toFixed(2);

      const invoice = await tx<{ id: string }[]>`
        INSERT INTO invoices (
          tenant_id, customer_id, source_channel, invoice_number, invoice_type,
          issue_date, issue_time, currency_code, exchange_rate,
          seller_trn, seller_name, buyer_trn, buyer_name,
          line_extension_amount, tax_exclusive_amount, vat_total_amount,
          tax_inclusive_amount, payable_amount, payable_amount_aed,
          status, direction, fta_irn, submitted_at, cleared_at
        ) VALUES (
          ${activeId}, ${gulftechCustomerId}, 'MANUAL_IN_APP_ENTRY', ${number}, 'TAX_INVOICE',
          (CURRENT_DATE - ${offset}::integer), '10:00:00', 'AED', 1.000000,
          '100293847500003', 'Al-Bahar Enterprises LLC',
          '100492817400003', 'Gulf Tech Solutions FZE',
          ${net}, ${net}, ${vat}, ${gross}, ${gross}, ${gross},
          'ACCEPTED_BY_FTA', 'OUTBOUND_SALES_AR',
          ${'irn_uae_' + String(offset).padStart(14, '0')},
          (CURRENT_DATE - ${offset}::integer), (CURRENT_DATE - ${offset}::integer)
        )
        RETURNING id
      `;

      await tx`
        INSERT INTO invoice_line_items (
          tenant_id, invoice_id, line_number, item_name, quantity, unit_of_measure,
          unit_price, discount_amount, vat_category, vat_rate, vat_amount,
          net_amount, total_amount
        ) VALUES (
          ${activeId}, ${invoice[0]!.id}, 1, 'Integration services', ${quantity}, 'PCE',
          ${unitPrice}, 0, 'STANDARD', 5.00, ${vat}, ${net}, ${gross}
        )
      `;

      // The buyer's copy. One document, two rows: a sale on the seller's books
      // and a purchase on the buyer's, each owned by the tenant that holds it
      // and each carrying its own posting state. Filing one does not create the
      // other in production either — the network delivers it, and this is that
      // delivery already done.
      const purchase = await tx<{ id: string }[]>`
        INSERT INTO invoices (
          tenant_id, supplier_id, source_channel, invoice_number, invoice_type,
          issue_date, issue_time, currency_code, exchange_rate,
          seller_trn, seller_name, buyer_trn, buyer_name,
          line_extension_amount, tax_exclusive_amount, vat_total_amount,
          tax_inclusive_amount, payable_amount, payable_amount_aed,
          status, direction, fta_irn, ap_posting_status
        ) VALUES (
          ${pendingId}, ${albaharSupplier[0]!.id}, 'INBOUND_PEPPOL_AS4', ${number}, 'TAX_INVOICE',
          (CURRENT_DATE - ${offset}::integer), '10:00:00', 'AED', 1.000000,
          '100293847500003', 'Al-Bahar Enterprises LLC',
          '100492817400003', 'Gulf Tech Solutions FZE',
          ${net}, ${net}, ${vat}, ${gross}, ${gross}, ${gross},
          'ACCEPTED_BY_FTA', 'INBOUND_PURCHASE_AP',
          ${'irn_uae_' + String(offset).padStart(14, '0')},
          'NOT_POSTED'
        )
        RETURNING id
      `;

      await tx`
        INSERT INTO invoice_line_items (
          tenant_id, invoice_id, line_number, item_name, quantity, unit_of_measure,
          unit_price, discount_amount, vat_category, vat_rate, vat_amount,
          net_amount, total_amount
        ) VALUES (
          ${pendingId}, ${purchase[0]!.id}, 1, 'Integration services', ${quantity}, 'PCE',
          ${unitPrice}, 0, 'STANDARD', 5.00, ${vat}, ${net}, ${gross}
        )
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

  Gulf Tech Solutions — enterprise tenant, ACTIVE
    COMPANY ADMIN      admin@gulftech.local
    TAX APPROVER/CFO   finance@gulftech.local    (the only one who can file)
    ACCOUNTANT         clerk@gulftech.local      (prepares, cannot file)
    AUDITOR            auditor@gulftech.local

  Gulf Advisory Partners — channel partner
    PARTNER ADMIN      partner@gulfadvisory.local

  Desert Logistics — managed sub-tenant of Gulf Advisory, ACTIVE
    COMPANY ADMIN      admin@desertlog.local
    TAX APPROVER/CFO   cfo@desertlog.local

  Al-Bahar has 4 customers (AR), 1 supplier (AP) and a 10,000-document bundle;
  Gulf Tech has 5,000. Gulf Advisory holds a 100,000 master pool with a 5,000
  slice carved out for Desert Logistics, so sub-tenant filings deduct from both.

  Al-Bahar has filed 3 invoices to Gulf Tech, cleared by the FTA and not yet
  answered by the buyer. They are on Al-Bahar's sales list and on Gulf Tech's
  verification desk, so the accept/query/reject path can be walked from a
  fresh database.

  Al-Bahar and Gulf Tech are in each other's customer directories, so an
  invoice filed by one is delivered to the other's verification desk and the
  buyer's accept or reject travels back — the whole §11/§12.3 loop, without
  pasting XML by hand.

  Mock provider webhook secrets:
    Al-Bahar          ${albaharWebhookSecret}
    Gulf Tech         ${gulftechWebhookSecret}
    Desert Logistics  ${desertlogWebhookSecret}
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
