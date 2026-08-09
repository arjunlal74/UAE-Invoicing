# Build state

Working notes for the in-progress build. Delete once the system is complete.

## Decisions already made (do not relitigate)

- **v1 scope**: Excel/CSV upload only. No ERP connectors, no REST ingestion, no SFTP.
- **Stack**: pnpm workspaces + Turborepo; Fastify (not NestJS) + `postgres.js` with
  hand-written SQL (not an ORM); React + Vite portal. Nest's DI and Drizzle were both
  dropped in favour of fewer moving parts — the adapter pattern the SRS asks for needs a
  registry, not a container, and the SRS hands us raw DDL.
- **Deployables**: `apps/api` runs as two processes (`main.ts` HTTP, `worker.ts` queue)
  from one image; `apps/portal` is one SPA serving both merchant and admin panels,
  separated by role.
- **Grid**: TanStack Virtual + a purpose-built grid. AG Grid Enterprise was never
  approved, so no paid dependency.
- **ASP**: no provider chosen. `MockAspDriver` carries the full pipeline;
  `GenericRestAspDriver` is written against the SRS's illustrative contracts and must be
  reconciled with a real vendor's docs before use.
- **Schematron**: FTA rule files not in hand. Rules are hand-implemented in
  `packages/domain/src/validation` against the real `BR-UAE-*` code vocabulary.
- **Excel parsing**: buffered `xlsx.load()`, NOT the streaming reader — see
  `apps/api/src/excel/parse.ts` header comment for why.

## Done

- `packages/domain` — code lists, decimal money, VAT/rounding maths, staged model,
  sheet/cell mapping, 30 rule catalogue, validator, auto-fix. **30 tests pass.**
- `packages/ubl` — PINT-AE UBL 2.1 builder, TLV QR payload. **14 tests pass.**
- `packages/contracts` — zod schemas + enums shared by API and portal. Typechecks.
- `apps/api` foundation — config, logger with redaction, `postgres.js` client with
  `withTenant`/`withPlatformAccess` RLS scoping, migration runner, AES-256-GCM secret
  encryption, error mapping (incl. Postgres constraint translation), argon2 + TOTP +
  rotating refresh tokens, request context/role guards, append-only audit.
- `apps/api/src/db/migrations/0001_init.sql` — full schema, RLS policies, privileges.
  Fixes the SRS's `UNIQUE (tenant_id, is_active)` bug with a partial unique index.
- Tenant, user, ASP-config modules + routes.
- ASP driver interface, mock driver, generic REST driver, Phase-2 AS4 stub.
- Excel template generator + parser. **14 round-trip tests pass.**

## Remaining

1. `apps/api/src/modules/batches` — upload, parse job, batch list.
2. `apps/api/src/modules/staging` — staged rows, cell edit, re-validate, auto-fix, submit.
3. `apps/api/src/modules/invoices` — search, detail, retry.
4. `apps/api/src/modules/dashboard`, `modules/admin`, `modules/templates`,
   `modules/webhooks`.
5. `apps/api/src/worker.ts` + job handlers (parse, submit, poll sweeper).
6. `apps/api/src/db/seed.ts`.
7. `apps/portal` — entire frontend.
8. Dockerfiles, full `docker-compose.yml`, README, end-to-end verification.

`app.ts` already imports every route module listed above, so the API will not boot until
they exist.

## Verify with

```
pnpm install
pnpm --filter @uae/domain test     # 30
pnpm --filter @uae/ubl test        # 14
pnpm --filter @uae/api test        # 14 so far
docker compose -f docker-compose.infra.yml up -d
pnpm db:migrate && pnpm db:seed
```
