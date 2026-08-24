import {
  DirectorySearchQuery,
  UpsertCustomerRequest,
  UpsertSupplierRequest,
  type CustomerSummary,
  type SupplierSummary,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withTenant, type Tx } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * The two master directories (SRS v2.7 §6 and §12.1).
 *
 * One file for both because they are the same screen with the arrow reversed:
 * a tenant-scoped party list, searched the same way, with the same TRN rules
 * and the same "is anyone still trading with them" roll-up. What differs is the
 * handful of fields that only make sense when you are the one paying (bank
 * details, payment terms) or the one being paid (B2B/B2C, which decides whether
 * the document is a 380 or a 388).
 */

interface CustomerRow {
  id: string;
  customer_code: string | null;
  customer_name_en: string;
  customer_name_ar: string | null;
  customer_type: CustomerSummary['customerType'];
  trn: string | null;
  emirate: string;
  street_address: string;
  building: string | null;
  postal_code: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  default_payment_means: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: Date;
  invoice_count: string;
  open_disputes: string;
}

interface SupplierRow {
  id: string;
  supplier_code: string | null;
  supplier_name_en: string;
  supplier_name_ar: string | null;
  trn: string | null;
  emirate: string;
  street_address: string;
  postal_code: string | null;
  bank_name: string | null;
  bank_iban: string | null;
  payment_terms_days: number;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  is_provisional: boolean;
  is_active: boolean;
  created_at: Date;
  invoice_count: string;
  rejected_count: string;
}

function toCustomer(row: CustomerRow): CustomerSummary {
  return {
    id: row.id,
    customerCode: row.customer_code,
    customerNameEn: row.customer_name_en,
    customerNameAr: row.customer_name_ar,
    customerType: row.customer_type,
    trn: row.trn,
    emirate: row.emirate,
    streetAddress: row.street_address,
    building: row.building,
    postalCode: row.postal_code,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    defaultPaymentMeans: row.default_payment_means,
    notes: row.notes,
    isActive: row.is_active,
    invoiceCount: Number(row.invoice_count),
    openDisputes: Number(row.open_disputes),
    createdAt: row.created_at.toISOString(),
  };
}

function toSupplier(row: SupplierRow): SupplierSummary {
  return {
    id: row.id,
    supplierCode: row.supplier_code,
    supplierNameEn: row.supplier_name_en,
    supplierNameAr: row.supplier_name_ar,
    trn: row.trn,
    emirate: row.emirate,
    streetAddress: row.street_address,
    postalCode: row.postal_code,
    bankName: row.bank_name,
    bankIban: row.bank_iban,
    paymentTermsDays: row.payment_terms_days,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    notes: row.notes,
    isProvisional: row.is_provisional,
    isActive: row.is_active,
    invoiceCount: Number(row.invoice_count),
    rejectedCount: Number(row.rejected_count),
    createdAt: row.created_at.toISOString(),
  };
}

