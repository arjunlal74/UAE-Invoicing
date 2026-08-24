# UAE FTA E-Invoicing Middleware

A multi-tenant platform that sits between a UAE business and the Federal Tax
Authority's e-invoicing network, in **both directions**.

**Module 1 — Outbound sales (AR).** Takes the invoices a tenant issues, from an
Excel upload, an ERP connector or the in-app builder; validates them against UAE
tax rules; converts them to UAE PINT / UBL 2.1 XML; transmits them through an
Accredited Service Provider to the FTA; and then tracks what the *buyer* says
about them, up to and including the corrective credit note that settles a
dispute.

**Module 2 — Inbound purchases (AP).** Receives the cleared invoices a tenant's
suppliers send them, matches each one to a purchase order, and lets the accounts
payable desk accept, query or reject it — returning a signed Peppol response to
the supplier and releasing the input tax for claim.

The product is the bit in the middle. On the way out: a merchant uploads or
types the invoice, sees exactly which cells are wrong and why, fixes them, and
files only what is clean. On the way in: a supplier's bill arrives already
cleared, and the only open question is whether the buyer agrees with it.

Everything is archived immutably for the statutory retention period.

---

## Quick start

```bash
node scripts/generate-secrets.mjs   # creates .env with real secrets
docker compose up -d --build
docker compose exec -e NODE_ENV=development api \
  node node_modules/tsx/dist/cli.mjs src/db/seed.ts
```

Then open **http://localhost:8080**.

Every seeded account uses the password `123`.

| Account | Role | What it shows |
|---|---|---|
| `admin@platform.local` | Host Global Admin | Admin panel — tenants, provider config, transmissions, audit |
| `clerk@albahar.local` | Accountant | An **active** merchant: upload, fix, send for approval |
| `finance@albahar.local` | Tax Approver / CFO | The approvals queue — the only role that can file with the FTA |
| `auditor@albahar.local` | Compliance Auditor | Read-only view of the same merchant |
| `admin@gulftech.local` | Company Admin | A **pending** merchant: can upload, cannot submit |
| `partner@gulfadvisory.local` | Channel Partner Admin | Partner portal — onboard and manage sub-tenants |

To see the outbound flow: sign in as the **accountant** → **Outbound (AR)** →
**Upload invoices** → download the template → fill in a few rows (make some
mistakes) → upload → fix the red cells → **Send for approval**. Then sign in as
the **tax approver** and release the batch from **Approvals**.

To see it composed by hand instead: **Outbound (AR)** → **New invoice**, pick a
customer from the directory, add lines, **Validate**, **Submit**.

To see the inbound flow: **Inbound (AP)** → **Verification desk** → **Receive
XML**, paste a supplier's UBL invoice, then accept, query or reject it.

### The two modules (SRS v2.7 §1.2)

`invoices.direction` is the discriminator: `OUTBOUND_SALES_AR` for documents the
tenant files, `INBOUND_PURCHASE_AP` for documents their suppliers filed against
them. One table rather than two, because they are the same shape with the arrow
reversed — but every list, count and report is scoped by it, and a purchase
invoice's number lives in the *supplier's* series, so uniqueness is per
direction.

| | Outbound (AR) | Inbound (AP) |
|---|---|---|
| Directory | Customers (§6) | Suppliers (§12.1) |
| Ingestion | Excel, REST/ERP, in-app builders (§1.3) | Peppol/ASP webhook, manual XML (§12.1) |
| Authoring | Invoice builder (380/388, §7) and credit note builder (381, §8) | — |
| Clearance | We file it with the FTA (§10) | It arrived already cleared |
| Verdict | The **buyer** accepts, queries or rejects it (§11) | **We** accept, query or reject it (§12.3) |
| Correction | We issue a credit note referencing it (§8.2) | We ask the supplier for one |
| Gate | Only the CFO may file (§16) | Only the CFO may accept for payment (§16) |
| Metering | 1 unit on clearance (§15) | Free to receive; 1 unit to post to the ERP |

