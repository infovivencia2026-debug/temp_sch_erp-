# Gap analysis 04 — Annual rollover, and the seller → school SaaS lifecycle

Evidence base: `docs/ROLES_AND_FEATURES.csv` (452 features), `internal/catalog/catalog_gen.go`,
`migrations/*.sql`, `internal/api/*.go`. Schema citations are table/column names read from the
migrations, not inferred from feature names.

Severity: **P0** cannot run the year / cannot run the business / statutory. **P1** runs but needs a
parallel spreadsheet. **P2** genuine inconvenience. **P3** nice to have.

---

# PART A — End of year and annual rollover

## Verdict

The *data model* is much better than the catalogue suggests, and the *operational surface* is much
worse. `enrollments` is a proper per-year row — `(student_id, academic_year_id)` unique, `class_id`,
`section_id`, `roll_no`, `status`, and a self-referencing `promoted_from_id` — so a child's identity
lives on `students` and their year-by-year history is preserved rather than overwritten. That is the
single hardest thing to retrofit, and it is right. Promotion does **not** mutate the old row
(`internal/api/mod_academics.go:524`). `getAcademicRecord` (`internal/api/student_learning.go:2263`)
reads the multi-year file back correctly.

Everything around that core is missing. There is **no year-close operation of any kind** for the
academic year — no lock, no immutability trigger, no audit point, nothing that says "2026-27 can no
longer be edited". The product has close machinery and knows how to build it: `accounting_years`
with the `accounting_year_close_is_final()` trigger (`migrations/00033_ledgers.sql:430`),
`bank_reconciliations` finalisation (`migrations/00046_banking.sql:368`), `mdm_monthly_returns_frozen`
and `fee_regulatory_filings_frozen` (`migrations/00053_admin_ops.sql:986,1641`). None of it was applied
to `marks`, `student_attendance`, `enrollments`, `exams` or `report_cards`. Last year's marks stay
editable for ever.

Worse, **two academic years cannot properly be alive at once**. `academic_years.is_current` is
constrained by a partial unique index —
`CREATE UNIQUE INDEX academic_years_one_current ON academic_years (institution_id, COALESCE(campus_id, nil)) WHERE is_current`
(`migrations/00001_baseline.sql:1986`) — one current year per campus, and roughly fifteen handlers
resolve the working year by hard-coded `SELECT id FROM academic_years WHERE is_current LIMIT 1` with
no override parameter. Flipping the flag in `internal/api/setup.go:78`
(`UPDATE academic_years SET is_current = false WHERE is_current`) instantly redirects all of them.
A school running November admissions for 2027-28 while still teaching 2026-27 has one flag and two
answers.

And the only promotion feature in the catalogue really is the whole of it: one endpoint,
`POST /students/promote`, one section at a time, carrying nothing forward.

## Activity → coverage table

