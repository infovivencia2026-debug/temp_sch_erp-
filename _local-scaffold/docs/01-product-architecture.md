# 01 — Product Architecture, Module Tree, Personas

## A. Product architecture (10,000 ft)

**Shape: modular monolith, one deployable app + one worker fleet, one PostgreSQL cluster.**

```
Browser (Next.js App Router, RSC + client islands)
   │  HTTPS, session cookie (httpOnly, SameSite=Lax)
   ▼
Edge / CDN  →  WAF  →  Load balancer
   ▼
API tier (Go modular monolith, Gin, cmd/api)
   ├── Request context: { requestId, userId, orgId, schoolId, campusId, academicYearId, permissions[] }
   ├── Domain modules (see module tree) — each = controller + service + repository + policy + events
   ├── Shared kernel: tenancy, rbac, audit, config, i18n, money, dates, ids
   └── Ports: PaymentGateway, SmsSender, EmailSender, WhatsApp, ObjectStorage, Pdf, Search
   ▼
PostgreSQL 16 (primary + read replica)   Redis (cache, sessions, rate limit, locks, queue)
   ▼
Go workers (cmd/worker, Asynq consumers) → S3-compatible object storage
```

**Key architectural commitments**

| Decision | Choice | Why |
|---|---|---|
| Tenancy model | Shared schema, `organization_id` + `school_id` on every tenant row, enforced by Postgres RLS **and** an app-level repository guard | RLS is the backstop that survives a forgotten `WHERE`; app guard gives good errors and works for non-SQL paths |
| Language | **Go 1.23** for all backend + workers | One static binary, trivial ops, predictable memory under the result-day spike, real concurrency for bulk marks/report-card fan-out |
| Domain boundaries | Module = Go package under `internal/modules/<domain>`, exposing an interface; cross-module calls go through that interface or an outbox domain event | Extractable to services later without rewriting callers; `go build` enforces the import graph |
| Write model | Everything through a service in a DB transaction; audit written in the *same* transaction | An audit row that can be lost is not an audit row |
| Money | `numeric(14,2)` in DB, integer paise in app (`Money` value object), never floats | Stripe-level correctness bar |
| Historical data | Append-only enrollment/marks/ledger; no destructive updates on academic or financial history | §10, §23, §70 |
| Config | `school_settings` JSONB validated by Zod schemas per namespace, versioned | §71 configuration over hard-coding |
| Auth | Server-side sessions in Redis + rotating refresh, Argon2id passwords, MFA-ready (TOTP tables from day 1, enforcement flag off) | §42 |

**Why not microservices now:** the dominant coupling in a school ERP is *transactional* (fee ↔ invoice ↔ ledger ↔ receipt; marks ↔ report card ↔ publication). Splitting these early buys distributed-transaction pain and zero scaling benefit at 100k students, which one Postgres primary handles comfortably.

**Proposed stack** (justification per §76: nothing exotic, all boring and load-bearing)

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 + TypeScript (strict), TanStack Query + Table, react-hook-form + Zod, Tailwind + Radix primitives, `cmdk` |
| Backend | **Go 1.23** |
| HTTP | **Gin** |
| API | REST + **OpenAPI 3.1** (contract is the source of truth) |
| Database | **PostgreSQL 16** |
| Driver / SQL | **pgx/v5** + **sqlc** |
| Migrations | goose (forward-only, expand→migrate→contract) |
| Cache / sessions / rate limit / locks | **Redis 7** |
| Queue | **Redis + Asynq** |
| Files | **S3-compatible** (R2/MinIO/S3) |
| Search | **PostgreSQL** (`tsvector` + `pg_trgm`) → OpenSearch only when it actually hurts |
| Auth | Server-side sessions, **OIDC/OAuth2-compatible** (schools with Google Workspace get SSO) |
| Jobs | Go workers (`cmd/worker`) |
| Observability | **OpenTelemetry + Prometheus**, `slog` JSON logs |
| CI/CD | GitHub Actions |
| CDN / WAF | **Cloudflare** |
| Deployment | **Docker Compose** → Kubernetes only when a real constraint demands it |
| PDF | headless-Chromium sidecar driven by the worker |