Both directions share one Peppol Invoice Response engine: the codes a buyer
sends us about a sales invoice are the same codes our AP desk sends a supplier
about a purchase invoice, and `invoice_responses` logs both.

### Roles and tenancy (SRS v2.1, extended by v2.7 §16)

Four tenancy tiers: the host, direct **enterprise tenants**, **channel
partners**, and the **managed sub-tenants** that hang off a partner. Six roles,
whose capabilities live in one file — `packages/contracts/src/permissions.ts` —
which both the API guards and the portal's navigation read.

The rule that shapes the workflow: **only a Tax Approver / CFO may file with the
FTA.** An accountant's submission parks the invoices in
`PENDING_CFO_APPROVAL`; the approver releases them, or returns them with a
reason, which withdraws them and reopens the staged rows for correction.

v2.7 gives that rule a mirror on the inbound side. An accountant may review a
supplier's bill and put it under query or reject it, but **accepting one
releases it for payment**, so acceptance sits with the CFO alongside filing.
Both desks are otherwise open to the accountant, and the company administrator
maintains the two directories.

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
pnpm --filter @uae/domain test   # 43 — VAT maths, validation rules, auto-fix, credit note reversal
pnpm --filter @uae/ubl test      # 30 — UBL 2.1 generation and reading, ApplicationResponse, QR payload
pnpm --filter @uae/api test      # 28 — Excel round trip, the §16 permission matrix
pnpm --filter @uae/portal test   # 11 — staging grid and error sidebar
```

The AP reader is tested against documents the AR builder generated, rather than
against a fixture: anything the two disagree about is a real defect in one of
them, and the two halves of the platform have to be able to read each other.

End-to-end, against a running stack — 103 checks covering the whole journey:

```bash
cd apps/api && node scripts/e2e.mjs              # local (:3100)
cd apps/api && API_URL=http://localhost:8080 node scripts/e2e.mjs   # containers
```

It is safe to run repeatedly against the same database: invoice numbers and the
onboarded sub-tenant's TRN are per-run, and the assertions name the rows they
care about rather than assuming the tenant has nothing else in it.

## Architecture

```
        MODULE 1 — OUTBOUND (AR)                MODULE 2 — INBOUND (AP)

  .xlsx / REST / in-app builder                  supplier's ASP
             │                                          │
             ▼                                          ▼
   portal (React SPA) ──► api (Fastify)         signed webhook ──► api
             │              │ archives (WORM)                       │ parses UBL
             │              │ enqueues                              │ resolves supplier
             ▼              ▼                                       │ archives (WORM)
      staging grid ◄──► worker                                      ▼
                            │ validates                    verification desk
                            ▼                                       │
              UBL 2.1 XML → WORM → ASP → FTA                        │ accept / query / reject
                            │                                       ▼
                            ▼                             ApplicationResponse
                  clearance verdict + IRN                     → ASP → supplier
                            │
                            ▼
                  buyer's ApplicationResponse
                            │  (RE / UQ opens a dispute)
                            ▼
                   credit note builder (381)
                            │
                            ▼
                  cleared → dispute closed
```

| Piece | What it is |
|---|---|
| `apps/portal` | React + Vite SPA. Merchant (AR/AP/reports), partner and admin panels, separated by role. |
| `apps/api` | Fastify API. Also runs as the queue worker from `src/worker.ts`. |
| `packages/domain` | Code lists, VAT maths, the reversal engine, the validation rule catalogue, auto-fix. |
| `packages/ubl` | PINT-AE UBL 2.1 builder, the inbound invoice reader, the Peppol ApplicationResponse, the QR payload. |
| `packages/contracts` | Zod schemas shared by the API and the portal. |

Inside `apps/api/src/modules`, the v2.7 additions are `ar/` (the two in-app
builders and the dispute desk), `ap/` (reception and the verification desk),
`directories/` (both master directories), `responses/` (the bidirectional IMR
engine), `reports/` (§13 analytics) and `metering/` (§15 data bundles).

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
  direction, invoice_number)` plus a stable idempotency key per submission:
  filing the same invoice twice is a penalty for the merchant, not merely a bug.
  Uniqueness is per direction because a purchase invoice's number belongs to the
  *supplier's* numbering series and may legitimately collide with one of ours.
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