| Activity (what an Indian school does Feb–June) | Covering features / code | Status | Gap | Sev |
|---|---|---|---|---|
| Record final exam marks, publish results | `institution_admin.examinations.exams_results`, `exams_result_status`; `exams.is_published`, `marks`, `exam_subjects.pass_marks` | Built | Publication is a boolean; marks remain editable after publish — no guard found in `mod_academics.go:315` / `teaching.go:2836` | P1 |
| Compute annual result / pass-fail per child | `pass_marks` compared on read in `admin_rollups.go:1153,1382,1449` | Partial | Nothing **stored**. No annual result row, no division/aggregate rule, no "qualified for promotion to the next higher class" — a prescribed TC field | P1 |
| Detention / retention decision | `enrollments.status` allows `'detained'`; catalogue summary claims "manage retentions" | **Absent** | No handler writes `'detained'` anywhere. Only `attention.go:661` and two React files *render* it. The status is decorative | P1 |
| Promote a class to the next year | `institution_admin.students.class_section_promotion`; `promoteStudents` `mod_academics.go:524` | Partial | One `from_section_id` → `to_section_id` at a time; target sections must already exist; no dry-run, no preview, no undo, no audit row, no eligibility check | P1 |
| Create next year's classes/sections/roll numbers | `sections` rows are per `academic_year_id`; inserts only in `setup.go:186` and `bulk_import.go:158` | **Absent** | No clone-structure-to-next-year endpoint. `grep "func (s *Server) (copy\|clone\|duplicate\|rollover)"` → no matches. Every section recreated by hand each April | P1 |
| Roll the timetable forward | `timetable_entries.academic_year_id` NOT NULL; `timetable_drafts` | **Absent** | No copy-to-next-year. A full timetable is rebuilt from scratch annually | P1 |
| Roll fee structures forward | `fee_structures.academic_year_id`, `fee_structure_versions` (versioned, snapshotted items) | Partial | Versioning is excellent, but no "clone 2026-27 structure into 2027-28 with +8%" action | P2 |
| Carry unpaid dues forward as arrears | — | **Absent** | No `arrears`, `opening_balance`, `brought_forward` or `previous_year` column anywhere in `00045_fee_engine.sql` / `00094_collections.sql`. Global grep returns only `bank_reconciliations.opening_balance_paise` | **P0** |
| Reconcile and close the fee year | `finance.ledgers.financial_year_closing`; `accounting_years` + irreversible close trigger | Built (FY only) | Closes the *financial* year, not the *academic* year. No statement that 2026-27 fee collection is final | P2 |
| Issue Transfer Certificates for leavers | `institution_admin.students.certificates_documents`; `issueCertificate` `mod_academics.go:596`, `certificate_types`, `issued_certificates` | Built — **but defective** | See below. Exists (contrary to expectation) but fails a statutory field test and has no dues gate | **P0** |
| Student withdrawal (non-TC) | `students.status`/`exit_date`/`exit_reason` set only inside `issueCertificate` | **Absent** | No withdrawal workflow of its own; the only exit path is issuing a TC | P1 |
| Clear dues/library/hostel before a child leaves | `exit_clearances` + `clearance_departments` exist **for staff only** (`00031_hr_lifecycle.sql:205`) | **Absent for students** | Staff settlement is blocked in the database until clearance; a student can be issued a TC with books out and fees owing | P1 |
| Graduate class 10/12 to alumni | `alumni_profiles`, `students.status` allows `'graduated'`/`'alumni'` | Partial | No bulk graduation action; no handler sets `'graduated'` | P2 |
| Carry hostel allocation forward | `hostel_allocations (student_id, room_id, bed_no, allocated_on, vacated_on)` — **no `academic_year_id`** | **Absent** | Allocation is open-ended by date. No year-end vacate sweep, no re-allocation run. Beds stay occupied across the summer | P1 |
| Carry transport route forward | `transport_allocations.academic_year_id` NOT NULL, `UNIQUE (student_id, academic_year_id)` | **Absent** | Correctly year-scoped, therefore every allocation must be recreated each year, and there is no bulk carry-forward | P1 |
| Recall library books at year end | `library_loans` — no `academic_year_id`; `library_stock_audits` | Partial | Loans are date-based and survive the year change silently. `institution_admin.library.library_inventory_audit` audits stock, not outstanding loans | P2 |
| Close inventory / stock at year end | `inventory_items.on_hand` (trigger-maintained), `inventory_movements` | **Absent** | No period concept at all — no opening/closing stock, no year-end valuation, no physical-count reconciliation. `on_hand` is a single running number with no history | P1 |
| Staff appraisal cycle | `hr.hiring_growth.annual_performance_appraisal_kpi`; `appraisal_cycles` (statuses `draft→…→published→closed`, `academic_year_id`), `appraisal_kpis`, `appraisal_ratings`, `appraisals.increment_percent/increment_paise` | **Built, good** | Genuinely year-scoped with a closable cycle and an increment outcome | — |
| Apply appraisal increments to next year's salary | `appraisals.increment_percent`, `salary_structures` | Partial | The increment is recorded but no path found that applies it to `salary_structure_items` | P2 |
| Payroll / tax year close | `payroll_runs.status` includes `'locked'`; `hr.statutory.income_tax_form_16_generator`, `employee_tax_elections`, `investment_declarations`, `pt_slabs` | **Built** | Per-run locking plus Form 16; adequate | — |
| Carry leave balances forward | `leave_types.carry_forward`, `leave_policy_rules.carry_forward_max`, `leave_balances UNIQUE (employee, leave_type, academic_year_id)` | Partial | The *policy* is modelled; no year-end job found that computes next year's opening balance from it | P1 |
| Reset attendance percentage for the new year | — | **Broken** | See below — attendance % is computed over a student's entire lifetime | **P0** |
| Lock / audit the closed academic year | `accounting_years` pattern exists but is unused here | **Absent** | No academic year close, no `closed_on/closed_by`, no immutability trigger on academic data | **P0** |
| Run next year's admissions while this year runs | `admission_sessions.academic_year_id` NOT NULL; `mod_admissions.go` accepts an explicit `academic_year_id` | Partial | The admissions module is correctly year-parameterised, but the ~15 `WHERE is_current` handlers around it are not | **P0** |

