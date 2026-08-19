# Gap analysis 01 — Pre-year planning (July of the previous year to January)

Scope: everything an Indian school does between roughly nine and three months
before an April–March academic year opens, before any student is onboarded.
Evidence is `docs/ROLES_AND_FEATURES.csv` (452 features), the fuller summaries
in `internal/catalog/catalog_gen.go`, and the schema and handlers in
`migrations/` and `internal/api/`.

## Verdict

The pre-year slice is better covered than most ERPs of this size. The
admissions funnel is a real funnel with real state (`enquiries` → `applications`
→ `admission_assessments` → merit → offer → `enrolments`), procurement is a real
requisition-approval-PO-GRN chain, and — the single best thing in this slice —
the timetable solver deliberately treats *"this subject has no teacher yet"* as
a warning rather than a refusal (`internal/timetable/solver.go:862`,
`solver_test.go:296`), with drafts scoped to an `academic_year_id` and an
explicit unpublished state. That is exactly the pre-year behaviour a school
needs and it was clearly built on purpose.

Three things are seriously wrong, and all three are the same shape: a record
exists where a workflow is needed, or a chain that looks joined is not actually
joined.

1. **Fee approval never becomes the fee that is charged.** The regulatory
   filing and the versioned structure both exist and are well built, but neither
   invoice-generating code path cites a version, and activating a version checks
   nothing about approval. The statutory loop is open.
2. **Seat availability ignores the academic year.** The seat matrix and the
   "refuse to over-offer" guard sum *all* sections of a class and count *all*
   active enrolments, with no year filter. The moment a school does the normal
   thing — create next year's sections in November while this year runs —
   capacity doubles and this year's children occupy next year's seats.
3. **Curriculum has no year dimension at all.** `class_subjects` has no
   `academic_year_id`. Deciding next year's subject offering necessarily
   rewrites this year's.

Beyond those, the recurring pattern is *planning targets are missing while
actuals are complete*: there is no intake target, no sanctioned staff strength,
no enrolment projection. The ERP can tell a school what happened and cannot
help it decide what should.

## Activity → coverage table

