# 04 — System, Backend (Go), Frontend, Deployment Architecture

## H. System architecture

```
                         Web / Mobile (PWA)
                                │ HTTPS
                      Cloudflare CDN + WAF
                                │
                          Load Balancer
                                │
        ┌───────────────────────┴───────────────────────┐
        │  web (Next.js SSR)          api (Go, Gin) × N │
        └───────────────────────┬───────────────────────┘
                 sync           │            async
          ┌────────────────────┴──────────────────┐
          ▼                                       ▼
   PostgreSQL 16 (primary)                 Redis (cache, sessions,
     └─▶ read replica (reports)             rate limit, locks, Asynq queue)
                                                  │
                                          Go workers (cmd/worker)
                                                  │
                    ┌─────────────────────────────┼──────────────────────┐
                    ▼                             ▼                      ▼
            Object storage (S3/R2)     External: SMS · Email ·    pdf-render
                                       WhatsApp · Payments        sidecar (Chromium)
```

**Synchronous** (never queued): login, get/list anything, mark attendance, record a payment, enter marks, view fees. A parent tapping "Pay" must get an answer, not a job ID.
**Asynchronous** (queued): emails, SMS, WhatsApp, push, PDF generation, report cards in bulk, Excel/CSV exports, bulk imports, payment reconciliation, scheduled jobs (overdue fee sweep, offer-lapse, fee reminders, backup verification).

One Go module, one image, two entrypoints (`cmd/api`, `cmd/worker`) — same config, same migrations, no drift between request and background behaviour. Asynq's built-in scheduler runs the cron jobs, so there is no third binary.

## J. Backend architecture (Go)

```
school-erp/
├── cmd/
│   ├── api/main.go              # Gin server
│   └── worker/main.go           # Asynq consumers + scheduler
├── internal/                    # domain modules — each owns handlers, services,
│   ├── identity/                #   repositories, models, validation, authorization,
│   ├── tenancy/                 #   events, tests
│   ├── auth/
│   ├── users/
│   ├── organizations/
│   ├── schools/
│   ├── campuses/
│   ├── students/
│   ├── guardians/
│   ├── admissions/
│   ├── academics/
│   ├── attendance/
│   ├── leave/
│   ├── examinations/
│   ├── reportcards/
│   ├── fees/
│   ├── payments/
│   ├── accounting/
│   ├── hr/
│   ├── payroll/
│   ├── library/
│   ├── transport/
│   ├── hostel/
│   ├── inventory/
│   ├── procurement/
│   ├── assets/
│   ├── notifications/
│   ├── documents/
│   ├── reports/
│   ├── audit/
│   └── settings/
├── pkg/                         # infrastructure, no school domain knowledge
│   ├── database/                # pgxpool, tx helper, RLS session binding
│   ├── auth/                    # argon2id, sessions, tokens, MFA, OIDC
│   ├── rbac/                    # permission registry, policy + scope engine
│   ├── httpx/                   # middleware chain, error mapping, pagination, envelope
│   ├── storage/                 # S3 port + adapter, signed URLs, MIME/AV policy
│   ├── cache/                   # Redis client, keyspaces, locks
│   ├── queue/                   # Asynq client, task registry, retries, DLQ, outbox relay
│   ├── email/  sms/  whatsapp/  push/
│   ├── payments/                # gateway port + razorpay/, cashfree/ adapters
│   ├── pdf/                     # template registry + renderer client
│   ├── i18n/  money/  ids/  validate/
│   └── observability/           # slog, OTel, Prometheus, request IDs
├── migrations/                  # goose, forward-only
├── queries/                     # sqlc .sql sources, one file per domain
├── api/openapi.yaml             # contract → Go server types + TS client
├── tests/                       # integration, authz matrix, E2E fixtures, load (k6)
├── deployments/{docker,k8s}/
├── scripts/
├── Dockerfile · docker-compose.yml · go.mod · README.md
```

**Module discipline** (what keeps a monolith from rotting): a module may import `pkg/*` and another module's exported *interface*, never its repository or its tables. Cross-domain writes go through a service interface or an outbox event. A CI check on the import graph fails the build when someone reaches around a boundary — that rule is the entire reason services can be extracted later without a rewrite.

**The request pipeline** (order matters):

```
requestID → panic recover → structured log → CORS → security headers → body limit
→ rate limit (redis, per IP + per user + per route class)
→ authenticate (session cookie → user)
→ resolve tenant context (org/school/campus/academic year from membership + header)
→ bind RLS: SET LOCAL app.org_id / app.school_id on the tx connection
→ authorize: RequirePermission("attendance.mark") + policy scope check on the object
→ validate request DTO
→ handler → service (opens tx) → repo (sqlc) + audit write + outbox event → commit
→ response envelope
```

**Transaction rule:** services own transactions, repositories never do. The audit row and the outbox event are written inside the same `tx` as the business change — if the change survives, so does its record of who did it.

