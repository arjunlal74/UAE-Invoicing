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
| Ingestion | Excel, REST API (§1.2 ch. 1), in-app builders (§1.3) | Peppol/ASP webhook, manual XML (§12.1) |
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
pnpm --filter @uae/api test      # 78 — Excel round trip, the §16 permission matrix,
                                 #      PDF rendering, API key credentials and scopes,
                                 #      SFTP claim / stability / recovery semantics,
                                 #      the §15 inventory formulas
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

And two more over ingestion channel 1 — the REST half (key minting and scope
limits, idempotent replay, validation vocabulary, the §16 approval gate,
revocation) and the SFTP half (upload stability, claim-by-rename, partial
success, duplicate refusal, receipts, and revocation closing the directory):

```bash
pnpm --filter @uae/api e2e:ingest    # REST
pnpm --filter @uae/api e2e:sftp      # SFTP — needs the `sftp` container; one run at a time
```

And one over the §15 bundle inventory — wholesale procurement, the stock guard,
the three balances moving independently, partner slicing and the §15.5 floors:

```bash
pnpm --filter @uae/api e2e:inventory
pnpm --filter @uae/api inventory:sweep   # run the buffer check now, not in an hour
```

All of them are safe to run repeatedly against the same database: invoice numbers and
the onboarded sub-tenant's TRN are per-run, and the assertions name the rows
they care about rather than assuming the tenant has nothing else in it.

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

**ERP connectors (§10.1).** The generic REST API an ERP posts to *is* built —
see "The programmatic API" below. What is not built is the connector catalogue
that sits on top of it: SAP, Oracle/NetSuite, Dynamics, Tally, Zoho, QuickBooks,
each of which is a piece of software living inside somebody else's system, and
which the SRS itself lists as separately monetisable modules. `ingestion_source`
names them so a document records which one produced it.

The §10.6 reverse push marks a cleared document `erp_reverse_sync_status =
PENDING`, but nothing drains that queue until there is an ERP on the other end
of it. A document composed in the browser is marked `NOT_APPLICABLE` rather than
left pending forever; one that arrived over the API is marked `PENDING`, because
there genuinely is a row in a ledger somewhere waiting to hear the verdict.

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
| v2.8 §17 adds a `tenant_bundle_allocations` table | Columns added to `data_bundles` | Same grain, same parent/slice relationship, same foreign keys and policies. A second table would hold the same rows twice and need every constraint rebuilt on it. |
| v2.8 §17 `GENERATED ALWAYS AS` balance columns | Computed in the query | A stored balance is a number that can disagree with its own history. At this cardinality — contracts and bundles, not invoices — the aggregate is free. |
| v2.8 §15.5 names one threshold per tier | Threshold plus a severity split at half of it | An account at 40% of its floor is a reorder prompt; one at 4% is about to stop filing, and the subject line should not be the same. |
| v2.8 §17 `asp_bundle_procurements.asp_provider_name` free text | `asp_provider_id` into an `asp_providers` master | Two spellings of one company are two providers to a cost report, which is the report the column exists for. |
| v2.8 §17 stores `cost_per_unit_aed` and `total_cost_aed` as given | Total stored as given, rate derived from it | A contract is quoted as a lump sum. Multiplying a rounded rate back out loses fils on odd unit counts, so the platform's spend would disagree with the provider's invoice. |

## Data bundle inventory (SRS v2.8 §15)

v2.7 metered the retail half of this: a tenant holds a prepaid bundle, a channel
partner carves slices out of a master pool, and clearing an invoice deducts from
both. What it never modelled is where the host's units come from — so a platform
administrator could sell a hundred thousand units the platform had never bought,
and the first anyone would know was a provider refusing to clear a tax document.
An inventory that only counts what leaves is not an inventory.

**The supply chain, closed.** A wholesale purchase from an accredited provider
is registered with its contract reference, unit count and cost; bundles are then
sold out of that stock. `POST /api/v1/billing/bundles` now refuses to issue more
than the shelf holds. A partner's slice is exempt from that check — those units
left the host when the partner bought its master pool, and deducting them again
would make one sale cost the host twice.

**Providers are a master, not a text field.** §15.1 has the host typing a
provider name onto each contract. Two contracts keyed "Accredited ASP UAE" and
"accredited asp uae" are then two providers as far as any cost report is
concerned, which defeats the point of recording the cost — so `asp_providers`
holds them, with the MoF accreditation reference, a billing contact and a usual
rate that pre-fills a new contract. Names collide case-insensitively. Nothing is
deleted: a provider that has sold the platform units is part of the record of
where its capacity came from, so retiring one takes it out of the picker and
leaves its contracts legible.