**Gin over Fiber** — Fiber is fast but sits on fasthttp, outside `net/http`, which costs you the standard middleware/`context`/OTel-instrumentation ecosystem and makes `httptest`-based API testing awkward. Our bottleneck will be Postgres, not the HTTP layer, so the ecosystem compatibility is worth more than the router benchmark. Say so if you'd rather have Fiber and I'll switch — it changes middleware code, nothing architectural.

**Why sqlc over an ORM:** the hard queries here — outstanding fees by grade, attendance percentage over a term, rank computation — are SQL problems. sqlc gives compile-time-checked hand-written SQL with generated Go structs, and keeps RLS session variables explicit.

**One tradeoff with Asynq you should know about:** the queue lives in Redis, so enqueue is *not* transactional with the Postgres write. A crash between commit and enqueue drops the job. Fix: business writes insert into an `outbox_events` table inside the same transaction, and a relay goroutine pushes to Asynq and marks the row published — at-least-once delivery, with idempotent handlers. That matters for "payment received → send receipt" and "result published → notify parents", where a silently lost job is a support call. Everything else (exports, PDFs) enqueues directly.

**PDF rendering:** Go has no good HTML→PDF story, so the worker drives a small headless-Chromium sidecar against versioned HTML templates — deterministic, reproducible, server-side only. It's the one extra moving part in this design and it earns its place (report cards, TCs, receipts, ID cards all depend on it).

---

## B. Exhaustive module tree

```
platform/                     # cross-cutting, no school domain
  auth/                       sessions, password, MFA, device+session mgmt, lockout
  rbac/                       roles, permissions, scopes, policy engine
  tenancy/                    org, school, campus, academic year, context resolution, RLS glue
  audit/                      audit_logs, diff capture, retention
  config/                     settings namespaces, feature flags, board/grading config
  i18n/                       locales, translations, terminology overrides
  files/                      object storage, signed URLs, MIME/size policy, AV scan hook
  notifications/              templates, channels, delivery tracking, preferences, retries
  jobs/                       queue defs, schedulers, DLQ, job monitoring
  search/                     global search index + authorization filter
  reporting/                  report registry, async export engine (CSV/XLSX/PDF)
  imports/                    upload→validate→preview→commit pipeline
  pdf/                        template registry, renderer, certificate + report card output
  superadmin/                 tenants, subscriptions, usage, support impersonation (audited)

sis/
  admissions/                 enquiries, campaigns, applications, docs, tests, interviews,
                              evaluation, offers, waitlist, admission fee, enrollment handoff
  students/                   profile, identifiers, houses, categories, scholarships, media
  guardians/                  guardians, relationships, pickup auth, financial responsibility
  lifecycle/                  promotion, detention, transfer, withdrawal, re-admission,
                              graduation, alumni, TC issuance
  health/                     medical notes, allergies, nurse visits, vaccination (restricted)
  discipline/                 incidents, severity, actions, notifications (restricted)

academics/
  structure/                  grades, sections, subjects, subject groups, electives, streams
  curriculum/                 curriculum versions, units, chapters, outcomes, lesson plans
  timetable/                  periods, slots, allocations, substitutions, conflict engine
  attendance/                 daily, period, staff; bulk entry, corrections + approvals
  leave/                      student leave, staff leave types/entitlement/balance/workflow
  homework/                   assignments, submissions, grading, feedback
  lms/                        courses, lessons, resources, quizzes, progress

examinations/
  exams/                      exam defs, types, schedules, papers, max/pass marks, weightage
  marks/                      entry, bulk entry, absent/malpractice/withheld, moderation,
                              grace, revaluation, verification → approval → publish, locking
  grading/                    grade scales, GPA, percentage, rank, percentile
  reportcards/                template engine, co-scholastic, remarks, generation, publication

finance/
  feestructure/               structures, components, schedules, installments, applicability
  assignments/                student fee assignment, concessions, scholarships, discounts
  billing/                    invoices, arrears, late fees, credit notes
  payments/                   gateway abstraction, webhooks (idempotent), verification,
                              offline modes, allocation, receipts, refunds, reconciliation
  accounting/                 chart of accounts, ledgers, journals, expenses, vendors, reports

hr/
  staff/                      profiles, departments, designations, documents, qualifications
  attendance/                 staff attendance + shifts
  payroll/                    structures, components, runs, payslips, statutory (configurable)

operations/
  library/                    catalogue, copies, members, issue/return/renew/reserve, fines
  transport/                  vehicles, drivers, routes, stops, assignments, capacity, GPS port,
                              maintenance, insurance, permits, incidents
  hostel/                     blocks, rooms, beds, allocation, wardens, attendance, visitors
  inventory/                  items, warehouses, stock, movements, reorder
  assets/                     asset register, assignment, maintenance, depreciation, disposal
  procurement/                requests, quotations, POs, GRN, invoices, approvals

engagement/
  communication/              announcements, notices, targeted messaging, emergency broadcast
  calendar/                   academic calendar, holidays, events, PTM
  analytics/                  role-scoped dashboards and drilldowns
```

