# Gap analysis 03 — the monthly and term cycles

Scope: the recurring work of an Indian school year — the month end (fees, payroll,
attendance, expenses, management reporting), the two terms (exams, marks, report cards,
PTM, promotion) and the mid-year churn (joiners, leavers, section changes).
Evidence: `docs/ROLES_AND_FEATURES.csv` (452 features), `internal/catalog/catalog_gen.go`,
`migrations/`, `internal/api/`.

## Verdict

The *records* for this slice are unusually complete: exam halls and seat allocation
(`migrations/00015_exam_halls.sql`), a marks sign-off endpoint that refuses a half-entered
paper (`internal/api/admin_academics.go:532`), PTM notes with concerns and agreed actions
carried into the next meeting (`migrations/00029_faculty_remarks.sql:84`), a real
financial-year close with a database trigger that refuses postings into a closed year
(`internal/api/ledgers.go:1434`), TC issuance that freezes a snapshot and closes the
enrolment (`internal/api/mod_academics.go:667`), a collection tie-out an auditor can use
(`internal/api/admin_rollups.go:1029`). This is better than most of what is sold in this
market and it deserves saying plainly.

What is missing is almost entirely at the *joins* — the point where one month's work is
declared finished and handed to the next. There is no month-end anything: the close exists
only at financial-year granularity, so last September's receipts, payslips and marks stay
editable forever. Three chains are cut mid-way and the cut is invisible from the feature
list, which is the failure mode this exercise is looking for: **refunds** are catalogued
`built` but the API is read-only, so no refund can ever be created or approved and the
payout that consumes `status='approved'` refunds can never fire; **payroll runs** have a
`draft → processed → locked → paid` state machine of which only `processed` is ever
written, so a month already paid into the bank can be silently recomputed; and **the
per-paper datesheet** (`exam_subjects.exam_date`, `starts_at`, `duration_minutes`) is read
by six screens and written by none, so a school cannot enter the exam timetable the hall
ticket is supposed to print. Beyond that, report cards have no term dimension on the path
that computes marks, and marks approval does not lock the marks.

## Activity table