This is procurement-side only. `tenant_asp_configs` records which provider
*routes* a given tenant's invoices — a per-tenant connection with credentials
and an endpoint — which is a different question from who the host buys units
from, even when the answer is the same company.

**The total is what the provider invoiced; the rate is derived.** A wholesale
contract is quoted as a lump sum — "1,000,000 units for AED 85,000" — and it is
the total that has to survive. Storing a four-decimal rate as the source of
truth and multiplying back loses money on any unit count that does not divide
evenly: 999,999 units at a rate rounded to 0.0850 comes back as AED 84,999.92,
and the platform's spend would then disagree with the provider's own invoice.
The form accepts either figure and fills in the other; the server stores the
total as given, derives the rate, and refuses a stated rate that contradicts the
total rather than silently picking one.

**Three balances, and they are not interchangeable.** The formulas in §15.1–15.4
read alike in prose and answer different questions:

| Figure | Formula | The question it answers |
|---|---|---|
| Current stock | opening + purchases − sold/allocated | What is left to sell |
| Net available | opening + purchases − consumed | What is left to file against |
| Partner unallocated | opening + master purchases − slices carved | Whether another sub-tenant can be onboarded |
| Partner net | master purchases − sub-tenant consumption | Whether its clients can keep filing |

A platform can be out of stock while 90% of its capacity is unused, and it can
have plenty to sell while five thousand units from a standstill. Picking the
wrong formula gives a number that is plausible, stable and wrong, which is the
worst way for an inventory to fail — hence
`apps/api/src/modules/metering/__tests__/inventory.test.ts`.

**Floors, not percentages.** v2.7 warns at 80/90/100% of a bundle. §15.5 adds an
absolute floor per account, because a tenant filing four thousand invoices a
month does not care that 80% of a bundle is gone; it cares that fewer than two
thousand units remain, because that is a week. The tenant sets its own — only
the person filing knows whether two thousand units is a fortnight or an
afternoon — and the host sets the platform's.

A breach sends **Template G** (§5.7) to whoever can act on it: global admins for
the host tier, the partner for a sub-tenant's slice, the company admin and tax
approver for a direct tenant. It carries the 30-day run rate, so the mail says
"about four days" rather than "1,420 units". Announced once, re-armed when the
balance climbs back over the line.

Evaluated by an hourly sweep rather than at the point of consumption, because a
floor is breached two ways — the balance falls, or somebody raises the threshold
— and only the first passes through `consumeUnits`. It also catches the case
that would otherwise never fire: an account that stops filing entirely sits
below its buffer indefinitely with no further deduction to trigger anything.

**Upgrading an existing deployment.** The host's net balance is procured minus
consumed, so a platform that has been filing invoices without recorded purchases
reads *negative* until its contract history is backfilled. That is the honest
number rather than a bug. Both the host and per-bundle floors therefore default
to zero — alert off — so the first sweep after the migration does not mail
everybody about a shortfall that is really a missing data-entry step.

Exercise the whole chain — provider master, procurement, the stock guard, the
three balances, partner slicing, the floors and retirement — with
`pnpm --filter @uae/api e2e:inventory`.

## The programmatic API

Ingestion channel 1 of SRS §1.2 — how an ERP files invoices without anyone
signing in. Two endpoints, which is the whole surface a sending system needs.

**Credentials.** An ERP has no password to rotate and no second factor to carry,
so it gets an API key instead: `uaeinv_live_<43 chars>`, minted under
*Settings → API keys* by whoever holds `tenant.users.manage`. The platform
stores a SHA-256 of it and shows it exactly once. A key carries an explicit
scope list rather than a role, capped by `API_KEY_SCOPES`, so it can never be
granted `platform.manage`, `tenant.users.manage` or `audit.read` — the three
that would turn a leaked key into a foothold. Requests carrying a key run with
role `API_CLIENT`, which holds no permissions at all, so any permission check
in the codebase that has not been taught about keys refuses one.

```
POST /api/v1/invoices
X-API-Key: uaeinv_live_…
Idempotency-Key: erp-doc-88421

{ "invoiceNumber": "INV-2026-00042",
  "buyer": { "customerCode": "CUST-014" },
  "lines": [{ "description": "Consultancy", "quantity": "10",
              "unitPrice": "500.00", "vatCategory": "S" }] }
```

**Synchronous verdict.** The document is validated inside the request. `201`
means it is legal and on its way; `422` returns *every* finding at once, keyed
to this API's own field names (`lines[0].uom`) rather than to a spreadsheet
cell for a workbook the caller has never seen. There is no draft state — nobody
is coming back to finish it.