```go
// shape of every mutating service method
func (s *Service) CorrectAttendance(ctx context.Context, in CorrectInput) (Record, error) {
    return db.InTx(ctx, s.pool, func(tx db.Tx) (Record, error) {
        rec, err := s.repo.GetRecordForUpdate(ctx, tx, in.RecordID)   // row lock
        if err != nil { return Record{}, err }
        if err := s.policy.CanCorrect(ctx, actor.From(ctx), rec); err != nil { return Record{}, err }
        if rec.Locked { return Record{}, erp.Conflict("ATTENDANCE_LOCKED", "...") }
        out, err := s.repo.ApplyCorrection(ctx, tx, rec, in)
        if err != nil { return Record{}, err }
        s.audit.Write(ctx, tx, audit.Entry{Action: "attendance.correct", Before: rec, After: out, Reason: in.Reason})
        s.events.Publish(ctx, tx, events.AttendanceCorrected{...})
        return out, nil
    })
}
```

**Errors:** one `erp.Error{Code, Message, HTTPStatus, Details, cause}` type. Handlers map it to
`{"error":{"code":"EXAM_LOCKED","message":"...","details":{...},"requestId":"..."}}`.
`cause` is logged, never serialized. Unknown errors become `INTERNAL_ERROR` with a request ID the user can quote to support.

**API conventions:** `/api/v1/...`, cursor pagination (`?cursor=&limit=`) for large lists, offset only where a table needs page numbers, `?filter[status]=`, `?sort=-created_at`, `Idempotency-Key` header required on payments and bulk commits, `ETag`/`If-Match` on marks and settings to prevent lost updates.

**Concurrency where Go pays off:** bulk report-card generation and bulk imports fan out over a bounded worker pool with `errgroup`; result-day read traffic is served from a Redis-cached, precomputed payload; attendance submission bursts are absorbed by short transactions and a per-section advisory lock rather than a queue.

**Queue design (Asynq).** Named queues with weights so a 50k-row import never starves a fee receipt: `critical` (payment/receipt/OTP, weight 6) · `default` (notifications, PDFs, weight 3) · `bulk` (imports, exports, report-card runs, weight 1). Every task is idempotent and keyed, retries use exponential backoff with a cap, exhausted tasks land in an archive that is alerted on and replayable from the admin UI. Transactionally-critical enqueues go through the `outbox_events` relay described in doc 01; fire-and-forget work enqueues directly.

**Search.** Postgres first, deliberately: a `tsvector` column maintained by trigger plus `pg_trgm` on names, admission numbers, and phone numbers covers global search for a single school of any realistic size, and — critically — it can join to the tenancy and scope tables so results are authorization-filtered *in the query* rather than filtered after the fact. OpenSearch enters only when cross-org search or document full-text search makes Postgres hurt, and the search port exists from day one so that swap is one adapter.

## I. Frontend architecture

- **Route groups:** `(auth)`, `(app)/[schoolSlug]/...`, `(portal)` for parent/student, `(admin)` for super admin. Tenant + academic year live in the URL, not hidden state — a link a principal pastes to a coordinator opens the same thing.
- **Data:** TanStack Query over a generated, fully typed API client. Server state is never copied into global state; only UI state (sidebar, theme, palette) uses a small store.
- **Permission-aware UI:** the session payload carries the resolved permission set; a `<Can perm="fees.refund">` guard hides actions. This is UX, not security — the server checks again, always.
- **Every route implements six states:** loading (skeleton matching the final layout), success, empty (with the action that fills it), error (retry + request ID), unauthorized (redirect to login), forbidden (explains which role is needed, no dead end).
- **Component layers:** primitives (`Button`, `Input`, `Select`, `Combobox`, `Dialog`, `Drawer`, `Table`) → patterns (`DataTable`, `FormSection`, `PageHeader`, `FilterBar`, `EntityDrawer`) → features. Business logic never lives in a primitive.
- **DataTable** is one component used everywhere: server-driven sorting/filtering/pagination, column visibility + resize, row selection with bulk actions, saved views per user, keyboard row navigation, async export hand-off, and a card layout on mobile instead of a horizontally scrolling table.
- **Forms:** react-hook-form + Zod schemas generated from the same OpenAPI contract, so client and server validate the same shape. Multi-step forms (admission, enrollment, payroll run) persist a draft server-side.
- **Performance:** RSC for read-heavy pages, route-level code splitting, virtualised rows past 200, prefetch on hover, optimistic attendance marking with rollback.

## K. Security architecture