**ERP connectors (§10.1).** The connector catalogue — SAP, Oracle/NetSuite,
Dynamics, Tally, Zoho, QuickBooks — is not built; the SRS itself lists them as
separately monetisable modules. `ingestion_source` names them so a document
records which one produced it, and the §10.6 reverse push marks a cleared
document `erp_reverse_sync_status = PENDING`, but nothing drains that queue
until there is an ERP on the other end of it. A document composed in the browser
is marked `NOT_APPLICABLE` rather than left pending forever.

**§10.5 FTA outage notification.** BullMQ carries the retry and dead-letter
behaviour the SRS describes, but the automated incident notification to the FTA
within two business days is not built: it needs a notification channel the FTA
has not published, and guessing at one would produce a compliance control that
silently does nothing.

**Purchase order matching (§12.2)** matches on the PO reference the supplier put
on their invoice, because that is the only key both parties genuinely share.
There is no purchase-order table — orders live in the tenant's ERP — so the desk
records and surfaces the linkage rather than verifying it against an order this
system does not hold. Bills with no reference at all are put on hold and
flagged.

## Deviations from the SRS

| SRS says | Built | Why |
|---|---|---|
| RabbitMQ / Kafka, 500 inv/sec | BullMQ + Redis | That target assumes ERP connectors, which v1 does not have. The job interface is narrow enough to swap. |
| `UNIQUE (tenant_id, is_active)` on ASP configs | Partial unique index over active rows | The SRS constraint also caps a tenant at one *inactive* config, so provider history is impossible and a second switch fails. |
| Streaming Excel parse | Buffered `xlsx.load()` | ExcelJS's streaming reader fails non-deterministically (measured 6 failures in 8 identical runs). Memory is bounded by the upload and row caps instead. |
| v2.3 §11 names `users.failed_login_attempts` | `users.failed_logins` | The column predates v2.3 and does the same job. §4.4, which is the normative text for lockout, names only `is_locked` and `locked_until` — both built as specified. |
| v2.3 §3.2 "salted bcrypt/Argon2" | Argon2id throughout | Argon2id is the stronger of the two the SRS offers, and was already in place. |
| v2.3 §5 templates quote a fixed platform name | `PLATFORM_NAME` / `SUPPORT_EMAIL` config | The templates are written with `[Middleware Platform Name]` placeholders precisely because this is a white-label product. |
| v2.3 §4.1 rate limits, storage unspecified | Redis counters, failing open | An hour-old counter has no value in Postgres. If Redis is down the cap lapses rather than locking every customer out of account recovery. |
| v2.7 §17 `customers.trn` nullable for all | Nullable, but a `B2B` customer must have one | A B2B buyer without a TRN cannot be issued a 380 at all, so the omission is only ever discovered at filing time. The check pairs the two fields that decide the document type. |
| v2.7 §17 `UNIQUE (tenant_id, customer_code)` | Partial unique index over non-null codes | The code is optional, and a plain `UNIQUE` admits unlimited NULL rows while still reporting a uniqueness failure when a real value collides. Same for supplier codes and both TRNs. |
| v2.7 §8 credit note as UBL Type 381 | Emitted as an `Invoice` root with `InvoiceTypeCode 381` | The SRS's own XPaths assume it: §8.2 maps the preceding-document link to `/Invoice/cac:BillingReference/…`, not to a `CreditNote` root. |
| v2.7 §12.3 "Reject (RE)" open to the AP desk | Rejecting and querying are, accepting is not | §16 reserves "authorize AP payments" to the tax approver, and accepting a bill is what releases it for payment. An accountant flags it instead. |

## Authentication and credential lifecycle

Implements SRS v2.3 §3–§5.

**Password policy** (§3.2) lives in `packages/contracts/src/password.ts` so the
API enforces and the portal displays the same rules: at least 8 characters (12
recommended) with upper case, lower case, a digit and a symbol. Secrets are
Argon2id and the last three are remembered and refused (§4.2).