## The serious findings, with evidence

### A1 · `is_current` is a single global switch, and fifteen handlers read it (P0)

`academic_years` carries `is_current boolean`, and `migrations/00001_baseline.sql:1986` permits exactly
one per `(institution_id, campus_id)`. Handlers then resolve "the year" implicitly:

- `collections.go:1572`, `infirmary.go:584`, `transport_office.go:257`, `hpc.go:579`,
  `library_desk.go:657`, `board_exams.go:456`, `admin_ops.go:1851`, `hr_growth.go:2691`,
  `statutory.go:162`, `bulk_import.go:340`, `setup.go:181`, `mod_admissions.go:566`, and four sites in
  `admin_academics.go` (242, 343, 638, 1818, 1948, 2414) — all `SELECT id FROM academic_years WHERE is_current …`.

The reporting layer is the honourable exception: `rollupYear` (`admin_rollups.go:206`) takes a
`?year=` override and its comment explicitly reasons about multi-campus institutions carrying several
current years. That pattern was not propagated.

Consequence: a school opens 2027-28 admissions in November. To make those admissions land in the right
year it must either pass `academic_year_id` explicitly on every call that supports it, or flip
`is_current` — and `setup.go:78` flips it globally, at which point fee collection, attendance,
library issue, transport allocation and infirmary records for the year *still being taught* start
writing against the new year. The product is safe for a quarter of every year only if nobody touches
the flag, which means next year's admissions cannot be attributed. There is no
"active years" concept, no per-session year context, no year switcher in the request scope.

### A2 · Attendance percentage is lifetime, not per-year (P0)

`student_attendance` has **no `academic_year_id`**. The year is reachable only via
`section_id → sections.academic_year_id`. Two important read paths forget to make that join:

- `internal/api/student_learning.go` (`getAcademicRecord`, the student's own file):
  `SELECT round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late')) / nullif(count(*),0),1) FROM student_attendance sa WHERE sa.student_id = st.id`
- `internal/api/mod_academics.go:648` (the **Transfer Certificate snapshot**): the identical
  unfiltered aggregate.

So a Class 9 child's displayed attendance is the average of Classes 1–9, and the TC — a legal document
— prints a lifetime figure where the board expects the current session's. This is precisely the
"must not carry forward" test in the brief, and it fails. The fix is a join to `sections`, but the
absence of `academic_year_id` on `student_attendance` is why it was easy to get wrong; every consumer
must remember the join.

### A3 · No arrears, therefore no fee carry-forward (P0)

`invoices` is properly year-scoped (`academic_year_id` NOT NULL, indexed with `student_id`). What does
not exist is any representation of *last year's* balance in *this* year's demand. Searching
`migrations/` and `internal/api/` for `arrear`, `brought_forward`, `opening_balance`, `previous_year`,
`prior year dues` returns nothing in the fee engine — the only hit is
`bank_reconciliations.opening_balance_paise`, which is a bank statement field.

The codebase knows the problem exists. `admin_rollups.go:644` warns in a comment that the "latest
enrolment" shortcut "reads last year's arrears as though they belonged to this year's class, which
makes a Grade 9 look like a defaulter for a debt they ran up in Grade 8" — and correctly joins the
invoice's own year. But knowing an old debt exists is not carrying it forward. There is no
opening-balance line on the new year's invoice, no arrears fee head, no consolidated
"total outstanding across years" demand note, and no way to block promotion on unpaid dues. Every
Indian school reconciles arrears in April. This one does it in Excel.

### A4 · The TC exists — and that is the interesting part (P0)

The brief's cautionary example is worth correcting: **TC issuance does exist.**
`issueCertificate` (`internal/api/mod_academics.go:596`) accepts `type_code` `TC | BONAFIDE | CONDUCT`,
allocates a serial, writes `issued_certificates` with a frozen `snapshot` jsonb, and on `TC` sets
`students.status='transferred'`, `exit_date`, `exit_reason` and closes the active enrolment. The
comment is explicit about why the snapshot is frozen. `certificate_types` was extended
(`migrations/00036_admin_academics.sql:89`) with `subject_kind`, `serial_prefix`, `signatory`,
`signatory_role`, `page_size` for exactly this. "Transfer Certificate Intake" is a *separate*,
inbound feature; the outbound one is under `institution_admin.students.certificates_documents`.

But it is not a compliant TC, and each defect is load-bearing:

1. **No dues or clearance gate.** The snapshot merely *records* `dues_paise` (summed across all years).
   Nothing blocks issuance. Contrast the staff side, where `00031_hr_lifecycle.sql:205` blocks
   settlement *in the database* until every `exit_clearances` row is signed off. Students get no
   equivalent — a child can leave with library books out and a term's fees owing, and the school's
   only record is a number on a certificate it already handed over.
2. **Missing prescribed fields.** The snapshot carries eight keys: name, admission_no, date_of_birth,
   class, section, admission_date, apaar_id, attendance_percent, dues_paise. A CBSE/state TC requires
   roughly twenty, including *last examination passed*, *whether qualified for promotion to the higher
   class*, *number of working days / days present*, *subjects studied*, *general conduct*, *date of
   leaving*, *concession availed*, *games played*. Several of those are unavailable because the
   underlying facts are not stored (A2, and the absent annual result of the table row above).
3. **`serial_prefix` is configured but ignored.** `admin_academics.go:2766,2777` lets a school set
   "TC/2026/". The issuer calls `fees.NextNumber(…, "certificate")` — a *single* series shared by TC,
   bonafide, conduct and, via `hr_lifecycle.go:810`, staff certificates. The prefix a school typed
   never reaches the paper, and TC serials are not a contiguous register, which is the one thing an
   inspector checks.
4. **Approval is bypassed.** If the type does not exist the handler creates it with
   `requires_approval=false` — "so a school is not blocked by setup". A TC then issues on a single
   clerk's click.
5. **No duplicate-TC or cancellation workflow** beyond the generic `status` enum, and no
   countersignature field for the education officer that several state boards require.

### A5 · Nothing is ever locked (P0)

The product demonstrably knows how to freeze a period — five separate mechanisms across ledgers,
banking, MDM returns, regulatory filings and service book entries. Not one of them protects academic
data. There is no trigger on `marks`, `student_attendance`, `enrollments`, `report_cards` or `exams`
tied to a year state; `academic_years` has no `status`, `closed_on` or `closed_by` column at all. A
teacher can change a mark in a published 2024-25 report card today, and the report card's stored
`percentage`/`rank_in_section` will not even be recomputed. There is no audit point at which the
school says "the year is done".

### A6 · What actually happens each April

Given the above, a school's real April is: create every 2027-28 section by hand (or via
`bulk_import`); create the timetable from scratch; clone the fee structure by hand; run
`POST /students/promote` once per section, having decided detentions outside the system because
`'detained'` cannot be written; recreate every transport allocation and hostel allocation; reconcile
last year's arrears in Excel and re-enter them as ad-hoc invoice lines; and flip `is_current`, after
which the previous year's screens become unreachable in the fifteen handlers that never learned to ask.