| Layer | Control |
|---|---|
| Transport | TLS 1.3, HSTS preload, secure cookies (`httpOnly`, `SameSite=Lax`, `__Host-` prefix) |
| AuthN | Argon2id (tuned params), server-side sessions in Redis + rotating refresh, device list with revoke, progressive lockout + per-IP and per-account rate limits, TOTP MFA (schema day 1, enforced by flag), phone+OTP for parents, OIDC/OAuth2 for schools on Google Workspace, password reset via single-use expiring token, no user enumeration in any response |
| AuthZ | Three gates (tenant → grant → scope), deny by default, every endpoint declares its permission in code, a test asserts no route is registered without one |
| Tenant isolation | Postgres RLS on every tenant table + app guard + a cross-tenant test suite that runs every endpoint as a foreign tenant and asserts 404/403 |
| Injection | sqlc parameterised queries only; a lint rule bans raw string-built SQL |
| XSS | React escaping, no `dangerouslySetInnerHTML` outside the sanitised rich-text renderer, strict CSP with nonces |
| CSRF | Cookie auth + `SameSite=Lax` + double-submit token on state-changing requests |
| Uploads | Size caps per purpose, MIME sniffing (not extension trust), extension allowlist, random object keys, private buckets, short-lived signed URLs, AV scan hook before a file becomes downloadable, images re-encoded to strip EXIF |
| Secrets | Env/secret manager only; nothing in the repo; startup fails loudly if a required secret is missing |
| Encryption | TLS in transit, disk encryption at rest, plus **column-level encryption for restricted fields** (government identifiers, bank details, health notes) via envelope encryption with a KMS key |
| Rate limiting | Tiered: auth endpoints strictest, public admission forms next, authenticated APIs generous, exports throttled per user |
| Audit | Append-only partitioned table, `REVOKE UPDATE, DELETE`, restricted-data **reads** audited too |
| Output | Never return stack traces, driver errors, or internal IDs beyond opaque UUIDs; PII redacted from logs by a slog handler |
| Supply chain | `govulncheck`, `gosec`, dependabot, pinned base images, SBOM on release |

## L. Deployment architecture

**Environments:** dev (docker compose: postgres, redis, minio, mailhog, chromium) → staging (prod-shaped, anonymised data) → production.

```
GitHub Actions:  lint (golangci-lint, eslint) → unit → integration (testcontainers) →
                 openapi diff check → import-boundary check → build image → scan →
                 deploy staging → smoke + E2E (Playwright) → manual gate →
                 deploy production (blue/green)
```

**Orchestration:** Docker Compose on a couple of well-sized VMs is the deployment target until real scale demands otherwise — it fits Indian SaaS cost reality and a two-person ops rotation. `deployments/k8s/` holds manifests kept honest from day one so the move is a deployment change, not a re-architecture. The trigger for Kubernetes is concrete: more than ~4 app nodes, or multi-region, or per-tenant isolation requirements — not a vague feeling of scale.

- **Migrations** run as a pre-deploy job, forward-only, expand→migrate→contract so old and new pods can run simultaneously during rollout. No migration ever blocks on a long table rewrite without a documented plan.
- **Rollback:** image rollback is always safe because migrations are backwards-compatible for one release.
- **Health:** `/healthz` (liveness), `/readyz` (db + redis + storage), `/metrics` (Prometheus).
- **Scaling path:** start with 2 api instances + 1 worker + Postgres + Redis behind the LB. Scale api on p95 latency, workers on queue depth, then add a read replica for reports and analytics. Splitting a domain into its own service happens only when a measured bottleneck names it — never preemptively.
- **Connection pooling** via pgbouncer in transaction mode (note: this constrains session-level state, so RLS uses `SET LOCAL` inside the transaction — deliberate).
- **Backups:** continuous WAL archiving + PITR (35-day window), nightly base backup, object-storage versioning + cross-region replication, **quarterly restore drill that is the only thing that makes a backup real**, documented RPO 5 min / RTO 1 hour.
- **Observability:** OpenTelemetry traces across api→db→worker, `slog` JSON logs with request ID and tenant ID on every line, RED metrics per route, business metrics (collection today, attendance submission rate, queue lag, webhook failures), alerts on error rate, p95 latency, queue depth, failed payments, and auth-failure spikes.

## M. Testing strategy

| Layer | Tool | What it covers | Gate |
|---|---|---|---|
| Unit | Go stdlib + testify | Fee calculation, grade computation, rank, promotion rules, timetable conflicts, payment allocation, leave balance | Table-driven; money and grading at 100% branch |
| Integration | testcontainers-go + real Postgres | Repositories, transactions, RLS, constraints, triggers, sequences under concurrency | Every service |
| API | httptest against the wired app | Every endpoint: happy path, validation, 404, conflict, pagination | Contract-tested against OpenAPI |
| **Authorization** | dedicated suite | For every endpoint × every role: allowed / forbidden. Plus cross-tenant access returns nothing. **CI fails if a new route has no authz test.** | Non-negotiable |
| E2E | Playwright | Admission→enrollment, attendance→correction→approval, marks→verify→publish→report card, fee→payment→receipt→refund, parent sees only own child, teacher sees only own class | Pre-prod gate |
| Load | k6 | 100k students seeded; 500 concurrent attendance submissions; result publication for 2,000 students; admission opening-day burst; bulk marks upload | Documented baselines, tracked per release |
| Security | gosec, govulncheck, ZAP baseline | Static + dynamic | Every PR / nightly |

Concurrency correctness is tested explicitly: two simultaneous payments against one invoice, two teachers submitting the same attendance session, parallel receipt-number allocation, double bed allocation. These are the bugs that cost a school real money.

## Frontend/backend contract & code generation

`api/openapi.yaml` → `oapi-codegen` (Go server interfaces + request/response types) and `openapi-typescript` + a thin fetch client (TS). A CI job fails the build if handlers and spec diverge. This kills the entire class of "the frontend expected `student_id`, the API sends `studentId`" bugs.
