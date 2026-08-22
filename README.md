# UAE FTA E-Invoicing Middleware

A multi-tenant platform that takes invoices from UAE businesses as **Excel
uploads**, validates them against UAE tax rules, converts them to UAE PINT /
UBL 2.1 XML, transmits them through an Accredited Service Provider (ASP) to the
Federal Tax Authority, and archives everything immutably for the statutory
retention period.

The product is the bit in the middle: a merchant uploads the spreadsheet they
already have, sees exactly which cells are wrong and why, fixes them in the
browser, and submits only what is clean.

---

## Quick start

```bash
node scripts/generate-secrets.mjs   # creates .env with real secrets
docker compose up -d --build
docker compose exec -e NODE_ENV=development api \
  node node_modules/tsx/dist/cli.mjs src/db/seed.ts
```

Then open **http://localhost:8080**.

Every seeded account uses the password `ChangeMe_Dev_2026!`.

| Account | Role | What it shows |
|---|---|---|
| `admin@platform.local` | Host Global Admin | Admin panel — tenants, provider config, transmissions, audit |
| `clerk@albahar.local` | Accountant | An **active** merchant: upload, fix, send for approval |
| `finance@albahar.local` | Tax Approver / CFO | The approvals queue — the only role that can file with the FTA |
| `auditor@albahar.local` | Compliance Auditor | Read-only view of the same merchant |
| `admin@gulftech.local` | Company Admin | A **pending** merchant: can upload, cannot submit |
| `partner@gulfadvisory.local` | Channel Partner Admin | Partner portal — onboard and manage sub-tenants |

To see the whole flow: sign in as the **accountant** → **Upload invoices** →
download the template → fill in a few rows (make some mistakes) → upload → fix
the red cells → **Send for approval**. Then sign in as the **tax approver** and
release the batch from **Approvals**.

### Roles and tenancy (SRS v2.1)

Four tenancy tiers: the host, direct **enterprise tenants**, **channel
partners**, and the **managed sub-tenants** that hang off a partner. Six roles,
whose capabilities live in one file — `packages/contracts/src/permissions.ts` —
which both the API guards and the portal's navigation read.

The rule that shapes the workflow: **only a Tax Approver / CFO may file with the
FTA.** An accountant's submission parks the invoices in
`PENDING_CFO_APPROVAL`; the approver releases them, or returns them with a
reason, which withdraws them and reopens the staged rows for correction.

## Development

The container rebuild loop is slow. For day-to-day work run only the
infrastructure and start the apps from your shell:

```bash
docker compose -f docker-compose.infra.yml up -d
pnpm install
pnpm --filter @uae/api db:migrate
pnpm --filter @uae/api db:seed

pnpm --filter @uae/api dev          # API      → :3100
pnpm --filter @uae/api dev:worker   # worker
pnpm --filter @uae/portal dev       # portal   → :5173
```

On Windows, `scripts/restart-dev.ps1` does all of this in one step
(`-Reset` wipes the database first). Use it rather than killing processes by
hand: `pkill` does not match tsx's Windows command line, so a stale API keeps
serving while a "restarted" one silently fails to bind — and then tests pass or
fail against code that is not on disk.

### Tests

```bash
pnpm --filter @uae/domain test   # 30 — VAT maths, validation rules, auto-fix
pnpm --filter @uae/ubl test      # 14 — UBL 2.1 generation, QR payload
pnpm --filter @uae/api test      # 15 — Excel template/parser round trip
pnpm --filter @uae/portal test   # 11 — staging grid and error sidebar
```

End-to-end, against a running stack — 70 checks covering the whole journey:

```bash
cd apps/api && node scripts/e2e.mjs              # local (:3100)
cd apps/api && API_URL=http://localhost:8080 node scripts/e2e.mjs   # containers
```

## Architecture

```
Merchant's .xlsx
      │
      ▼
  portal (React SPA, nginx)  ──►  api (Fastify)
                                    │  archives the original file (WORM)
                                    │  enqueues a parse job
                                    ▼
                                 worker
                                    │  parses, validates, stages
                                    ▼
                            staging grid ◄──► merchant fixes cells
                                    │
                                    ▼  (one job per invoice)
                              UBL 2.1 XML → WORM archive → ASP → FTA
                                    │
                                    ▼
                        clearance verdict (webhook, or polled)
```