The one genuinely well-built annual process is **staff appraisal** (`appraisal_cycles` with a real
state machine through `closed`, KPI weights, and an increment outcome) — which is the proof that the
same rigour was available and simply was not applied to the student year.

---

# PART B — The seller → school SaaS lifecycle

## Verdict

The twelve `seller_admin` features are, as the brief suspects, entirely post-sale — but the picture is
slightly better and considerably worse than that framing. Better, because a vendor-side lead table
*does* exist and simply was never catalogued: `purchase_enquiries` (`migrations/00013_purchase_enquiries.sql:14`),
whose header comment is unambiguous — *"the vendor's data about a school that does not exist yet"* —
with statuses `new → contacted → demo_booked → won → lost`, a `source` column for advertising
attribution, and `provisioned_institution_id` to mark conversion. It is served by `GET /seller/enquiries`
(`internal/api/buy.go:267`) and fed by the public pricing page. So the funnel is not quite zero.

Worse, because everything between "demo_booked" and "provisioned" is missing outright, and because of
one structural fact that causes most of the rest:

> `subscriptions` has `PRIMARY KEY (institution_id)` (`migrations/00001_baseline.sql:1946`) and carries
> no monetary column at all. Its full content is `plan_code`, `status`, `started_on`, `renews_on`,
> `trial_ends_on`, `licensed_students`, `notes`.

One mutable row per school, for ever. The product can state what a school is on **today**. It cannot
state what the school **agreed to**, what it **owes**, what it **paid**, what it **used to be on**, or
**when it changed**. That is not a billing system; it is an entitlement flag with a renewal date
attached.

The "Subscription Ledger" feature is the sharpest illustration. There is no `subscription_ledger`,
`subscription_events` or `billing_events` table anywhere in `migrations/`. `web/src/features/registry.ts:85-91`
routes `subscription_ledger`, `tenant_directory`, `provision_new_school`, `suspend_reactivate`,
`onboarding_progress`, `plans_pricing` and `seat_overage_renewals` — **seven of the twelve features —
to the same React component**, `./seller/Tenants`. The ledger is the tenant list.

