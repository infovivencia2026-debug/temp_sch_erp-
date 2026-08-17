# 05 — India Requirements, Design System, Roadmap

## N. India-specific requirements

**Academic structure.** Session typically June–April (varies: April–March in many states, some CBSE schools April–March). Nothing about session boundaries is hard-coded — `academic_years` is data. Stage naming (Nursery/LKG/UKG vs Pre-KG/Jr KG/Sr KG) is a per-school terminology override, not a code change.

**Boards** are a configuration bundle, not a code path:

```jsonc
board_config = {
  "board": "CBSE",                    // CBSE | CISCE | TS_SSC | AP_SSC | STATE | IB | CUSTOM
  "assessment_model": "term_based",   // term_based | annual | continuous
  "components": ["FA1","FA2","SA1","FA3","FA4","SA2"],
  "grading": { "scale_id": "cbse_8point", "co_scholastic": true, "gpa": true },
  "promotion_rule": { "min_attendance_pct": 75, "min_pass_subjects": "all_core" },
  "report_card_template_id": "...",
  "terminology": { "section": "Section", "grade": "Class", "term": "Term" }
}
```

Seeded presets: CBSE (FA/SA + co-scholastic + 8-point grade), CISCE/ICSE (percentage-weighted internals), Telangana SSC (FA1–4 20 marks + SA1–3 80 marks, subject-wise grade points), AP SSC (similar with its own weightage), generic state board, IB/custom. A school picks a preset and edits it; nothing about "CBSE" appears in a `switch` statement in the domain layer.

**Money & finance.** INR, `numeric(14,2)` in DB and integer paise in Go (a `Money` type — never float64). Indian digit grouping (₹8,45,000 — lakh/crore, not thousands) in every formatter, with a compact form (₹8.4L, ₹1.2Cr) for dashboards. Indian financial year (Apr–Mar) is a *separate* concept from the academic year, and receipt/invoice series are numbered per financial year. GST fields on vendor invoices and on taxable fee heads (most school tuition is exempt — so tax is optional per fee head, never assumed).

**Payments.** Gateway is a port; Razorpay and Cashfree adapters first (both are UPI-native and standard in Indian schools), PayU/CCAvenue behind the same interface. UPI intent/QR for parent self-service, plus offline modes (cash, cheque with clearance status, DD, NEFT) because a large share of collection is still at the counter. Cheque bounce is a first-class state that reverses the receipt with a reversing journal entry, not a delete.

**Identity & contact.** Phone is `+91` E.164 with a 10-digit input mask, and phone is often the *primary* identity for parents — the auth architecture supports phone+OTP login from day one (schema and flow present; enabled per school). Addresses use the Indian structure: line 1, line 2, landmark, city/village, mandal/taluk, district, state (dropdown of 28+8), PIN (6 digits, validated).

**Government identifiers.** `UDISE+` school code, student `PEN`, `APAAR` ID, and board roll numbers are supported as **optional, per-school-enabled, restricted** fields in `student_identifiers` — encrypted, permission-gated, read-audited. Aadhaar: we store a reference/verification status, **not** the number, unless a school explicitly enables it with acknowledged legal responsibility; default is off. The `category` field (General/OBC/SC/ST/EWS) is collected only where a school enables it for statutory reporting, and is restricted data. Principle: *do not collect what you do not need, and treat what you do collect as radioactive.*

**Compliance.** Digital Personal Data Protection Act 2023 applies squarely — nearly every data subject here is a **child**, which triggers verifiable parental consent, a bar on tracking/behavioural monitoring and targeted advertising, and data-minimisation obligations. Architecture provides: consent records per guardian, purpose tagging on data fields, an erasure/anonymisation routine that preserves financial aggregates, breach-notification runbook, and data residency in an India region. **This needs legal review before go-live — I am giving you an architecture that can comply, not a compliance certification.**