| Piece | What it is |
|---|---|
| `apps/portal` | React + Vite SPA. Merchant, partner and admin panels, separated by role. |
| `apps/api` | Fastify API. Also runs as the queue worker from `src/worker.ts`. |
| `packages/domain` | Code lists, VAT maths, the validation rule catalogue, auto-fix. |
| `packages/ubl` | PINT-AE UBL 2.1 document builder and the QR payload. |
| `packages/contracts` | Zod schemas shared by the API and the portal. |

**Why the maths lives in a shared package:** the staging grid recalculates
totals in the browser as the user types, while the worker recalculates them
authoritatively before generating XML. Two implementations would eventually
disagree by a hundredth of a dirham and produce invoices the FTA rejects on its
arithmetic rule. There is one implementation, imported by both.

## Security and compliance

- **Tenant isolation is enforced by PostgreSQL**, not by remembering to add
  `WHERE tenant_id = ?`. Every tenant-scoped table has `FORCE ROW LEVEL
  SECURITY`, and the app connects as a non-owner role so the policies actually
  apply. Access goes through `withTenant()` / `withPlatformAccess()`.
- **The audit trail is append-only by privilege** — `UPDATE` and `DELETE` are
  revoked from the application role, so it cannot rewrite its own history.
- **Duplicate filing is prevented by the database.** `UNIQUE (tenant_id,
  invoice_number)` plus a stable idempotency key per submission: filing the same
  invoice twice is a penalty for the merchant, not merely a bug.
- **Archives are immutable.** Original workbooks, generated XML and signed
  receipts go to object storage with Object Lock in COMPLIANCE mode. The XML is
  archived *before* transmission, so we can never have filed something we cannot
  produce in an audit.
- **ASP credentials are encrypted** (AES-256-GCM) and never returned by the API
  — the admin screen shows only whether they exist.
- **Webhooks are HMAC-verified**, de-duplicated by delivery id, and cannot move
  an invoice out of a terminal state.
- Argon2id passwords, TOTP second factor, rotating refresh tokens.

## What is deliberately not built

**No ASP has been selected.** This is the single largest open item and it has a
contractual lead time.

- `MockAspDriver` carries the full pipeline end to end — two-stage lifecycle,
  realistic rejections, transient failures, HMAC-signed callbacks — so
  everything downstream is built and tested. It never leaves the deployment.
- `GenericRestAspDriver` is written against the SRS's *illustrative* contracts,
  not any real vendor's documentation. Three things must be reconciled with a
  provider's actual API before it works: authentication, payload envelope, and
  the status vocabulary (`mapStatus`). All three are marked in the file.
- Each merchant must also be **registered with the provider** — that is why
  onboarding leaves a tenant `PENDING` and why `PENDING_REGISTRATION` exists.

**Schematron.** The FTA publishes its rules as Schematron; those files were not
available. The 30 rules in `packages/domain/src/validation` are hand-implemented
against the real `BR-UAE-*` vocabulary, so swapping in official Schematron
changes where findings come from, not how they are stored, displayed, or mapped
back to spreadsheet cells.

**QR payload.** The TLV construction in `packages/ubl/src/qr.ts` follows the
regional convention. It must be reconciled with the FTA's published QR
specification before production.

**Phase 2 (native AS4 / Peppol).** Not implemented. The driver registration
exists and reports that clearly rather than failing obscurely.

## Deviations from the SRS

| SRS says | Built | Why |
|---|---|---|
| RabbitMQ / Kafka, 500 inv/sec | BullMQ + Redis | That target assumes ERP connectors, which v1 does not have. The job interface is narrow enough to swap. |
| `UNIQUE (tenant_id, is_active)` on ASP configs | Partial unique index over active rows | The SRS constraint also caps a tenant at one *inactive* config, so provider history is impossible and a second switch fails. |
| Streaming Excel parse | Buffered `xlsx.load()` | ExcelJS's streaming reader fails non-deterministically (measured 6 failures in 8 identical runs). Memory is bounded by the upload and row caps instead. |

## Ports

| Service | Container stack | Local development |
|---|---|---|
| Portal | 8080 | 5173 |
| API | via portal `/api` | 3100 |
| Postgres | internal | 5442 |
| Redis | internal | 6389 |
| MinIO console | 9001 | 9001 |

Non-default host ports are deliberate — 5432, 6379 and 3000 are usually already
taken on a developer machine.