### On the false positive the brief warns about

Confirmed and worth stating plainly. The catalogue's admissions lead machinery — `enquiries`
(`00001_baseline.sql:456`, columns `student_name`, `parent_name`, `class_sought`, `FORCE ROW LEVEL SECURITY`),
`crm_lead_links` (`00097_connectors.sql:191`, providers CHECK'd to `meritto`/`leadsquared`, which are
Indian *admissions* CRMs), `crm_sync_runs`, `admission_campaigns` (`00095_admissions_growth.sql:264`) —
is **all tenant-scoped with `institution_id NOT NULL` and RLS**. It is a school's pipeline of
prospective *parents*. None of it covers the vendor's pipeline of prospective *schools*. The codebase
says so itself at `internal/api/buy.go:263-266`: *"Distinct from listEnquiries, which is a school's own
admissions enquiries — parents asking about a place, not schools asking about the software."*
Any credit for a sales pipeline must come from `purchase_enquiries` alone.

Likewise three other near-misses, all school-side and none countable:
- `staff_onboarding` (`00031_hr_lifecycle.sql:28`) is the school's HR onboarding of an *employee*, not the vendor's onboarding of a *school*.
- `staff_training_records` (`00054_hr_growth.sql:587`) is the school's own CPD/NEP register, keyed to its own `employees` and `training_programmes`. No vendor, no trainer, no product module.
- `franchises`/`franchise_members` (`00038_platform.sql:160,181`) is a **school-brand chain** (a DPS/Narayana-style group), not a reseller channel. `royalty_bp` and `annual_fee_paise` are what a member school pays the *brand owner*; there is no FK to `plans` or `subscriptions` and no commission on software revenue.

## Stage → coverage table