**Amounts are computed, not accepted.** Send quantities and unit prices; line
nets, VAT and document totals are derived. A `totals` block may be sent, and is
*checked* rather than used: an exact mismatch is a `422` naming the figure and
what we made it. A one-fils rounding difference does not stay one fils across
ten thousand invoices.

**Idempotency.** `Idempotency-Key` is stored with the whole response, so a
retry after a timeout replays the original outcome — rejections included —
rather than filing a second time. Reusing a key for a different body is a `409`,
because that is a bug in the caller rather than a retry.

**The approval gate still applies.** A key scoped `invoice.submit` files
straight through; one scoped only `invoice.submit_for_approval` parks each
document at `PENDING_CFO_APPROVAL` for a human, exactly as an accountant's
submission does (§16). `holdForApproval: true` lets a filing key opt into the
gate while an integration is being proven.

```
GET /api/v1/invoices/status/{invoiceNumber}
```

Clearance is asynchronous, so the second endpoint exists because the first
cannot tell the caller how the story ends. Keyed by invoice number rather than
by our id: the sending system wrote its own number on its own ledger row and has
never seen our primary keys.

**Attribution.** A machine is not a user. Documents it files carry
`created_by_api_key_id` and a null `created_by_user_id`, and audit rows are
written with `actor_type = 'API_KEY'` naming the key — not the person who
minted it months earlier and was not present.

Run `pnpm --filter @uae/api e2e:ingest` against a running stack to exercise all
of the above.

### Drop directories (SFTP)

The other limb of channel 1, for an ERP that exports files on a schedule rather
than calling an API — which is most of the ones old enough to matter.

**The platform does not run an SSH daemon.** An SFTP endpoint already exists in
every deployment target: `atmoz/sftp` beside the other containers here, AWS
Transfer Family or equivalent in a real one. Owning host keys, cipher
negotiation and a chroot jail would buy nothing the invoicing code needs. What
the platform owns is the half nobody else can do — whose directory this is, what
that party may file, and what happened.

**A drop directory is an API key with a different transport.** Give a key an
`sftpUsername` when you create it, and the same scope list decides whether a
dropped file is filed or only prepared, the audit trail names the same actor,
and revoking the key closes the directory — releasing the account name so a
replacement key can take it.

**Revoking the key is half of it.** There are two credentials here and the
platform owns only one. The API key says what a dropped file may do; the SFTP
account's own password or SSH key says who may drop one, and that lives with
whoever runs the SFTP endpoint. Revoking the key stops the directory being read
— including anything already sitting in the inbox, which is left in place rather
than deleted — but it does not stop someone still holding the SFTP credentials
from writing more. If a credential has leaked, disable the SFTP account too:
otherwise a file written in the meantime is processed the moment a replacement
key takes the account.

```
<SFTP_ROOT>/<username>/
  inbox/        where the ERP puts files
  processing/   claimed by rename — atomic on a POSIX filesystem
  processed/    something was filed, with <file>.receipt.json beside it
  failed/       nothing was filed, with <file>.receipt.json saying why
```

**Two formats, and the asymmetry is deliberate.** `.json` is one document or an
array — the same body the REST endpoint takes — and each is filed on its own, so
a file of two hundred invoices with one bad line does not cost the merchant the
other hundred and ninety-nine. `.xlsx` is the platform's own template and
becomes a batch in the staging grid. JSON is a machine asserting a finished
document; a spreadsheet is a machine handing over something a person still owns.

**Uploads are not atomic.** A file appears at zero bytes and grows, so nothing is
claimed until its size and mtime have held still for `SFTP_STABLE_SECONDS`, and
the temporary names upload clients use (`.filepart`, `.part`, `.tmp`, dotfiles)
are skipped outright. Claiming is a `rename` into `processing/`, which either
moves the file or fails because another worker already did — so the watcher is
safe to run in more than one process. Anything left in `processing/` at startup
was claimed by a worker that died holding it and is returned to the inbox;
re-filing is safe because a byte-identical delivery is refused and an invoice
number already filed cannot be filed twice.

Polling rather than `fs.watch`, because inotify does not cross a network
filesystem and every realistic deployment puts the share on one.

Configuration: `SFTP_ENABLED`, `SFTP_ROOT`, `SFTP_POLL_SECONDS`,
`SFTP_STABLE_SECONDS`, `SFTP_MAX_FILE_BYTES`. The watcher runs in the **worker**,
not the API — the API sits behind a load balancer where every replica would poll
the same share. Exercise it with `pnpm --filter @uae/api e2e:sftp`.

**Still not built:** CSV. The template parser is workbook-only, and a CSV drop
would need a column contract of its own rather than reusing the one merchants
already have.

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