---

## C. Complete role list

**System roles (seeded, non-deletable, cloneable):**

| Role | Scope | One-line mandate |
|---|---|---|
| `super_admin` | platform | SaaS operator; tenant lifecycle. No default access to tenant PII without audited support grant. |
| `org_admin` | organization | All schools in the org. |
| `school_admin` | school | Everything within one school. |
| `campus_admin` | campus | Everything within one campus. |
| `principal` | school | Full read; approvals; no finance mutation by default. |
| `vice_principal` | school | Principal minus finance and staff records. |
| `academic_coordinator` | school/grade-band | Curriculum, timetable, exam config, marks verification. |
| `exam_coordinator` | school | Exam lifecycle incl. publish + result locking. |
| `class_teacher` | assigned sections | Own sections: attendance, remarks, discipline entry, parent comms. |
| `teacher` | assigned section×subject | Own allocations only: attendance, marks entry, homework, LMS. |
| `admissions_officer` | school | Admissions CRM end to end, up to offer. |
| `front_office` | campus | Enquiries, visitors, notices, ID cards. |
| `accountant` | school | Fees, invoices, payments, receipts, expenses. No academic writes. |
| `finance_manager` | school/org | Accountant + refunds, discount approval, reconciliation, financial reports. |
| `hr_manager` | school/org | Staff, leave, payroll. |
| `librarian` | campus | Library module. |
| `transport_manager` | campus | Transport module. |
| `hostel_warden` | hostel | Hostel module for assigned hostels. |
| `store_keeper` | campus | Inventory, assets, GRN. |
| `counsellor` | school | Discipline + wellness (restricted-data role). |
| `nurse` | campus | Health records only. |
| `parent` | own children | Read own children; pay fees; submit leave; message teachers. |
| `student` | self | Read own records; submit homework; LMS. |
| `alumni` | self | Own historical records + certificate requests. |
| `auditor` | org | Read-only everything incl. audit logs; zero write. |

Custom roles = a permission set + scope template, created per organization.

---

## E. User personas