| Lifecycle stage | Covering features / code | Status | Gap | Sev |
|---|---|---|---|---|
| Lead | *(uncatalogued)* `purchase_enquiries`; `GET /seller/enquiries` `buy.go:267` | Partial | A contact-form inbox, not a pipeline: no owner, no next-follow-up date, no activity log, no stage history, no deal value | P1 |
| Demo | `purchase_enquiries.status='demo_booked'` | **Absent** | A string with no date, no scheduler, no attendee, no outcome. No demo tenant, no sandbox — `poc`/`pilot`/`sandbox`/`evaluation-tenant` all not found | P1 |
| Qualification | — | **Absent** | No score, no fit criteria, no student-count/board/budget qualification fields beyond the raw enquiry columns | P2 |
| Quotation | — | **Absent** | Zero hits for `quotation`, `quote`, `proposal`, `estimate`, `proforma` in `migrations/`. No vendor→school quote object exists | **P0** |
| Negotiation / discounting | `plans.price_paise`, `plans.price_monthly_paise` (`00120:22`) | **Absent** | **There is no per-tenant price field anywhere.** Price is a property of the plan code. A school cannot be sold at a negotiated rate at all — which is how every Indian ERP deal is actually closed | **P0** |
| Discount approval | — | **Absent** | Follows from the above: nothing to approve | P1 |
| Contract | — | **Absent** | No contract/MSA/agreement table, no term length, no end date, no auto-renew flag, no notice period, no signatory, no signed document. `subscriptions` has `started_on` and `renews_on` and nothing else | **P0** |
| Subscription | `seller_admin.subscriptions_billing.subscription_ledger`, `plans_pricing`; `subscriptions`, `entitlement.ApplyPlan`, 402 paywall `gate.go:71` | Partial | See verdict — one mutable row, no money, no history | **P0** |
| Tenant creation | `provision_new_school`; `provisionSchool` `provision.go:90` | **Built, good** | One transaction: institution + campus + first admin + subscription; password returned once and not stored | — |
| Onboarding | `onboarding_progress`; `setup_percent` SQL at `seller.go:80-92` | Partial | Ten `EXISTS` probes × 10 (campuses, years, classes, sections, subjects, employees, students, fee_heads, exams, profile). **No onboarding table, no checklist, no tasks, no owner, no due dates, no sign-off, no blockers.** It is "count of non-empty tables" | P1 |
| Configuration | `module_entitlement_matrix`; `getEntitlementMatrix`/`setEntitlement` `platform_config.go:3734` | Built | Per-tenant module toggling exists and works | — |
| Data import | `bulk_import.go` `importSpecs` = **classes, sections, staff** only (`:106,127,168`); `importStudents` `students_write.go:378` | Partial | No fee-structure, opening-balance, historical-marks, attendance-history, guardian or library import. No XLSX (zero hits). No mapping UI, no resumable/staged migration, no import-run register. 8 MB cap with the comment *"beyond that the file is a data-migration job, not an upload"* (`students_write.go:382`). **A school cannot bring its opening fee balances or academic history across** — which compounds Part A's arrears gap | **P0** |
| User invitation | `provisionSchool` (one admin, password shown once); `resetTenantAdmin` `seller.go:355`; `signup_orders.credentials_sent_at` | **Absent at scale** | No invitation table, no invite token, no bulk credential creation or delivery. `users.status='invited'` (`admin.go:104`) has no token and no email flow. The `staff` importer creates `employees`, not logins. Day one, a 60-teacher school has one password | **P0** |
| Training | — | **Absent (vendor-side)** | `staff_training_records` is the school's own register. No vendor training session, attendee, material or completion record | P1 |
| Go-live | — | **Absent** | Zero hits for `cutover`, `go_live`, `readiness`. Nearest artefact is `setup_percent` | P1 |
| Support | `support_tickets`, `impersonation_audit`; `audience` column (`00038:633`), vendor queue index, `impersonation_grants` (`00038:475`) | **Built, good** | The impersonation register is the best-designed thing in the seller tier — mandatory reason ≥8 chars, hard 4-hour expiry cap, ticket linkage, and RLS so the **school** can read who entered it | — |
| SLA / escalation | `support_tickets.priority` | **Absent** | Priority enum only. No response/resolution target, no `due_at`, no first-response stamp, no breach flag, no escalation tier, no business-hours calendar, no link from `plans` to a support tier — so the tiers cannot be sold | P1 |
| Invoicing the school | — | **Absent** | No table anywhere bills a tenant. `invoices` is `institution_id`-scoped and `student_id`-bearing with FORCE RLS — the *school* billing a *parent*. No vendor GSTIN, no HSN/SAC, no place-of-supply, no invoice series | **P0** |
| Collecting from the school | `signup_orders` + `SignupPages.Pay/Callback` `signup.go:220,257` | **Simulated, once only** | `signup.go:45-52`: *"There are no Razorpay API keys on this installation, so nothing here talks to Razorpay. What it does instead is implement Razorpay's shape exactly."* Signature minted locally (`signup.go:466`). **No recurring charge, no card-on-file, no eNACH/mandate, no second payment ever.** Renewal collects nothing | **P0** |
| Dunning | — | **Absent** | Zero hits for `dunning`. `status='past_due'` is set by hand via `setSubscription` (`seller.go:293`); nothing computes it from `renews_on`, no grace period, no reminder sequence, no amount | **P0** |
| Renewal | `seat_overage_renewals`; `subscriptions.renews_on` + partial index `subscriptions_renews_on` (`00011:53`) | **Date only** | No renewal quote, task, reminder, auto-renew job or expiry sweeper. Nothing in `cmd/` or jobs reads `renews_on`. A subscription passes its date and keeps working until a human notices | **P0** |
| Upgrade / expansion | `seat_overage_renewals`; `OverBy` computed in Go at `seller.go:112` | Partial | Seat overage is a **displayed number** (`students - licensed_students`). Not persisted, not enforced, not charged, no true-up. Plan change has no proration and no credit note | P1 |
| Churn / cancellation | `suspend_reactivate`; `subscriptions.status='cancelled'`, `institutions.status='suspended'` (`seller.go:350`) | **Absent as a process** | No cancellation date, reason code, requester or effective date. No churn-risk model beyond `AtRisk` in adoption. Zero hits for `win-back`, `offboarding`. `entitlement.go:257` tells a cancelled school *"Your data is retained"* — nothing implements retrieval | **P0** |
| Adoption / health | `adoption_metrics`, `instance_health`; `platform_config.go:3464,3603` | Built, shallow | See below | P2 |

## The serious findings, with evidence

### B1 · There is no way to sell the product at a price (P0)

Three absences compound into one. `plans.price_paise` and `plans.price_monthly_paise` are properties
of a plan *code*, seeded with three rows in `00011_seller.sql:16-27`. `signup_orders.amount_paise` is
copied straight from the plan (`signup.go:628 amountFor`). There is **no per-tenant price column on
`subscriptions` or anywhere else** — a grep for `discount` in a subscription context finds only
`invoices.discount_paise` and `invoice_lines.discount_paise`, which are the school discounting a
*parent's* fees.