| Activity | Covering feature(s) and key | Status | Gap | Severity |
|---|---|---|---|---|
| School planning (annual calendar, terms, working days) | `institution_admin.academics.academic_calendar`; `super_admin.campuses_academic_year.academic_calendar_model`; `institution_admin.statutory_returns.working_days_instructional_hours` | built | Solid. `holidays` and `terms` carry `academic_year_id`; `POST /academic-years` (`internal/api/setup.go:56`) creates a future year without making it current, and `academic_years_one_current` keeps exactly one live. No gap. | — |
| Fee structure design | `finance.fee_structure.fee_head_group_setup`, `.class_wise_fee_structure_configuration`, `.fee_structure_versioning` | built | Design is genuinely covered; `fee_structures.academic_year_id` means next year's structure can exist alongside this year's. | — |
| Fee structure **approval** | `institution_admin.fees.fee_regulatory_committee_filing` (+ `fee_regulatory_filings`, `_lines`, `_documents`) | built as a record | No internal (management/board) approval state on `fee_structure_versions` — statuses are only `draft`/`active`/`superseded`. `activateStructureVersion` (`internal/api/fee_engine.go:531`) checks only that lines exist. Nothing requires a filing, or an approved filing, before a version goes live. | **P0** |
| Approved fee → the fee invoiced | `finance.fee_structure.demand_invoice_generation` | built but disconnected | Both invoice paths (`internal/api/fees.go:648` reading `fee_structure_items`, and `internal/api/collections.go:1587`) leave `invoices.fee_structure_version_id` NULL. `fee_regulatory_filing_lines.approved_paise` is captured and never written back to any billing table. | **P0** |
| Classes and sections planned for next year | `institution_admin.academics.classes_sections`, `.academic_structure`; `institution_admin.students.class_section_promotion` | built | `sections.academic_year_id` exists, `listSections` and `createSection` both accept `academic_year_id` (`internal/api/academics.go:99`, `setup.go:143`), `promoteStudents` targets an explicit year. Two years can coexist here. No bulk "clone last year's sections" — minor. | P3 |
| Subjects and curriculum for next year | `institution_admin.academics.classes_sections`, `.subject_chapter_planner`, `.obe_outcomes` | partial | `public.class_subjects` has **no `academic_year_id`** and no versioning; `max_marks` and `is_elective` live on it. Changing next year's offering retroactively changes this year's, including marks caps on exams already conducted. `syllabus_units` hang off `class_subjects` and inherit the problem. | **P1** |
| Staff requirement planning | `hr.hiring_growth.recruitment` (`job_vacancies`) | partial | `job_vacancies` is a good *vacancy* record — `academic_year_id`, `subject_id`, `positions`, `justification`, `approved_by` (`migrations/00054_hr_growth.sql:26`). But there is no establishment/sanctioned-strength model, and nothing derives the requirement from next year's sections × subjects × periods against present teachers. "We need 3 more maths teachers" is asserted, never computed. | **P1** |
| Admissions planning / intake targets | `admissions.home.admissions_kpis`, `admissions.reports.admission_conversion_reports`, `super_admin.dashboard.central_admission_funnel_kpi` | partial | Every admissions metric is an actual. No intake target, no enrolment projection: grep for a target/projection column across `migrations/` returns nothing in the admissions domain. `sections.capacity` is the only number that resembles a plan, and it is an operational cap, not a target. | **P1** |
| Vendor selection | `finance.payables.vendor_management_accounts_payable`; `institution_admin.stores.purchase_order_workflow` | partial — catalog claim unbacked | The `purchase_order_workflow` summary says "compare vendor quotes". There is **no quotation/RFQ/comparative-statement table** anywhere in `migrations/`; `purchase_orders` (`00053_admin_ops.sql:280`) simply carries a `vendor_id`. Selection rationale is unrecorded. (`purchase_enquiries` is the ERP vendor's own sales leads, not school procurement — a name collision worth knowing about.) | **P1** |
| Books planning | `institution_admin.library.ncert_textbook_indent` (`textbook_indents`) | partial | Good three-count model (requested/received/issued) with `academic_year_id`. But `listTextbookIndents` (`internal/api/library_desk.go:563`) computes shortfall against the *current* active roll for the class, with no year filter and no projected roll. In February you are ordering for June against last June's numbers. | **P1** |
| Uniforms and stationery planning | `finance.collections.school_store_merchandise_sales` (`store_products`, `store_product_variants`); `institution_admin.stores.item_category_store_setup` | partial | Catalogue and stock exist; no demand forecast, no size-mix planning, no link from projected intake to order quantity. | P2 |
| Transport route planning | `institution_admin.transport.routes_stops`, `.route_pickup_stop_mapping`, `.route_distance_fee_slabs` | partial | `public.routes` has no `academic_year_id` and no draft state. Planning next year's routes means editing the live ones that buses are running on today. | P2 |
| Infrastructure and capacity planning | `institution_admin.academics.academic_structure` | mostly missing | `academic_structure`'s summary promises "…and rooms". There is no room master: `sections.room` and `timetable_draft_entries.room` are free text (`00050_timetable.sql:230`), and there is no room-clash unique index, so `master_timetable_generation`'s claimed "room constraints" are not enforced either. Only `exam_halls` and `hostel_rooms` are modelled. | **P1** |
| Admission campaign | `admissions.enquiries.multi_touch_campaign_sequences`, `.utm_tracking_digital_campaign_attribution`, `.lead_source_tracking`, `.admissions_open_day_scheduler`, `.prospectus_kit_sales_log` | built | `admission_campaigns`/`_steps`/`_sends`/`_enrolments` with auto-enrol by source. Strong. Chatbot and voice agent are `deferred`, correctly. | — |
| Enquiries | `admissions.enquiries.enquiries_leads`, `.counselor_lead_assignment`, `.counselor_activity_follow_ups`, `admissions.reports.lost_lead_reason_analysis` | built | Complete for the role that does the work. | — |
| Applications | `admissions.applications.applications`, `.online_application_form_builder`, `.applicant_documents` | built | Real form versioning (`admission_forms`, `_versions`, `_fields`, `application_form_answers`); applications are year-scoped via `admission_session_id → academic_year_id`. | — |
| Entrance tests | `admissions.applications.entrance_exam_scheduling` | built | `admission_assessments` with `kind='entrance_test'`, score, outcome (`00001_baseline.sql:127`). | — |
| Interviews | `admissions.applications.interview_interaction_scheduler` | built | Same table, `kind='interview'`. | — |
| Student selection | `admissions.admissions.merit_list_generation`, `.offers_admission_decisions`, `.provisional_offer_letters`, `.admission_waitlist_management`, `.sibling_priority_auto_matching`, `.alumni_child_quota_allocation` | built | Weighted merit, decision state machine, waitlist with rank uniqueness (migration 00027). | — |
| **Seat allocation** | `admissions.admissions.seat_allocation_management` | built but wrong across years | `getSeatMatrix` and the over-offer guard in `decideApplication` (`internal/api/mod_admissions.go:383`, `:436`) sum `sections.capacity` and count `enrollments.status='active'` **with no `academic_year_id` filter**. Also, the catalog promises quotas "(General, RTE, Management, Sports, Sibling)" but only RTE exists, derived as `capacity / 4`; there is no per-quota seat table despite `applications.quota` carrying eight values. | **P0** (year bug) / **P1** (quotas) |
| Fee quotations to applicants | — | not found | `applications` carries only `form_fee_paise`/`form_fee_receipt` (`00026_admissions_funnel.sql:71`). There is no entity that quotes an applicant the annual fee schedule before acceptance, and no link from an offer to a fee structure. `admissions.admissions.admission_fee_collection` collects, it does not quote. | P2 |
| Staff recruitment | `hr.hiring_growth.recruitment` | built | `job_vacancies` → `job_candidates` → `job_interviews` → `job_offers` → `hireCandidate`, with a vacancy approval step (`internal/api/hr_growth.go:522`). Genuinely a workflow, not a table. | — |
| Timetable planning before teachers exist | `institution_admin.academics.master_timetable_generation`, `.timetable`; `super_admin.ai_automation.automated_timetable_optimizer` | built, and built correctly | `timetable_drafts.academic_year_id`, `status draft/published/discarded`, `timetable_draft_entries.teacher_user_id` nullable, and the solver reports an unstaffed subject as a warning. Best-covered item in this slice. Only gap: no room-clash constraint (above). | — |
| Procurement | `institution_admin.stores.purchase_order_workflow` (`purchase_requisitions`, `_lines`, `purchase_orders`, `goods_receipts`, `purchase_approval_thresholds`) | built | Value-banded approval ladder captured at submission, trigger-maintained receipt status. Well built. Gaps are the missing quotes (above) and no link to projected enrolment. | — |
| Budgeting for next year | `finance.assets_budget.budgeting_variance_analysis` (`budgets`, `budget_lines`) | built | Present; not verified against a next-year workflow. | — |

## The findings that matter

### 1. The fee approval chain is three good records that do not touch each other (P0)

Several states — Tamil Nadu, Karnataka, Maharashtra, Andhra Pradesh, Telangana
among them — require a school to file its proposed fee with a regulatory
committee and charge only what is approved. This ERP builds all three pieces
and joins none of them.

`fee_regulatory_filings` (`migrations/00053_admin_ops.sql:1409`) is genuinely
well designed: it has a `fee_structure_version_id`, a status vocabulary that
includes `approved_with_modification`, a frozen `filed_snapshot`, and
`fee_regulatory_filing_lines.approved_paise` to record the amount the committee
allowed where it differs from `proposed_paise`. `submitFiling`
(`internal/api/admin_ops.go:~3935`) even refuses to file without supporting
accounts attached, which is the right instinct.

Then the chain stops.

- `activateStructureVersion` (`internal/api/fee_engine.go:531`) moves a version
  from `draft` to `active` on the strength of one check: that it has at least
  one line. It does not look at `fee_regulatory_filings` at all. A school can
  activate an unfiled, unapproved fee structure and start billing.
- There is no internal approval state either. `fee_structure_versions.status`
  is `draft | active | superseded` (`migrations/00045_fee_engine.sql:73`).
  A trust board resolution approving next year's fee has nowhere to live.
- Worst, `approved_paise` is written and then never read by anything that
  bills. Nothing copies it into `fee_structure_version_items`, and no handler
  compares the two. If the committee cuts the development fee by ₹2,000, the
  ERP records that fact and keeps invoicing the original amount.
- And the versioning is decorative for the main billing path anyway: the demand
  generator at `internal/api/fees.go:648` reads `fee_structure_items` — the
  *unversioned* table — and never populates `invoices.fee_structure_version_id`.
  The ad-hoc invoice path at `internal/api/collections.go:1587` does not set it
  either. The only writes to that column in production code are the fine engine
  reading it back. So the careful `ON DELETE RESTRICT` guaranteeing "an invoice
  can always name the version it was raised under" protects a column that is
  NULL on every invoice the system produces.

Why it matters: this is the one activity in the whole pre-year slice that is a
statutory precondition to taking money. A school audited by a fee committee is
asked to show that what it charged equals what was approved. Here that question
cannot be answered from the database — the filing and the invoice have no
common key.

### 2. Seat availability is computed across all academic years at once (P0)

`getSeatMatrix` (`internal/api/mod_admissions.go:383`):

```sql
FROM classes c
LEFT JOIN sections sec ON sec.class_id = c.id
```

No `academic_year_id` predicate, on either the sections or the enrolment
subqueries. The same untethered arithmetic is repeated inline in
`decideApplication` (`:436`) as the guard that refuses to over-offer a class.

The system *encourages* the situation that breaks this. `createSection`
(`internal/api/setup.go:152`) accepts an explicit `academic_year_id`,
`createAcademicYear` (`:56`) creates a future year without disturbing
`is_current`, and `listSections` filters by year. Creating 2026-27's sections in
November 2025 while 2025-26 runs is the supported, intended, and universal
practice. Do it, and:

- **capacity doubles** — Class 1's two current sections plus two next-year
  sections read as 160 seats, not 80;
- **this year's children block next year's seats** — 78 currently enrolled
  Class 1 students are subtracted from next year's Class 1 availability,
  even though they will be in Class 2;
- both errors are in opposite directions, so the number looks plausible right
  up to the day the roll is called.

The comment above the guard reads "Overselling a class is discovered on the
first day of term, when it cannot be undone." The guard is correct in intent
and cannot deliver it. Note that the same year-blind roll count appears in
`listTextbookIndents` (`internal/api/library_desk.go:576`), so the shortfall
figure a librarian orders against inherits the same defect.

Alongside it: `seat_allocation_management`'s catalog summary promises quota
management for "General, RTE, Management, Sports, Sibling". `applications.quota`
accepts eight values (`00026_admissions_funnel.sql:76`) and there is a
`counselor`-facing register for RTE, but **there is no per-quota seat table**.
The only quota in the seat matrix is RTE, hard-derived as `capacity / 4`. A
school that has committed 15 management seats in Class 11 cannot express that,
and will run the quota on paper. That is P1 in its own right.

### 3. Curriculum has no year dimension (P1)

`public.class_subjects` (`migrations/00001_baseline.sql:336`) holds
`class_id`, `subject_id`, `is_elective`, `max_marks` — and no
`academic_year_id`. It is the join every downstream academic object hangs off:
`syllabus_units`, `lesson_plans`, `timetable_draft_entries.class_subject_id`,
`section_subject_teachers`, exam subject mapping.

So the November conversation "next year Class 9 drops Sanskrit and adds AI"
cannot be recorded as next year's plan. Editing `class_subjects` edits the
running year — retroactively, including `max_marks` on subjects whose exams
have already been marked. The only escape is to defer curriculum changes until
after the year rolls over, which is precisely backwards: the timetable draft,
the textbook indent and the staff requirement all depend on knowing next year's
subject list months ahead. The ERP has a year-scoped draft timetable that can
only be built against an un-year-scoped curriculum.

### 4. Everything is an actual; nothing is a target (P1)

Three separate pre-year activities fail the same way, and they are worth
reading together because a single "planning" concept would fix all three:

- **Intake targets** — no target column exists in the admissions schema.
  `admissions.home.admissions_kpis` and `.admission_conversion_reports` report
  the funnel that happened. "We intend to admit 60 in Class 1 and expect a 3:1
  application ratio" has nowhere to go, so the campaign cannot be judged
  against it in December when there is still time to act.
- **Staff requirement** — `job_vacancies` records a post with a justification
  and an approval (`migrations/00054_hr_growth.sql:26`), which is more than most
  systems have. But the requirement is typed, not derived. Nothing in
  `internal/api/hr_growth.go` compares next year's sections × subjects ×
  periods-per-week against present teaching strength and `teacher_load_rules`
  caps. The data to compute it is all present; the computation is not there.
- **Procurement quantities** — `textbook_indents.qty_requested` is typed by
  hand, `purchase_requisition_lines.quantity` likewise. Neither can cite a
  projected roll. Books ordered in February against a projection that lives in
  Excel is the definition of the parallel-spreadsheet failure mode.

Each of these individually is survivable. Together they mean the whole "9 to 6
months before" band of the year — which is planning, and nothing but planning —
runs outside the ERP, and the ERP is only picked up once the plan has to be
executed. That is how a school ends up trusting the spreadsheet over the system.

## Smaller findings, for completeness

- **No room master.** `academic_structure` claims rooms; `sections.room` and
  `timetable_draft_entries.room` are free text and there is no room-clash index
  on the draft (`migrations/00050_timetable.sql:230`), so
  `master_timetable_generation`'s advertised "room and subject constraints"
  cover subjects and teachers, not rooms. Infrastructure capacity planning is
  effectively absent. **P1.**
- **No vendor quotation entity.** `purchase_order_workflow` promises quote
  comparison; no such table exists. For a grant-in-aid school that must show a
  comparative statement to its auditor, that is a parallel file. **P1.**
- **Routes are not year-scoped and have no draft state.** `public.routes`
  (`00001_baseline.sql:1217`) is a live operational record; next year's route
  plan overwrites this year's. **P2.**
- **No fee quotation to an applicant.** Only the application form fee is
  modelled (`applications.form_fee_paise`). An offer cannot carry the fee
  schedule the parent is deciding against. **P2.**
- **No "clone last year's structure" rollover.** Sections, fee structures and
  class-subject maps for next year must each be created by hand. Everything
  needed is year-keyed, so this is convenience, not correctness. **P3.**
- **Naming trap, noted for whoever reads the catalog next:**
  `purchase_enquiries` (`migrations/00013_purchase_enquiries.sql`) is the
  *product's own* sales pipeline, not school procurement. School-side
  procurement is `purchase_requisitions`.

## What is genuinely clean

Stated plainly, because these were checked and found sound rather than assumed:
the admissions funnel from enquiry to enrolment handoff; campaign sequencing
and lead attribution; entrance tests and interviews as one assessment model;
the recruitment ATS including a vacancy approval gate; the requisition → PO →
GRN chain with a value-banded approval ladder; academic year, term and holiday
modelling including the ability to stand up a future year without disturbing the
current one; and the draft timetable, which is the only feature in this slice
that was clearly designed by someone who had thought about what a school does
in January.