/** Empty string from a form field means "not set", not "set to empty". */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function registerDirectoryRoutes(app: FastifyInstance) {
  // =========================================================================
  // §6 Customer Master Directory (Module 1 — AR)
  // =========================================================================

  app.get(
    '/api/v1/customers',
    { preHandler: requirePermission('directory.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const query = DirectorySearchQuery.parse(request.query);
      const offset = (query.page - 1) * query.pageSize;

      const result = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<CustomerRow[]>`
          SELECT c.*,
                 (SELECT count(*) FROM invoices i
                   WHERE i.customer_id = c.id
                     AND i.direction = 'OUTBOUND_SALES_AR')::text AS invoice_count,
                 (SELECT count(*) FROM invoices i
                   WHERE i.customer_id = c.id
                     AND i.is_commercial_dispute
                     AND NOT i.dispute_resolved)::text AS open_disputes
          FROM customers c
          WHERE c.tenant_id = ${ctx.tenantId}
            AND (${query.includeInactive} OR c.is_active)
            AND (${query.q ?? null}::text IS NULL OR
                 to_tsvector('simple',
                   coalesce(c.customer_name_en, '') || ' ' || coalesce(c.customer_name_ar, '') ||
                   ' ' || coalesce(c.trn, '') || ' ' || coalesce(c.customer_code, '')
                 ) @@ plainto_tsquery('simple', ${query.q ?? ''})
                 OR c.customer_name_en ILIKE ${'%' + (query.q ?? '') + '%'}
                 OR c.trn LIKE ${(query.q ?? '') + '%'})
          ORDER BY c.customer_name_en
          LIMIT ${query.pageSize} OFFSET ${offset}
        `;

        const counted = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM customers c
          WHERE c.tenant_id = ${ctx.tenantId}
            AND (${query.includeInactive} OR c.is_active)
            AND (${query.q ?? null}::text IS NULL OR
                 to_tsvector('simple',
                   coalesce(c.customer_name_en, '') || ' ' || coalesce(c.customer_name_ar, '') ||
                   ' ' || coalesce(c.trn, '') || ' ' || coalesce(c.customer_code, '')
                 ) @@ plainto_tsquery('simple', ${query.q ?? ''})
                 OR c.customer_name_en ILIKE ${'%' + (query.q ?? '') + '%'}
                 OR c.trn LIKE ${(query.q ?? '') + '%'})
        `;

        return { rows, total: Number(counted[0]!.count) };
      });

      return reply.send({
        items: result.rows.map(toCustomer),
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
      });
    },
  );

  app.get(
    '/api/v1/customers/:id',
    { preHandler: requirePermission('directory.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const rows = await withTenant(
        ctx.tenantId,
        (tx) => tx<CustomerRow[]>`
          SELECT c.*, '0'::text AS invoice_count, '0'::text AS open_disputes
          FROM customers c WHERE c.id = ${id}
        `,
      );
      if (!rows[0]) throw notFound('Customer');
      return reply.send(toCustomer(rows[0]));
    },
  );

  app.post(
    '/api/v1/customers',
    { preHandler: requirePermission('directory.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = UpsertCustomerRequest.parse(request.body);

      const created = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          INSERT INTO customers (
            tenant_id, customer_code, customer_name_en, customer_name_ar, customer_type,
            trn, emirate, street_address, building, postal_code,
            contact_name, contact_email, contact_phone, default_payment_means, notes, is_active
          ) VALUES (
            ${ctx.tenantId}, ${body.customerCode}, ${body.customerNameEn}, ${body.customerNameAr},
            ${body.customerType}::party_type, ${body.trn ?? null}, ${body.emirate},
            ${body.streetAddress}, ${body.building}, ${body.postalCode},
            ${body.contactName}, ${blankToNull(body.contactEmail)}, ${body.contactPhone},
            ${body.defaultPaymentMeans}, ${body.notes}, ${body.isActive}
          )
          RETURNING id
        `;
        return rows[0]!.id;
      });

      await audit(actorFromContext(ctx), {
        action: 'CUSTOMER_CREATED',
        resourceType: 'CUSTOMER',
        resourceId: created,
        tenantId: ctx.tenantId,
        changes: { name: body.customerNameEn, trn: body.trn ?? null, type: body.customerType },
      });

      return reply.status(201).send({ id: created });
    },
  );

  app.put(
    '/api/v1/customers/:id',
    { preHandler: requirePermission('directory.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = UpsertCustomerRequest.parse(request.body);

      const changes = await withTenant(ctx.tenantId, async (tx) => {
        const before = await tx<CustomerRow[]>`SELECT * FROM customers WHERE id = ${id}`;
        if (!before[0]) throw notFound('Customer');

        // A TRN that has already been filed against is part of the audit record
        // of those invoices. Changing it would silently re-attribute them.
        if (before[0].trn && body.trn && before[0].trn !== body.trn) {
          const filed = await tx<{ count: string }[]>`
            SELECT count(*)::text AS count FROM invoices
            WHERE customer_id = ${id} AND status <> 'DRAFT'
          `;
          if (Number(filed[0]!.count) > 0) {
            throw badRequest(
              'This customer already has filed invoices under their current TRN. Deactivate this record and create a new one rather than changing it.',
            );
          }
        }

        await tx`
          UPDATE customers SET
            customer_code = ${body.customerCode},
            customer_name_en = ${body.customerNameEn},
            customer_name_ar = ${body.customerNameAr},
            customer_type = ${body.customerType}::party_type,
            trn = ${body.trn ?? null},
            emirate = ${body.emirate},
            street_address = ${body.streetAddress},
            building = ${body.building},
            postal_code = ${body.postalCode},
            contact_name = ${body.contactName},
            contact_email = ${blankToNull(body.contactEmail)},
            contact_phone = ${body.contactPhone},
            default_payment_means = ${body.defaultPaymentMeans},
            notes = ${body.notes},
            is_active = ${body.isActive}
          WHERE id = ${id}
        `;

        return { from: before[0].customer_name_en, to: body.customerNameEn };
      });

      await audit(actorFromContext(ctx), {
        action: 'CUSTOMER_UPDATED',
        resourceType: 'CUSTOMER',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes,
      });

      return reply.send({ id });
    },
  );

  // Deactivation rather than deletion. A customer named on a filed invoice is
  // part of a tax record that has to survive for 5–15 years (§19).
  app.delete(
    '/api/v1/customers/:id',
    { preHandler: requirePermission('directory.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          UPDATE customers SET is_active = FALSE WHERE id = ${id} RETURNING id
        `;
        if (!rows[0]) throw notFound('Customer');
      });

      await audit(actorFromContext(ctx), {
        action: 'CUSTOMER_DEACTIVATED',
        resourceType: 'CUSTOMER',
        resourceId: id,
        tenantId: ctx.tenantId,
      });

      return reply.status(204).send();
    },
  );

  // =========================================================================
  // §12.1 Supplier Master Directory (Module 2 — AP)
  // =========================================================================

  app.get(
    '/api/v1/suppliers',
    { preHandler: requirePermission('directory.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const query = DirectorySearchQuery.parse(request.query);
      const offset = (query.page - 1) * query.pageSize;

      const result = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<SupplierRow[]>`
          SELECT s.*,
                 (SELECT count(*) FROM invoices i
                   WHERE i.supplier_id = s.id
                     AND i.direction = 'INBOUND_PURCHASE_AP')::text AS invoice_count,
                 (SELECT count(*) FROM invoices i
                   WHERE i.supplier_id = s.id
                     AND i.latest_response_code = 'RE')::text AS rejected_count
          FROM suppliers s
          WHERE s.tenant_id = ${ctx.tenantId}
            AND (${query.includeInactive} OR s.is_active)
            AND (${query.q ?? null}::text IS NULL OR
                 to_tsvector('simple',
                   coalesce(s.supplier_name_en, '') || ' ' || coalesce(s.supplier_name_ar, '') ||
                   ' ' || coalesce(s.trn, '') || ' ' || coalesce(s.supplier_code, '')
                 ) @@ plainto_tsquery('simple', ${query.q ?? ''})
                 OR s.supplier_name_en ILIKE ${'%' + (query.q ?? '') + '%'}
                 OR s.trn LIKE ${(query.q ?? '') + '%'})
          -- Provisional suppliers first: they are the ones with a decision
          -- waiting on them.
          ORDER BY s.is_provisional DESC, s.supplier_name_en
          LIMIT ${query.pageSize} OFFSET ${offset}
        `;

        const counted = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM suppliers s
          WHERE s.tenant_id = ${ctx.tenantId}
            AND (${query.includeInactive} OR s.is_active)
            AND (${query.q ?? null}::text IS NULL OR
                 to_tsvector('simple',
                   coalesce(s.supplier_name_en, '') || ' ' || coalesce(s.supplier_name_ar, '') ||
                   ' ' || coalesce(s.trn, '') || ' ' || coalesce(s.supplier_code, '')
                 ) @@ plainto_tsquery('simple', ${query.q ?? ''})
                 OR s.supplier_name_en ILIKE ${'%' + (query.q ?? '') + '%'}
                 OR s.trn LIKE ${(query.q ?? '') + '%'})
        `;

        return { rows, total: Number(counted[0]!.count) };
      });

      return reply.send({
        items: result.rows.map(toSupplier),
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
      });
    },
  );

  app.post(
    '/api/v1/suppliers',
    { preHandler: requirePermission('directory.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = UpsertSupplierRequest.parse(request.body);

      const created = await withTenant(ctx.tenantId, (tx) =>
        insertSupplier(tx, ctx.tenantId!, body, false),
      );

      await audit(actorFromContext(ctx), {
        action: 'SUPPLIER_CREATED',
        resourceType: 'SUPPLIER',
        resourceId: created,
        tenantId: ctx.tenantId,
        changes: { name: body.supplierNameEn, trn: body.trn ?? null },
      });

      return reply.status(201).send({ id: created });
    },
  );

  app.put(
    '/api/v1/suppliers/:id',
    { preHandler: requirePermission('directory.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = UpsertSupplierRequest.parse(request.body);

      await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          UPDATE suppliers SET
            supplier_code = ${body.supplierCode},
            supplier_name_en = ${body.supplierNameEn},
            supplier_name_ar = ${body.supplierNameAr},
            trn = ${body.trn ?? null},
            emirate = ${body.emirate},
            street_address = ${body.streetAddress},
            postal_code = ${body.postalCode},
            bank_name = ${body.bankName},
            bank_iban = ${body.bankIban},
            payment_terms_days = ${body.paymentTermsDays},
            contact_name = ${body.contactName},
            contact_email = ${blankToNull(body.contactEmail)},
            contact_phone = ${body.contactPhone},
            notes = ${body.notes},
            is_active = ${body.isActive},
            -- Editing an auto-created record IS the vetting step §12.1 asks
            -- for: a human has now looked at it and confirmed the details.
            is_provisional = FALSE
          WHERE id = ${id}
          RETURNING id
        `;
        if (!rows[0]) throw notFound('Supplier');
      });

      await audit(actorFromContext(ctx), {
        action: 'SUPPLIER_UPDATED',
        resourceType: 'SUPPLIER',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes: { name: body.supplierNameEn },
      });

      return reply.send({ id });
    },
  );

  app.delete(
    '/api/v1/suppliers/:id',
    { preHandler: requirePermission('directory.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          UPDATE suppliers SET is_active = FALSE WHERE id = ${id} RETURNING id
        `;
        if (!rows[0]) throw notFound('Supplier');
      });

      await audit(actorFromContext(ctx), {
        action: 'SUPPLIER_DEACTIVATED',
        resourceType: 'SUPPLIER',
        resourceId: id,
        tenantId: ctx.tenantId,
      });

      return reply.status(204).send();
    },
  );
}