| Activity | Covering features (key) | Status | Gap | Sev |
|---|---|---|---|---|
| **MONTHLY** |
| Fee demand / invoice raising | `finance.fee_structure.demand_invoice_generation`, `finance.fee_structure.class_wise_fee_structure_configuration`, `finance.fee_structure.fee_structure_versioning` | built, real (`internal/api/fees.go:595`) | Per-instalment, per-class bulk only; no enrolment-date awareness (see mid-year joiners) | P1 |
| Fee collection & receipts | `finance.collections.collect_payment`, `.receipts`, `.online_payments`, `.partial_advance_payments`, `finance.collections.gst_compliant_receipt_numbering` | built | Well covered | — |
| Dues, ageing, defaulters | `finance.student_dues.student_ledger`, `.defaulters_reminders`, `.automated_fee_reminders`, `.late_fine_rules_engine`, `.cheque_bounce_fine_engine`, `.post_dated_cheques_pdc_registry` | built (ageing buckets at `internal/api/fees.go:527`) | Well covered | — |
| Refunds (of any kind) | `finance.concessions_refunds.refunds` | **catalogued built; read-only in fact** | Only `listRefunds` exists (`internal/api/fees.go:774`). No create, approve or process handler anywhere; `banking.go:869` pays out `refunds` at `status='approved'`, a status nothing can set | **P0** |
| Monthly reconciliation | `finance.reconciliation.reconciliation`, `.bank_reconciliation_statement_brs`, `.payment_gateway_reconciliation` | built; BRS finalise freezes the period (`internal/api/banking.go:1880`) | Good. But BRS finalisation is the *only* per-period freeze in finance | — |
| Month-end close (fees + payroll + expenses) | `finance.ledgers.financial_year_closing` | built, but **annual only** (`accounting_years`, `migrations/00033_ledgers.sql:136`) | No monthly period lock. Receipts, payslips, journals and marks for any past month remain editable until the whole FY is closed | **P0** |
| Payroll run | `hr.payroll.payroll`, `.salary_structure_builder`, `.employee_ctc_breakup_calculator`, `.substitute_workload_allowance`, `.staff_loan_advance_management`, `.pf_encashment_loan_deduction`, `.overtime_ot_rate_setup` | built (`internal/api/mod_ops.go:501`) | Deletes and rebuilds payslips on every re-run; `locked`/`paid` never written; LOP computed differently from the LOP register (below) | **P0** |
| LOP from attendance and leave | `hr.leave.late_arrival_loss_of_pay_lop`, `.half_day_leave_deduction_calculation`, `.leave_policy_configuration`, `hr.attendance.staff_attendance` | built — twice, disagreeing | `staff_lop_register()` honours the policy (half days, late marks, unpaid leave, caps); payroll instead counts `staff_attendance.status='absent'` inline (`mod_ops.go:553`). The screen and the payslip give different numbers | **P0** |
| Statutory deductions PF / ESI / PT | `hr.statutory.pf_esi_statutory_compliance`, `.professional_tax_pt_slab_configuration` | built and computed from the wage (`payroll_statutory.go:246`) | Good | — |
| TDS on salary | `hr.statutory.form_12bb_investment_declarations`, `hr.statutory.income_tax_form_16_generator` | partial | `computeStatutory` deducts PF/ESI/PT only — **no TDS line on the payslip**. `getTaxComputation` produces `monthly_tds_paise` as an advisory figure nothing consumes; no Form 16 endpoint exists despite the catalogued generator | **P0** |
| Payslip issue to staff | `hr.payroll.payslip_generation_email_dispatch` | partial | `payslips` rows and `listPayslips` exist; no PDF, no password-protected dispatch, no publish-to-portal handler found | P1 |
| Bank transfer file | `hr.payroll.direct_bank_payroll_transfer_file`, `finance.reconciliation.connected_banking_payouts` | built (`getBankFile`, `payout_batches`/`payout_items`) | Payout accepts payslips at `status IN ('processed','locked')` — and since the run is never locked, the same payslip can be recomputed after export | P1 |
| Statutory returns after payroll | `hr.statutory.pf_esi_statutory_compliance` (ECR), `.staff_gratuity_liability_estimator` | partial | EPFO ECR file exists (`payroll_statutory.go:411`). No ESI return file, no PT challan, no Form 24Q | P1 |
| Staff attendance capture | `hr.attendance.staff_attendance`, `.staff_shift_rostering` | built | Biometric sync is `deferred` (`hr.attendance.biometric_machine_attendance_sync`) — a school without it types attendance for payroll by hand | P2 |
| Student attendance reports | `institution_admin.standard.comprehensive_attendance_report`, `institution_admin.academics.attendance_monitoring`, `faculty.attendance.take_attendance`, `.attendance_correction` | built but unbounded | `getAttendanceTrend` is hard-wired to 30 days; `getAttendanceShortage` aggregates **all attendance ever recorded**, with no year or term bound (`internal/api/role_principal.go:104,138`). No monthly register against working days | P1 |
| Expenses | `finance.ledgers.expenses_accounting`, `finance.payables.vendor_management_accounts_payable`, `.petty_cash_voucher_management`, `finance.ledgers.general_ledger_trial_balance` | built, double-entry, with source-keyed idempotence | Well covered | — |
| Management report to trustees | `institution_admin.home.executive_kpis`, `institution_admin.standard.reports`, `.fee_collection_summaries`, `institution_admin.analysis.custom_report_builder`, `institution_admin.analysis.performance_analytics` | partial | Operational dashboards, not a board pack. No collection-against-target (no target is stored anywhere), no staff-cost ratio, no enrolment movement (joiners/leavers in period), no month-on-month. There is also **no trustee/management role** in the catalogue at all | P1 |
| **TERM** |
| Exam creation & weightage | `institution_admin.examinations.exams_results`, `.exams_result_status` | built (`internal/api/setup.go:685`) | Exam header only | — |
| Datesheet — per-paper date, time, duration | *(no key)* | **missing** | `exam_subjects.exam_date`/`starts_at`/`duration_minutes` are read in eight places and written by nothing. The hall-ticket and student calendar queries that print them will always show blank | **P0** |
| Seating / hall allocation | `institution_admin.examinations.hall_ticket_issue` + `exam_halls`, `exam_seats` | built, and good — grid seating, one candidate one desk, verification code (`internal/api/exam_hall.go`) | Depends on a datesheet that cannot be entered | — |
| Invigilation duty | `hr.attendance.staff_shift_rostering` (duty roster, `duty_shifts`/`duty_assignments`, `migrations/00054_hr_growth.sql:730`) | partial | Generic date+shift roster with a teaching-clash check; no link to `exams`, `exam_subjects` or `exam_halls`. "Who invigilates Hall 2 for Class X Maths" cannot be recorded | P1 |
| Marks entry | `faculty.marks_report_cards.marks_entry`, `faculty.assessment_schemes.cce_formative_assessment_entry`, `.cce_summative_assessment_entry` | built (`internal/api/mod_academics.go:261`) | Range-validated, grade derived from bands. Good | — |
| Marks completion monitoring & sign-off | `institution_admin.academics.exams_marks_monitoring` | built and genuinely a workflow — `approveExamMarks` refuses a paper with marks missing (`admin_academics.go:532`) | **Approval does not lock.** `enterMarks` upserts without checking `approved_at`, and the update does not clear it, so an approved mark can be changed and still reads as signed off | **P0** |
| Moderation / scaling / grace marks | *(no key)* | **missing** | `marks.grace_marks` is read by every analytics query and written by no handler. There is no moderation step, no scaling, no before/after record of a changed mark (the audit middleware stores the request body, not the prior value — `internal/api/audit.go:222`) | P1 |
| Report card generation | `institution_admin.examinations.report_cards`, `faculty.marks_report_cards.report_cards` | built (`mod_academics.go:398`) | `term_id` is never set on this path; the upsert targets the annual partial index, so **Term 2 cards overwrite Term 1 cards**. Meanwhile `faculty_comms.go:637` writes remarks onto a *term-scoped* row that carries no marks. Two rows, neither complete | **P0** |
| Report card approval & release | as above | **missing as a distinct step** | `generateReportCards` takes `publish: true` in the same call. Whoever can generate can release to parents; the principal's "verify and issue" in the catalogue summary has no handler. No PDF (`report_cards.pdf_file_id` never written) | **P0** |
| Parent visibility of results | `parent.academics.results_report_cards`, `student.exams_results.exams_grades` | built, but leaky | `getFamilyResults` shows *every* mark for the child once *any* report card is published, ignoring `exams.is_published` (`internal/api/portal_family.go:233`). Publishing the Term 1 card exposes Term 2 unit-test marks as they are typed | **P0** |
| PTM booking | `parent.school_life.parent_teacher_meeting_booking`, `.calendar_ptm`, `.ptm_appointment_reminder_alert` (`ptm_slots`, `appointments`) | built | Well covered | — |
| PTM record of what was agreed | `faculty.communication.ptm_notes_action_items` | built and well modelled — attendance, who actually came, concerns, agreed actions, follow-up date and done flag, family visibility; surfaced at the next meeting (`internal/api/portal_school_life.go:388`) | Not linked to the booked `appointments` row, so a slot booked and not honoured is invisible | P3 |
| Promotion / detention decisions | `institution_admin.students.class_section_promotion`, `.enrollment_lifecycle` | partial | `promoteStudents` is a bulk roll-forward (`mod_academics.go:524`). `enrollments.status='detained'` is in the check constraint and **nothing writes it**. No promotion list, no review, no approval, no results-based eligibility | P1 |
| Intervention for at-risk students | `institution_admin.analysis.performance_analytics`, `student_support_plans`, `student_support_goals` (`migrations/00019_support_plans.sql`) | built | Support plans exist; not wired to end-of-term results | P2 |
| **MID-YEAR** |
| New admission mid-year | `admissions.admissions.enrollment_handoff`, `.seat_allocation_management`, `admissions.applications.applications` | built | The enrolment itself is fine | — |
| Mid-year joiner — fees pro-rated | *(no key)* | **missing** | Demand generation selects every active enrolment for the instalment at the full structure amount (`fees.go:617`); nothing reads `enrolled_on` or `admission_date`. Instalments raised before the child joined are simply never raised for them | **P0** |
| Mid-year joiner — attendance denominator | *(no key)* | **missing** | Report-card attendance is `count(*) FROM student_attendance WHERE student_id = …` with no date bound (`mod_academics.go:428`); shortage lists likewise. A September joiner's percentage is computed on the days they were present for | P1 |
| Mid-year joiner — honest report card | *(no key)* | missing | No partial-year marker; the card shows a rank against a full-year cohort | P2 |
| Section change mid-year | `institution_admin.students.class_section_promotion` (catalogue claims "section shuffling") | **missing, and unsafe** | No handler updates `enrollments.section_id`. `promoteStudents` closes the old enrolment as `promoted` then inserts — but `enrollments` is UNIQUE on `(student_id, academic_year_id)` (`migrations/00001_baseline.sql:1690`), so a same-year move hits `ON CONFLICT DO NOTHING` and leaves the child **with no active enrolment**, i.e. off every roster, gradebook and invoice run | **P0** |
| Transfer out — TC issuance | `institution_admin.students.certificates_documents` + `issueCertificate` (`mod_academics.go:589`) | built, and better than the catalogue suggests | Snapshot frozen, student and enrolment closed. But: no approval (`certificate_types` is auto-created with `requires_approval=false`), no dues gate — outstanding is copied into the snapshot and ignored — and no PDF | P1 |
| Transfer out — fee settlement & refund of unused terms | `finance.concessions_refunds.refunds` | **missing** | Refunds are read-only (above). Nothing computes an unused-term credit. This is the single most common reason a school keeps a parallel spreadsheet | **P0** |
| Transfer out — records handover / clearance | `hr.onboarding_exit.*`, `exit_clearances` | **staff only** | `exit_clearances` keys on `staff_exits`. There is no student clearance — library books out, transport, hostel, lab deposit — before a TC is handed over | P1 |
| Transfer in mid-year | `admissions.admissions.transfer_certificate_intake`, `.child_info_id_capture`, `.aadhaar_apaar_capture_at_admission` | built | Prior-school TC recorded and verified against the UDISE record | — |
| Re-admission (returning after a break, annual re-admission fee) | *(no key)* | **missing** | No key in the catalogue, no `readmit`/`rejoin` path for students anywhere in `internal/`. A returning child must be re-created as a new admission, losing the earlier record | P2 |
| Mid-year academic review | `institution_admin.analysis.department_reports`, `.performance_analytics`, `institution_admin.standard.exam_grade_analytics` | built | Analytics are real (`admin_rollups.go:1378` onward). No scheduled review artefact — nothing records that a review happened or what was decided | P3 |