1. **Radhika — Principal, CBSE school, 1,800 students.** Opens the app at 9:20am. Needs: today's attendance exception list, unverified admissions, fee collection vs target, staff absences needing substitution. Judges the product by whether the first screen removes a phone call.
2. **Suresh — Accountant, 2 campuses.** Lives in fee collection, receipts, and the day-end reconciliation. Needs: fast search by admission number, partial payment handling, a cash-book that ties out to the paise, and no ability to accidentally delete a receipt.
3. **Anitha — Class teacher, Class 6B, also teaches Maths to 6A/6B/7A.** Marks attendance in <30 seconds on a phone, enters marks in a spreadsheet-like grid, cannot see 7B's data at all.
4. **Vikram — Parent of two children in different grades.** One login, child switcher, wants fee due, attendance, report card, and bus location. Mostly on Android, sometimes 3G, prefers Telugu.
5. **Kiran — Admissions officer during peak season.** 60 enquiries/day, needs a pipeline board, bulk WhatsApp follow-up, document checklist per applicant.
6. **Deepak — Exam coordinator.** Owns the marks pipeline; his nightmare is a published result that has to be retracted. Needs verification queues, lock states, and an audit of every marks edit.
7. **Priya — Org admin, 4-campus group.** Cross-campus comparison, standardising fee structures and grading, role management.
8. **Ravi — Platform operator (us).** Tenant provisioning, health, usage, incident response with audited support access.

---

## Q. Risks and missing requirements (stated up front, not buried)

**Highest-risk areas**

1. **Marks + result publication correctness.** Retraction of a published result is a reputational event for the school. Mitigation: immutable `marks_history`, explicit lock states, publish as a transactional state machine, mandatory reason on post-publish change, revaluation as a new record not an edit.
2. **Money reconciliation.** Gateway webhooks arrive out of order, twice, or never. Mitigation: idempotency keys, `payment_intents` table as source of truth, webhook events stored raw before processing, daily reconciliation job with a settlement report, and payment→allocation→ledger written in one transaction.
3. **Tenant leakage.** A single missing `school_id` filter leaks a competitor school's data. Mitigation: RLS on every tenant table + a test suite that asserts cross-tenant reads return zero rows for every endpoint.
4. **Timetable generation.** Auto-generation is NP-hard and a classic scope trap. Mitigation: Phase 6 ships *conflict detection + manual/assisted placement*. Auto-generation is explicitly out of scope for v1 and flagged as such.
5. **Peak load is spiky, not steady.** Result publication day and admission opening day are 100× normal. Mitigation: publication precomputes report cards as a job; result view served from cache; admission form is rate-limited and queue-backed.
6. **Restricted data (health, discipline, caste/category, government IDs).** Mitigation: field-level restriction, separate permissions, read-access itself is audited, and category/ID fields are optional and off by default per school.

**Requirements the brief leaves open — my assumptions, flag any you disagree with**

| # | Open question | Assumption I will build to |
|---|---|---|
| 1 | Auto timetable generation? | Not in v1; conflict detection only |
| 2 | Biometric/RFID attendance devices? | Port defined, no vendor integration in v1 |
| 3 | Live GPS bus tracking? | Abstraction + stop-event ingestion; no live map v1 |
| 4 | Online exams/proctoring in LMS? | Quizzes only, no proctoring |
| 5 | Statutory payroll (PF/ESI/TDS) | Configurable components; **not** certified compliance. Needs a domain expert before any school runs real payroll on it |
| 6 | Accounting: full double-entry or school-simplified? | **Double-entry** ledger internally, simplified UI. Retrofitting double-entry later is a rewrite |
| 7 | Data residency | India region, single region, documented |
| 8 | DPDP Act 2023 obligations (consent, minors, erasure, breach notice) | Treated as a first-class requirement — see doc 05. Needs legal review |
| 9 | Offline attendance on poor connectivity | Optimistic queue in the PWA; conflict resolution rules TBD |
| 10 | Mobile apps | Responsive PWA in v1; native apps out of scope |

**Missing from the brief that a real school will demand within 3 months:** visitor/gate pass management, substitute-teacher daily allocation board, sports/house points, canteen/wallet, alumni giving, board-exam registration data exports (CBSE OASIS/LOC formats), and UDISE+ export. I recommend adding gate-pass and substitution boards to Phase 9; the rest post-v1.