async function insertSupplier(
  tx: Tx,
  tenantId: string,
  body: {
    supplierCode: string | null;
    supplierNameEn: string;
    supplierNameAr: string | null;
    trn?: string | null;
    emirate: string;
    streetAddress: string;
    postalCode: string | null;
    bankName: string | null;
    bankIban: string | null;
    paymentTermsDays: number;
    contactName: string | null;
    contactEmail?: string | null;
    contactPhone: string | null;
    notes: string | null;
    isActive: boolean;
  },
  isProvisional: boolean,
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO suppliers (
      tenant_id, supplier_code, supplier_name_en, supplier_name_ar, trn, emirate,
      street_address, postal_code, bank_name, bank_iban, payment_terms_days,
      contact_name, contact_email, contact_phone, notes, is_provisional, is_active
    ) VALUES (
      ${tenantId}, ${body.supplierCode}, ${body.supplierNameEn}, ${body.supplierNameAr},
      ${body.trn ?? null}, ${body.emirate}, ${body.streetAddress}, ${body.postalCode},
      ${body.bankName}, ${body.bankIban}, ${body.paymentTermsDays},
      ${body.contactName}, ${blankToNull(body.contactEmail)}, ${body.contactPhone},
      ${body.notes}, ${isProvisional}, ${body.isActive}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * §12.1 "New Supplier Detected".
 *
 * An inbound purchase invoice arrives from a TRN we have no record of. The bill
 * is still received — refusing it would strand a legitimate supplier behind our
 * own data entry backlog — but the vendor record it creates is flagged
 * provisional until someone confirms the details.
 */
export async function resolveOrCreateSupplier(
  tx: Tx,
  tenantId: string,
  party: {
    trn: string | null;
    nameEn: string;
    emirate: string | null;
    street: string | null;
    postalCode: string | null;
    contactEmail: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  if (party.trn) {
    const existing = await tx<{ id: string }[]>`
      SELECT id FROM suppliers WHERE tenant_id = ${tenantId} AND trn = ${party.trn}
    `;
    if (existing[0]) return { id: existing[0].id, created: false };
  } else {
    // No TRN to match on, so fall back to the legal name. Exact match only —
    // fuzzy matching two suppliers into one would misattribute input tax.
    const existing = await tx<{ id: string }[]>`
      SELECT id FROM suppliers
      WHERE tenant_id = ${tenantId} AND lower(supplier_name_en) = lower(${party.nameEn})
      LIMIT 1
    `;
    if (existing[0]) return { id: existing[0].id, created: false };
  }

  const id = await insertSupplier(
    tx,
    tenantId,
    {
      supplierCode: null,
      supplierNameEn: party.nameEn,
      supplierNameAr: null,
      trn: party.trn,
      emirate: party.emirate || 'Dubai',
      streetAddress: party.street ?? '',
      postalCode: party.postalCode,
      bankName: null,
      bankIban: null,
      paymentTermsDays: 30,
      contactName: null,
      contactEmail: party.contactEmail,
      contactPhone: null,
      notes: 'Created automatically from an inbound purchase invoice.',
      isActive: true,
    },
    true,
  );

  return { id, created: true };
}