## The findings that matter

### 1. There is no month-end close, so nothing is ever final

The only close in the product is annual: `accounting_years` with `status IN ('open','closed')`,
a surplus frozen at close time, and — properly — a database trigger that refuses a journal
posting into a closed year (`internal/api/ledgers.go:1392,1434`). That is well built. But an
Indian school does not reconcile once a year; it closes a month. Fee receipts, payslips,
expense vouchers and marks all remain mutable for up to twelve months after the fact, and
nothing anywhere records "September is done."

The consequences compound with the other findings. `runPayroll` explicitly
`DELETE FROM payslips WHERE payroll_run_id = $1` before recomputing (`mod_ops.go:534`); the
guard against that is `status IN ('locked','paid')`, and the only `UPDATE payroll_runs` in
the entire codebase sets `'processed'`. So `errPayrollLocked` is unreachable, and a payroll
already exported to the bank via `getBankFile` and paid can be re-run — deleting the payslips
the staff were shown and the ECR was built from — by anyone with `payroll.write`. The
comment above the function ("A locked run is never recomputed — a payslip already issued must
keep its numbers") states an intention the code does not implement.

Why this matters: an auditor's first question is "show me March", and the answer has to be
the same in June as it was in April. Two lock verbs — a month lock on collections/journals
and a working lock verb on `payroll_runs` — would close most of this.

### 2. The payroll chain breaks in three places, and each break is silent

The chain should be: attendance and leave → LOP → gross → PF/ESI/PT/TDS → net → payslip →
bank file → returns. Trace it:

- **Leave → LOP.** `staff_lop_register()` (`migrations/00031_hr_lifecycle.sql:801`) honours the
  policy: half days, late marks against `late_marks_per_lop_day`, unpaid leave, rounding,
  `max_lop_days_per_month`. The comment on `getLOPRegister` says both the screen and the
  payslip call it, "the only way to guarantee they agree". They do not: `runPayroll` counts
  `staff_attendance.status='absent'` in an inline subquery and pro-rates on that
  (`mod_ops.go:553`). Approved paid leave marked absent becomes LOP; unpaid leave that was
  never marked absent does not. The register and the payslip will disagree, and the payslip
  wins the argument with the teacher.
- **TDS.** `computeStatutory` returns PF, EPS, ESI and PT — there is no TDS component and no
  TDS line in `breakup`. `getTaxComputation` computes `monthly_tds_paise` on a screen that
  nothing consumes. Section 192 requires deduction at source every month; a school running
  this as built deducts nothing all year and discovers it in Q4. `hr.statutory.income_tax_form_16_generator`
  is catalogued `built` and listed in `implemented_gen.go:175`, but no Form 16 handler exists —
  the same shape of near-miss as the TC example in the brief.
- **Returns.** EPFO ECR is generated (`payroll_statutory.go:411`). ESI return, PT challan and
  Form 24Q are not found.

### 3. Refunds are catalogued but cannot happen — and that is exactly what a mid-year exit needs

`finance.concessions_refunds.refunds` is `built` in the CSV and `true` in
`internal/api/implemented_gen.go:113`. The `refunds` table has the right shape:
`pending → approved → processed`, `requested_by`, `approved_by`, `processed_on`. Five queries
read it. **No code writes it.** `grep "INTO refunds\|UPDATE refunds"` over `internal/` returns
nothing. The consequences ripple: `banking.go:869` and `:2925` offer refunds to a payout batch
only at `status='approved'`, so the refund payout path is permanently empty;
`getCollectionTieOut` sums `status='processed'` refunds, which will always be zero;
`role_backoffice.go:67` counts pending refunds on a dashboard that will always read nil.

Put this next to transfers out. A child leaving in November has paid three terms and used one
and a half. The school must settle: compute the unused portion, approve it, pay it, and issue
the TC. TC issuance exists and works well. The settlement half does not exist at all — no
pro-rata calculation, no refund creation, no dues gate on the TC (`issueCertificate` copies
outstanding dues into the snapshot and issues anyway), and no student clearance list, because
`exit_clearances` is keyed to `staff_exits`. This is precisely the "parallel spreadsheet" that
gets an ERP abandoned, and it is one of the most emotionally charged conversations a school
office has.

### 4. Report cards: two half-cards, no term, and publication as a checkbox

Two code paths write `report_cards` and they do not meet.

`generateReportCards` (`mod_academics.go:398`) computes totals, percentage, grade and section
rank in one windowed pass — good work — and upserts `ON CONFLICT (student_id, academic_year_id)
WHERE term_id IS NULL`. It never inserts `term_id`. So every card is the annual card, and
generating Term 2 overwrites Term 1: the school loses the mid-year card the moment it produces
the final one. `saveReportCardRemark` (`faculty_comms.go:637`) writes the class teacher's and
principal's remarks onto a row keyed `(student, year, term)` with `term_id` always set — a
different row, carrying no marks. The result is one row with numbers and no words and another
with words and no numbers.

Publication is a boolean argument to the generate call — `{"publish": true}` — held behind the
same `ReportCardsGenerate` permission a class teacher has (`internal/rbac/rbac.go:294`). There
is no generate → verify → release sequence, no PDF (`pdf_file_id` is never written), and no
record of who released. The catalogue summary for `institution_admin.examinations.report_cards`
promises "ready to verify and issue"; the verify step is not there.

Worse, the parent side does not respect even that boolean properly. `getFamilyResults`
(`portal_family.go:233`) lists every mark the child has, for every exam, gated only on
`EXISTS (SELECT 1 FROM report_cards rc WHERE rc.student_id = … AND rc.is_published)` — any
published card, ever. `exams.is_published` is ignored. Once the first card of the year is
released, every subsequent unit-test mark is visible to the parent the instant a teacher saves
the gradebook, before moderation, before the head of department has seen it. The comment above
that query claims the opposite. For a school this is the difference between a controlled
results day and a phone call from a parent about a mark the teacher was still checking.

### 5. Two near-misses worth naming, in the spirit of the TC example

- **Exam scheduling.** `institution_admin.examinations.exams_results` and `.exams_result_status`
  both promise "exam schedule". An exam header has `starts_on`/`ends_on`, and the per-paper
  columns `exam_subjects.exam_date`, `starts_at`, `duration_minutes` exist and are read by the
  hall-ticket sheet (`exam_hall.go:373`), the student calendar (`student_life.go:1048`), the
  exam monitor and the overdue-marks nudge (`attention.go:381`). Nothing writes them: the only
  `INSERT INTO exam_subjects` (`setup.go:699`) supplies max and pass marks only, and there is
  no `UPDATE exam_subjects` in the codebase. The datesheet — the single artefact a term
  revolves around — cannot be entered.
- **Section changes.** `institution_admin.students.class_section_promotion` says "and section
  shuffling". No handler sets `enrollments.section_id`. Using `promoteStudents` for a same-year
  move closes the current enrolment as `promoted` and then hits the
  `UNIQUE (student_id, academic_year_id)` constraint with `ON CONFLICT DO NOTHING`, leaving the
  child with no active enrolment — which removes them from the gradebook roster, the invoice
  run, the report-card generator and the attendance register, all of which filter on
  `status = 'active'`. A routine October request would quietly delete a child from the school.

## Where the slice is genuinely clean

Stated plainly, because it is a real result:

- **Exam seating.** `exam_halls`/`exam_seats` model a grid rather than a capacity, enforce one
  candidate per desk and one desk per candidate at the index level, and derive a door
  verification code rather than storing it. There is an invigilator's hall sheet
  (`exam_hall.go:418`). This is a workflow, not a table.
- **PTM notes.** `ptm_notes` records who actually attended (including "the uncle who collects
  him"), the concerns, the agreed actions, a follow-up date and whether it was done, with a
  check constraint refusing an empty meeting, a unique index preventing duplicate versions of
  the same sitting, and retrieval at the next meeting. This is the thing the brief asked
  whether anyone had built. Someone did.
- **Ledgers and the audit trail of money.** Double-entry with source-keyed idempotence so a
  receipt cannot post twice, a trial balance, a collection tie-out that states its exclusions,
  BRS finalisation that freezes a period, and an FY close enforced by a trigger.
- **Marks completion monitoring.** `getExamMonitor` counts eligibility from active enrolments
  rather than from entered marks, and `approveExamMarks` refuses to sign off an incomplete
  paper. The sign-off gate is right; only the lock behind it is missing.
