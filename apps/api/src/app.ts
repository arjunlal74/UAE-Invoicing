import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/routes.js';
import { config } from './config.js';
import { sql } from './db/client.js';
import { registerErrorHandler } from './lib/errors.js';
import { logger } from './logger.js';
import { registerAdminDashboardRoutes } from './modules/admin/dashboard.js';
import { registerAdminRoutes } from './modules/admin/routes.js';
import { registerPlatformCompanyRoutes } from './modules/admin/company.js';
import { registerApiKeyRoutes } from './modules/apikeys/routes.js';
import { registerApRoutes } from './modules/ap/routes.js';
import { registerArBuilderRoutes } from './modules/ar/builder.js';
import { registerDirectoryRoutes } from './modules/directories/routes.js';
import { registerInventoryRoutes } from './modules/metering/inventoryRoutes.js';
import { registerProviderRoutes } from './modules/metering/providers.js';
import { registerMeteringRoutes } from './modules/metering/routes.js';
import { registerModuleDashboardRoutes } from './modules/dashboard/module.js';
import { registerReportRoutes } from './modules/reports/routes.js';
import { registerApprovalRoutes } from './modules/approvals/routes.js';
import { registerAspRoutes } from './modules/asp/routes.js';
import { registerBatchRoutes } from './modules/batches/routes.js';
import { registerDashboardRoutes } from './modules/dashboard/routes.js';
import { registerIngestionRoutes } from './modules/ingestion/routes.js';
import { registerInvoiceRoutes } from './modules/invoices/routes.js';
import { registerMailRoutes } from './modules/mail/routes.js';
import { registerPartnerCustodyRoutes } from './modules/partners/custody.js';
import { registerPartnerDashboardRoutes } from './modules/partners/dashboard.js';
import { registerPartnerRoutes } from './modules/partners/routes.js';
import { registerPartnerStaffRoutes } from './modules/partners/staff.js';
import { registerStagingRoutes } from './modules/staging/routes.js';
import { registerTemplateRoutes } from './modules/templates/routes.js';
import { registerTenantRoutes } from './modules/tenants/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';
import { registerWebhookRoutes } from './modules/webhooks/routes.js';
import { checkStorage } from './storage/objectStore.js';

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = config();

  const app = Fastify({
    logger: false,
    // Behind a load balancer the client IP is only in X-Forwarded-For, and
    // audit entries recording the balancer's address would be worthless.
    trustProxy: true,
    bodyLimit: cfg.UPLOAD_MAX_BYTES,
  });

  await app.register(cors, {
    origin: cfg.PORTAL_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });

  await app.register(multipart, {
    limits: {
      fileSize: cfg.UPLOAD_MAX_BYTES,
      files: 1,
    },
  });

  registerErrorHandler(app);

  app.addHook('onResponse', async (request, reply) => {
    // Health checks would otherwise dominate the log.
    if (request.url.startsWith('/health')) return;
    logger.debug(
      {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        userId: request.ctx?.userId,
      },
      'request',
    );
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, boolean> = { database: false, storage: false };

    try {
      await sql()`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }

    checks.storage = await checkStorage();

    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks });
  });

  registerAuthRoutes(app);
  registerTenantRoutes(app);
  registerUserRoutes(app);
  registerAspRoutes(app);
  registerTemplateRoutes(app);
  registerBatchRoutes(app);
  registerStagingRoutes(app);
  registerInvoiceRoutes(app);
  // Ingestion channel 1 — the programmatic ERP API (§1.2), and the machine
  // credentials it authenticates with.
  registerIngestionRoutes(app);
  registerApiKeyRoutes(app);
  registerApprovalRoutes(app);
  registerPartnerRoutes(app);
  registerPartnerDashboardRoutes(app);
  registerPartnerCustodyRoutes(app);
  registerPartnerStaffRoutes(app);
  registerDashboardRoutes(app);

  // SRS v2.7 — the two modules. Registered as a block so the split is visible
  // here rather than only in the URL space.
  registerDirectoryRoutes(app);
  registerArBuilderRoutes(app);
  registerApRoutes(app);
  registerReportRoutes(app);
  registerMeteringRoutes(app);
  // v2.8 §15 — the wholesale half of the bundle lifecycle.
  registerInventoryRoutes(app);
  registerProviderRoutes(app);
  registerModuleDashboardRoutes(app);

  registerMailRoutes(app);
  registerAdminRoutes(app);
  registerPlatformCompanyRoutes(app);
  registerAdminDashboardRoutes(app);
  registerWebhookRoutes(app);

  return app;
}