**Every activation vector expires in 24 hours** (§3.2). Invitations and reset
links share one `auth_tokens` table keyed by purpose, stored as SHA-256 hashes,
single-use, and a newly issued reset link invalidates any earlier one.

**Recovery** (§4.1) is at `/forgot-password`. The response is identical whether
the address exists, is deactivated, or the caller has exhausted their three
requests an hour — the differences are recorded in the log, not in the answer.

**Lockout** (§4.4): five failures inside a fifteen-minute window locks the
account for thirty minutes and sends an alert carrying a reset link, because
resetting is the specified way out of a lock. The window matters — without it a
counter that never resets eventually locks out anyone who mistypes occasionally.

**Forced rotation** (§4.3) is a flag an administrator sets; they can never see
or choose a password. The gate is enforced in the API, not just the portal: a
held session is refused every route but `me`, `refresh`, `logout` and
`change-password`, with code `PASSWORD_ROTATION_REQUIRED`.

**Templates** (§5) A/B/C/D are in `apps/api/src/mail/templates.ts`. A and B are
genuinely different messages: a direct tenant is told the platform provisioned
their account, a managed sub-tenant is told their accountant did and is pointed
at that accountant for help.

Change your own password at **/security**, available to every signed-in role.

## Outgoing mail

Invitations are e-mailed when an outgoing account is configured, and fall back
to the copy-the-link behaviour when one is not — the link is always returned to
the administrator as well, because mail can be delayed or filtered.

Configure it at **Admin → Mail → Add account**. The wizard asks for a name,
address and password and works the server out: it matches known providers,
falls back to the domain's MX records, then tries the conventional hostnames,
confirming each guess by actually signing in. **Manual setup** takes the host,
port, encryption and credentials directly, for a relay that DNS cannot lead it
to.

The stack ships a local inbox so the whole flow can be exercised without a real
mailbox and without any message escaping to a real address:

| Field | Value |
|---|---|
| Outgoing server | `mailpit` (containers) or `localhost` (local dev) |
| Port | 1025 |
| Encryption | None |
| Authentication | Off |

Read what it captures at **http://localhost:8025**.

The SMTP password is encrypted at rest with the same AES-256-GCM key as ASP
credentials, and never leaves the API — the portal is told only whether a
password is set.

### Templates

`apps/api/src/mail/templates.ts` implements SRS §5. Templates A–D concern a
person and their own account; the rest concern a *desk* and a document with a
deadline, so they lead with what happened and end with the one action that
resolves it.

| | Sent when | Action it offers |
|---|---|---|
| A / B | A tenant, partner or managed sub-tenant is provisioned | Set a password (24 hours) |
| C / D | Password reset requested, then changed | Reset link; security confirmation |
| Lockout | Five failed sign-ins | Self-service unlock |
| **E** (§5.5) | A buyer returns `RE` or `UQ` against a cleared sales invoice | Opens the credit note builder with the invoice already loaded — §8.2's one-click path |
| **F** (§5.6) | A supplier's invoice lands in the AP desk | Opens the verification desk on that bill |
| Quota (§15) | A data bundle crosses 80%, 90% or 100% | Usage and balance |

E and F go to everyone on the relevant desk; the quota alert goes only to the
company administrator and the tax approver, because an accountant cannot buy
more capacity and telling them only adds noise to an inbox that already has a
filing deadline in it. A dispute alert is sent when a dispute *opens*, not on
every response, so a buyer who queries twice does not generate two identical
mails.

## Ports

| Service | Container stack | Local development |
|---|---|---|
| Portal | 8080 | 5173 |
| API | via portal `/api` | 3100 |
| Postgres | internal | 5442 |
| Redis | internal | 6389 |
| MinIO console | 9001 | 9001 |
| Mailpit (dev inbox) | 8025 | 8025 |

Non-default host ports are deliberate — 5432, 6379 and 3000 are usually already
taken on a developer machine.