So: no quotation to send, no negotiated price to record, and therefore nothing for a discount-approval
workflow to approve. Every deal in the Indian school market is negotiated — on head-count bands, on
multi-year terms, on a free first year for a lighthouse account. This product can sell exactly three
prices, take-it-or-leave-it, and if a salesperson agrees anything else the system has nowhere to put
it. That is the single largest commercial gap, and it is upstream of the invoicing and renewal gaps
below: you cannot bill what you cannot price.

### B2 · Money is never billed and never collected after day one (P0)

The only payment path in the entire product that moves money from a school to the vendor is
`signup_orders`, and `internal/api/signup.go:45-52` states in terms that it is a **simulator** —
Razorpay's request/response shape reimplemented locally, with the signature minted by `sign`
(`signup.go:466`) and verified by the same code, against a stand-in secret in `config.go:34`. Even if
it were real, it fires once, at self-signup.

Beyond that: no vendor invoice table, no GST invoice to a tenant (all GST machinery in `00023`,
`00046`, `00049` is the school's own statutory and Tally work), no card-on-file, no eNACH mandate, no
recurring charge, no dunning (`dunning` returns zero hits repo-wide), no grace period on the
subscription gate, and nothing that computes `past_due` from `renews_on`. `subscriptions.status` moves
only when a human calls `PUT /seller/tenants/{id}/subscription` (`seller.go:293`).

The practical shape of this: the vendor's finance function runs entirely outside the product. Invoices
are raised in Tally or Zoho, payments chased over WhatsApp, and someone remembers to log into the
seller console and flip a status. The "Subscription Ledger" records none of it — because, as
established, it is a list of tenants.

Two latent defects worth flagging while in this area. `internal/api/seller.go:322` writes
`ON CONFLICT (institution_id) WHERE status <> 'cancelled'` — **no such partial unique index exists**;
the arbiter falls back to the total primary key, so the `DO UPDATE` silently resurrects a cancelled
subscription instead of creating a new one. And because the PK is `(institution_id)`, a school that
churns and returns can never have a second subscription row: its history is overwritten by its
comeback.

### B3 · Onboarding is a percentage, not a project (P1, tipping to P0 with the import gap)

`seller_admin.customers.onboarding_progress` is implemented entirely as a SQL expression inside
`listTenants` (`seller.go:80-92`): ten `EXISTS` probes — profile fields set, then any row in
`campuses`, `academic_years`, `classes`, `sections`, `subjects`, `employees`, `students`, `fee_heads`,
`exams` — multiplied by ten and returned as `setup_percent`. That is the whole feature.

Onboarding an Indian school onto an ERP is a six-to-ten week project with an implementation owner, a
data-migration cut, a parallel-run period and a sign-off. There is no table for any of it: no
checklist, no task, no assignee, no due date, no blocker, no acceptance. A vendor running twenty
implementations concurrently tracks them in a spreadsheet — precisely the "parallel spreadsheet"
failure mode.

It becomes P0 when combined with the import surface. `importSpecs` (`bulk_import.go:105`) covers
exactly **three** entities — `classes`, `sections`, `staff` — plus a separate students importer
(`students_write.go:378`, 8 MB CSV cap). The importer itself is well built: dry-run by default,
`?commit=true` to write, per-row errors with row numbers, header matching that is case- and
space-insensitive because *"the sheet came out of somebody else's software"*, one transaction. But
there is no importer for guardians, fee structures, **opening fee balances**, historical marks,
attendance history, library catalogue, transport routes or hostel rooms. No XLSX support at all. And
`bulk_import.go:340` resolves the target year with `WHERE is_current` — so you cannot even import next
year's sections, which is the Part A defect showing up in the sales motion.

The consequence: a school switching from an incumbent ERP arrives with several years of ledger and
academic history and no route to bring it in. Combined with the absent arrears model (A3), the school
either starts from zero mid-year or does not switch. Data migration is the commonest reason an ERP
deal dies, and it has no product surface here.

### B4 · Go-live has no credentials (P0)

`provisionSchool` (`provision.go:90`) creates one admin user and returns the plaintext password once.
`resetTenantAdmin` (`seller.go:355`) can reissue it. `signup_orders.credentials_sent_at` records that a
welcome email went out. That is the sum of user provisioning.

There is no invitation table, no invite token, no bulk user creation with credential delivery, no
password-reset-on-first-login flow surfaced to the vendor, no way to onboard sixty teachers and eight
hundred parents. `users.status='invited'` exists (`admin.go:104`) but carries no token and no email
path, and the `staff` bulk importer creates `employees` rows, not logins. Go-live day at a 1,200-pupil
school is the moment the ERP either lands or doesn't, and the product has no mechanism for it.

### B5 · Adoption and health are honest but thin (P2)

Both are computed live and persist nothing. `getAdoptionMetrics` (`platform_config.go:3464`) measures,
over a fixed 28-day window: `count(*) FROM sessions`, `count(DISTINCT user_id) FROM sessions`,
`count(*) FROM audit_log`, and `max(users.last_login_at)` → `quiet_days`; derives
`ActivePercent = active_28 * 100 / accounts` and flags `AtRisk` at ≥14 quiet days. There is **no
telemetry table and no feature-level instrumentation** — no per-module usage, so the vendor cannot
tell whether the school it sold the `complete` plan to has ever opened the library module, which is
the question that drives both renewal and upsell. It is deliberately aggregate-only and never names a
user, which is a defensible privacy stance, but it means churn risk is a single number derived from
login recency.

`getInstanceHealth` (`platform_config.go:3603`) is more useful — failing integrations with a
`failing_providers` array, failed messages and payments in 24h, open vendor tickets, today's
attendance rows, sessions in 24h, plus queue depths (asynq's when this was written; River's now, in the same columns) — and it is candid about its limits: a
`not_measured` field at `:3612` states that *"Per-endpoint error rates and response times are written
to the structured log and are not stored, so they cannot be reported here."* No CPU/memory/disk, no DB
or replication metrics, no uptime, no alerting.

### B6 · What is genuinely good

Worth recording so the gaps are read in proportion. `provisionSchool` is a single clean transaction.
The 402 paywall (`gate.go:71`) with its `openWhileLocked` allow-list and typed lock reasons
(`entitlement.go:213-261`) is well factored. The module entitlement matrix is real per-tenant
configuration, not a display. The vendor/school ticket split via a single `audience` column with the
constraint `audience = 'school' OR student_id IS NULL` — a vendor ticket may never name a child — is
elegant. And `impersonation_grants` is the strongest table in the seller tier: a mandatory reason of at
least eight characters, a hard cap of four hours enforced by
`CHECK (expires_at <= started_at + interval '4 hours')`, an optional ticket link, the operator's name
denormalised so it survives account deletion, and RLS that lets the *school* audit the vendor. Very
few Indian school ERPs can show that.

## Priority summary

| # | Gap | Part | Sev |
|---|---|---|---|
| 1 | No academic-year close, lock or immutability on academic data | A | P0 |
| 2 | `is_current` is one global flag; ~15 handlers read it with no override — two live years impossible | A | P0 |
| 3 | No fee arrears / opening balance / carry-forward | A | P0 |
| 4 | Attendance % computed over a student's lifetime, including on the TC | A | P0 |
| 5 | TC exists but misses prescribed fields, ignores `serial_prefix`, has no dues/clearance gate, bypasses approval | A | P0 |
| 6 | No negotiated or per-tenant pricing, therefore no quotation and no discount approval | B | P0 |
| 7 | No contract object: no term, end date, auto-renewal or notice period | B | P0 |
| 8 | No vendor invoice to the school, no GST, no recurring collection, no dunning; the gateway is a simulator | B | P0 |
| 9 | Renewal is a date with no workflow; nothing reads `renews_on` | B | P0 |
| 10 | No historical-data migration path (fees, ledger, marks, attendance) | B | P0 |
| 11 | No user invitation or bulk credentialing at go-live | B | P0 |
| 12 | No cancellation/churn record and no data export on exit | B | P0 |
| 13 | `subscriptions` PK `(institution_id)` destroys all commercial history | B | P0 |
| 14 | Promotion is one section at a time, carries nothing, no undo; `'detained'` is never written | A | P1 |
| 15 | No structure/timetable/fee/transport/hostel roll-forward — April is rebuilt by hand | A | P1 |
| 16 | No student exit clearance (staff have one, enforced in the database) | A | P1 |
| 17 | No inventory period, opening/closing stock or year-end valuation | A | P1 |
| 18 | Leave carry-forward policy modelled but never computed | A | P1 |
| 19 | Onboarding is a 10-probe percentage, not a project with owners and dates | B | P1 |
| 20 | No SLA targets or escalation; support tiers cannot be sold | B | P1 |
| 21 | Vendor lead inbox has no owner, follow-up date or activity log; demo is a string | B | P1 |
| 22 | No vendor-delivered training records; no go-live checklist | B | P1 |