**Localisation.** English, Hindi, Telugu at launch (the brief's states point at Telugu first); ICU message format, locale-aware dates (`DD/MM/YYYY` default), Asia/Kolkata timezone, and translatable *terminology* so a school can call a section a "division". Report cards and certificates render in the school's chosen language with proper Devanagari/Telugu font embedding in the PDF pipeline.

**Field reality.** Many parents are on mid-range Android over patchy 3G/4G. That drives: PWA with offline attendance queueing, aggressive payload trimming, SMS/WhatsApp as first-class channels (not email-first — email open rates among Indian school parents are poor), and DPI-aware print layouts for the report cards and certificates that schools still print.

---

## O. UI/UX design system

**Foundations**

| Token | Value |
|---|---|
| Type | Inter (UI) + `ui-monospace` for numerics/IDs. Scale: 11/12/13/14/16/20/24/30. Body 13–14px — this is a dense data product, not a marketing site |
| Numerics | Tabular figures everywhere money or marks appear, right-aligned |
| Spacing | 4px base: 4/8/12/16/24/32/48 |
| Radius | 6px controls, 8px cards, 10px dialogs. Nothing pill-shaped except badges |
| Elevation | Two levels only: hairline border (`1px` neutral-200/neutral-800) for structure, one soft shadow for overlays. No decorative shadows |
| Color | Neutral-led greyscale carries 95% of the UI. One brand accent for primary action and selection. Semantic: success / warning / danger / info — used for *state*, never decoration |
| Density | Table rows 36px default, 32px compact, 44px comfortable — user preference, persisted |
| Motion | 120–180ms, ease-out, opacity/transform only. Full `prefers-reduced-motion` support |
| Themes | Light and dark are both first-class, defined as token sets; charts and PDFs have their own light-only palettes |

**Chrome.** Fixed 48px topbar: school/campus switcher · academic-year switcher · global search (⌘K) · notification bell · avatar menu. Collapsible 240px sidebar (icon-only at 56px), role-filtered so a librarian never sees Payroll. Breadcrumbs under the header, page actions right-aligned in the page header. Mobile: bottom tab bar for the 4 most-used destinations per role + a drawer for the rest — designed for the role, not a shrunken desktop.

**Command palette** (⌘K) is a real navigation surface: fuzzy search across students/staff/invoices/sections, plus verbs (*Mark attendance*, *Record payment*, *New enquiry*, *Switch school*, *Switch year*, *Generate report*). Results are authorization-filtered server-side.

**Keyboard.** `g s` students, `g a` attendance, `g f` fees, `/` search, `⌘K` palette, `j/k` row nav, `x` select, `⌘Enter` submit, `?` shortcut sheet.

**Dashboards** answer questions, per the brief. The principal's opening screen:

```
Today · Thu 14 Aug                                    [Academic Year 2026-27 ▾]

Attendance 94.8%   ↓1.2% vs yesterday      Collection ₹8.4L   ₹2.1L unreconciled
Staff absent 6     4 periods unsubstituted  Admissions 42 new  12 awaiting verification

⚠ Needs you                                                          [ 5 items ]
   Marks verification pending — Class 10 SA1, Physics        3 days   → Review
   Discount approval — ₹18,000, sibling concession           1 day    → Approve
   Unsubstituted periods today — 4                           now      → Assign
   Fee overdue >30 days — 23 students, ₹3.1L                          → View list
   Document expiry — 2 vehicle permits lapse in 9 days                → View
```

Numbers that matter, each with a comparison or a consequence, then a work queue. No four giant cards.

**Accessibility.** WCAG 2.2 AA target: semantic HTML, visible focus rings on every interactive element, 4.5:1 text contrast in both themes, labelled form controls with errors tied via `aria-describedby`, proper table semantics with scoped headers, live regions for async results, full keyboard reachability including the DataTable and command palette, and reduced-motion honoured.

---

## P. Implementation roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Requirements** ✅ | These five documents | You sign off; open questions in doc 01 §Q answered |
| **1. Architecture spike** | Repo skeleton, Go module layout, docker compose, migrations, sqlc, OpenAPI codegen, CI, one vertical slice (schools CRUD) end to end with authz + audit + tests | A new endpoint takes <1h to add correctly. This phase is where the quality bar is set |
| **2. Database** | Full ERD + migrations for platform/SIS/academics; seed framework | Migrations up/down clean; RLS proven by a cross-tenant test |
| **3. Design system** | Shell, sidebar, topbar, palette, DataTable, form system, themes, all six page states | Storybook + a11y checks passing |
| **4. Foundation** | Auth, users, sessions, MFA schema, orgs/schools/campuses/years, RBAC, audit | Authz test suite green for every route |
| **5. Core SIS** | Admissions CRM, students, guardians, enrollment, sections, lifecycle | E2E: enquiry → enrolled student with fee assignment |
| **6. Academics** | Subjects, curriculum, timetable + conflicts, attendance + corrections, leave, homework | E2E: attendance → correction → approval; timetable rejects all three conflict types |
| **7. Examinations** | Exams, marks pipeline, grading, results, report cards, publication | E2E: entry → verify → publish → PDF; post-publish edit blocked without unlock |
| **8. Finance** | Fee structures, invoices, payments (gateway + offline), receipts, refunds, double-entry ledger, reconciliation | Ledger balances; webhook replay is idempotent; concurrency tests pass |
| **9. Operations** | HR, payroll, library, transport, hostel, inventory, assets, procurement + substitution board and gate pass | Capacity and double-allocation invariants enforced at DB level |
| **10. Communication** | Announcements, notification engine, templates, SMS/WhatsApp/email/push adapters, preferences | Delivery tracking and retries observable |
| **11. Reporting** | Report registry, async exports, PDFs, certificates, ID cards, role dashboards, analytics | Large exports never block a request |
| **12. Hardening** | Security review, rate limits, caching, query tuning, observability, backups + **restore drill** | Restore tested; pen-test findings closed |
| **13. Testing** | Fill coverage gaps, load tests at 100k students, chaos on queue/db failover | Documented load baselines |
| **14. Production** | Staging, blue/green, runbooks, DR plan, docs | A school can be onboarded |

Phases 5–11 each ship as a *complete* module per §77 (UI + API + DB + validation + authz + rules + errors + states + audit + tests + docs). A module with a page but no authz tests is not done.

**What I'd build first if you want value earliest:** phases 1–4 are unavoidable foundation, then **Finance (8) before Examinations (7)** — fee collection is what schools pay for and what they'll evaluate you on in a pilot. Say the word if you'd rather keep the listed order.

---

## Next step

Stack is settled per your spec: **Next.js + Go (Gin) modular monolith + PostgreSQL (pgx/sqlc) + Redis/Asynq + S3 + Cloudflare + Go workers + OpenTelemetry/Prometheus.**

Awaiting your instruction to begin **Phase 1**. The answers that would change the design most are the open questions in [01-product-architecture.md](docs/01-product-architecture.md) §Q — particularly double-entry accounting (6) and payroll compliance scope (5), since both are expensive to retrofit.
