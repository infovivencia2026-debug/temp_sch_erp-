# Gap analysis 02 — Onboarding and daily operations

Scope: the pre-opening chain (admission → student → section → roll → ID card → bus → fee → parent login), the daily register and its consequences, and the weekly rhythm of tests, homework, lesson plans and discipline. Evidence is `docs/ROLES_AND_FEATURES.csv` (452 features), `internal/catalog/catalog_gen.go`, `internal/api/implemented_gen.go` (414 of 452 have a screen *and* an endpoint), and the migrations and handlers named below.

## Verdict

The **daily operating loop is genuinely strong** and in two places better than most commercial Indian ERPs: the morning substitution board (`getSubstitutionBoard`, `internal/api/admin_academics.go:795`) computes who is actually free per period from both the staff register and approved leave; the absence-alert policy engine (`internal/api/message_rules.go`) collapses eight period-absences into one message per child per day, withdraws the alert if the family already reported it, and is idempotent under a 15-minute cron; the receipt series is row-locked, gapless and financial-year-resetting (`internal/fees/fees.go:77`). The `TC issuance` near-miss the brief warned about is **not** present — `POST /students/certificates` (`internal/api/mod_academics.go:596`) issues a real TC, allocates a serial, snapshots attendance and dues, and closes the enrolment.

The **pre-opening chain is where it breaks**, and it breaks in three places that are each individually fatal to a first-year rollout:

1. **No guardian can ever obtain a parent login.** `guardians.user_id` is read by five queries and written by exactly one file — `cmd/migrate/demo.go`, the demo seeder. No production endpoint links a guardian record to a user account. The whole parent app, and the circular/SMS path in `mod_ops.go`, are dark in a real tenant.
2. **Roll numbers are typed, never allocated.** No rule, no sequence, no mid-year handling.
3. **Transport fares are computed and never billed.** `allocateTransport` returns `fare_paise` to the screen; invoicing reads only `fee_structure_items`.

Everything else in the slice is either covered or a P2/P3.

## Activity table

| Activity | Covering features (keys) | Status | Gap | Sev |
|---|---|---|---|---|
| Student onboarding (applicant → student) | `admissions.admissions.enrollment_handoff`, `admissions.admissions.offers_admission_decisions`, `admissions.admissions.seat_allocation_management` | built | Chain creates student + admission_no + enrolment + one guardian, then stops. No roll no., no fee assignment, no transport, no user account, no document carry-over | P0 |
| Document verification | `admissions.applications.applicant_documents`, `admissions.admissions.transfer_certificate_intake`, `admissions.admissions.aadhaar_apaar_capture_at_admission` | built | `application_documents.verified_by` is a real workflow, but nothing copies verified documents into `student_documents` at handoff — no `INSERT INTO student_documents` exists anywhere in `internal/` | P1 |
| Section allocation | `institution_admin.academics.classes_sections`, `institution_admin.students.class_section_promotion` | built | Section is a dropdown on the handoff request. No balancing rule (gender/medium/strength) | P2 |
| Roll numbers | `enrollments.roll_no` column + unique index (`00001_baseline.sql:487, 2040`) | **partial** | Storage only. Typed in `students_write.go:204` or CSV-imported at `:464`. Handoff and promotion never set it. No renumber, no alphabetical rule, no mid-year insert | P1 |
| Student ID cards | `parent.profile.digital_student_id_card_view` (built, tier *optional*), `student.profile.digital_student_id_card_nfc_tap_pass` (deferred) | **partial** | No bulk/plastic printing for students. `hr.records.staff_id_card_printing` exists for staff; the student equivalent is **not found** | P1 |
| Transport allocation | `institution_admin.transport.student_allocation`, `.student_route_assignment`, `.routes_stops`, `.route_pickup_stop_mapping`, `.route_distance_fee_slabs` | built | Allocation is history-preserving and validates stop-on-route. But the fare is never billed (see below). Catalog claims "auto-apply them to the student's fee structure" | P0 |
| Parent's view of the bus | `parent.my_childs_bus.transport_snapshot` | **deferred** | A parent paying transport fees cannot see the route, stop or pickup time at all — the static view is deferred along with the GPS ones | P1 |
| Uniform and book issue | `finance.collections.school_store_merchandise_sales`, `institution_admin.library.ncert_textbook_indent`, `institution_admin.library.book_issue_return_terminal` | built | Adequate | — |
| Teacher allocation to classes/subjects | `institution_admin.academics.teacher_allocation`, `.faculty_allocation`, `institution_admin.directory_workload.faculty_allocation_workload`, `faculty.my_classes.language_subject_allocation` | built | Load caps and unmet-requirement reporting exist (`timetable_ops.go`) | — |
| Timetable publication | `institution_admin.academics.master_timetable_generation`, `.timetable`, `institution_admin.department.department_timetable`, `student.timetable.timetable`, `faculty.timetable.my_timetable` | built | Draft → published state machine with `published_by`/`published_at` CHECK-enforced (`00050_timetable.sql:198-204`). Clean | — |
| Payroll setup | `hr.payroll.salary_structure_builder`, `.payroll`, `.employee_ctc_breakup_calculator`, `hr.statutory.*` (PF/ESI/PT/Form 16/12BB/gratuity) | built | Unusually complete for the slice | — |
| Parent onboarding & app access | `super_admin.access_security.user_directory` (create/reset accounts) | **missing as a chain** | No endpoint sets `guardians.user_id`. `createUser` (`internal/api/users.go:119`) has no guardian concept; `web/src/features/super_admin/Users.tsx` mentions no student or guardian | P0 |
| Student attendance | `faculty.attendance.take_attendance`, `.attendance_correction`, `.absence_alert_to_guardian`, `.offline_attendance_diary_capture`, `institution_admin.academics.attendance_monitoring`, `.attendance_corrections`, `parent.attendance.attendance`, `parent.attendance.child_absence_reporting_button` | built | Daily *and* period-wise (two partial unique indexes, `attendance.go:140`). Correction is request → `decideCorrection` with audit. Strong | — |
| Teacher attendance | `hr.attendance.staff_attendance`, `.staff_shift_rostering`, `hr.leave.*` | built | Biometric sync deferred (`hr.attendance.biometric_machine_attendance_sync`) — a school with a punch machine keys twice | P2 |
| Timetable in operation / substitutions | `institution_admin.academics.faculty_substitution_engine`, `faculty.timetable.substitution_request_submission`, cover-request tree in `internal/api/timetable_ops.go` | built | Candidate suggestion, 409 on a busy proxy, `substitution.assigned` message event, and payroll `hr.payroll.substitute_workload_allowance`. Only gap: the *approver* is not notifiable (no audience term), documented at `timetable_ops.go:2398` | P3 |
| Homework and the diary | `faculty.teaching.homework_classwork`, `.teacher_digital_diary`, `student.homework.homework_assignments`, `student.home.digital_diary_schedule`, `parent.academics.homework_academics`, `parent.home.needs_attention` | built | Due dates real (`teaching.go:269-281`); parent "needs attention" surfaces homework due in the next 7 days (`portal_school_life.go:1819-1825`) — a due-date view, not just a list | — |
| Announcements / circulars | `institution_admin.communication.circulars_announcements`, `faculty.communication.announcements`, `parent.messages.communication` | **partial** | Recipient resolution requires `g.user_id IS NOT NULL` (`mod_ops.go:83, 103`). With no way to set it, a circular's reach and its SMS fan-out are both zero | P0 |
| Transport running | `institution_admin.transport.route_attendance`, `.transport_attendance_scans`, `.delays_exceptions`, `.driver_sobriety_safety_checklist`, `.bus_breakdown_emergency_dispatch` | built | Bus register is built from the allocation so an unscanned child shows as `not_scanned` with a `still_aboard` flag. Good design. GPS/VTS family all deferred (hardware) | P2 |
| Fee collection at the counter | `finance.collections.collect_payment`, `.receipts`, `.gst_compliant_receipt_numbering`, `.partial_advance_payments`, `parent.fees.digital_fee_receipt_pdf_download` | built | Gapless FY-resetting series under row lock; `getReceipt` returns everything needed to print. Clean | — |
| Parent communication | `parent.messages.direct_teacher_messaging`, `.concerns_grievance_ticketing`, `parent.home.real_time_push_notifications`, message rules engine | built | Sound — *if* guardians exist as users; the newer messaging path (`messaging.go:1658`) correctly falls back to guardian phone/email, so alerts survive the login gap where circulars do not | — |
| Weekly tests | `faculty.question_papers_online_tests.objective_online_test_creation`, `.question_bank_management`, `.no_omr_exam_grading` | built | AI paper generator deferred (P3) | — |
| Assignments | `faculty.teaching.assignments_submissions` | built | — | — |
| Lesson plan vs syllabus coverage | `institution_admin.academics.syllabus_coverage_tracking`, `.syllabus_progress`, `.lesson_plan_approval_queue`, `faculty.teaching.syllabus_progress_tracker`, `.lesson_plans_content` | **partial** | Coverage is schedule-aware but the "behind" flag only fires when `percent < 75 && elapsed > 75` (`syllabus.go:427`). The year is 334 days from June; November is ~50% elapsed, so nothing is ever flagged before late February | P1 |
| Discipline incidents | `institution_admin.students.disciplinary_incident_log`, `faculty.my_classes.discipline_notes` | **partial** | Record + confidential counselling note + prior-incident count across all years. But `parent_notified` is a manual boolean, no message event is emitted, and there is no parent-facing key at all | P1 |
| Staff activities | `hr.hiring_growth.staff_training_workshop_logs`, `.annual_performance_appraisal_kpi`, `hr.welfare.*` | built | — | — |

## The four findings that matter

### 1. A guardian cannot be given a login — P0

`guardians.user_id` has an index, a partial index and a foreign key (`00001_baseline.sql:2064, 2066, 2557`). Five production queries join on it. The only writer in the repository is the demo seeder:

```
cmd/migrate/demo.go:257  UPDATE guardians SET user_id = NULL WHERE user_id = $1
cmd/migrate/demo.go:261  UPDATE guardians SET user_id = $2
```

`createUser` (`internal/api/users.go:119-215`) makes an account with roles and a temporary password, and never touches `guardians`. Nothing in `web/src/features/super_admin/Users.tsx` references a student or a guardian. There is no invitation, no OTP claim, no bulk provisioning pass over an admitted cohort.

Consequences, in order of how quickly a school notices: the parent app shows nothing; `publishCircular` counts `count(DISTINCT g.user_id)` and reports a blast radius of zero; the SMS fan-out for the same circular iterates over the same empty set. The newer messaging foundation is the exception — `resolveRecipients` at `messaging.go:1662` selects `g.email, g.phone` and tolerates a NULL `user_id`, which is why absence alerts and fee reminders would still send. So the product will send an SMS about an absence to a parent who cannot log in to see anything else.

The two-guardian and shared-phone cases compound it. `users_institution_phone` is a **unique** index (`00001_baseline.sql:2226`), so a father and a mother sharing one handset cannot both hold accounts unless someone falls back to the username identifier added in `00010`/`00012`. The messaging code already knows about this family and documents the failure honestly at `message_rules.go:819-830`: two guardians of one child with no portal login collapse into a single send keyed on the child. Multi-child families are handled — `parent.home.child_switcher` is built and `student_guardians` is many-to-many — but only once the login exists.

### 2. Roll numbers are a text box — P1

`enrollments.roll_no` is `integer` with a correct unique index per section. Nothing allocates it. `enrollTheApplicant` (`mod_admissions.go:570`) inserts the enrolment row without `roll_no`; `class_section_promotion` does not carry or regenerate one; the only writes are `students_write.go:204` (a form field) and `:464` (a CSV column). A school opening in June with 900 children will therefore assign roll numbers in Excel, sorted alphabetically, and paste them in — and when a child joins in September, the clerk either appends 41 to a class of 40 or renumbers the section by hand and every printed register goes stale. This is the archetypal "parallel spreadsheet" that gets an ERP abandoned, and it is a small amount of work: one rule (alphabetical by surname, or by admission number) applied at handoff and at promotion, plus a renumber action.

### 3. Transport fare is priced but never charged — P0 for finance, P1 for the office

`allocateTransport` (`transport_office.go:243-270`) validates that the stop is on the route, closes the previous allocation with `valid_to = current_date - 1` rather than deleting it — good, deliberate history — and returns the stop's `fare_paise`. That value is displayed and then discarded. `fare_paise` appears in exactly four non-test places in `internal/`, all of them reads (`transport_office.go:173, 181, 259, 270`; `mod_ops.go:1406`).

Invoicing goes the other way entirely. `raiseInvoices` (`fees.go:600-680`) selects every active enrolment in the year, optionally filtered by class, and copies lines from `fee_structure_items`. There is no per-student component, so a bus child and a walking child in the same class receive the identical invoice. The catalog explicitly promises otherwise: `institution_admin.transport.route_distance_fee_slabs` is summarised as "auto-apply them to the student's fee structure" (`catalog_gen.go:465`). A school will discover this in month two, when transport revenue does not appear, and will bill the bus separately — which is exactly the parallel ledger the fee engine exists to prevent. The same shape of gap applies to any per-student charge: no mechanism exists to attach one.

### 4. "Are we behind?" cannot be answered in November — P1

`getSyllabusCoverage` (`syllabus.go:391-430`) is well built: it counts active `syllabus_units` per `class_subject`, counts those with a delivered lesson plan, names the teacher, dates the last delivered plan, and counts plans waiting for approval. It is also schedule-aware in principle — `yearElapsedPercent` computes the position in a 334-day June-to-April year. But the verdict is a single hard-coded pair of thresholds:

```go
v.Behind = v.Percent < 75 && elapsed > 75
```

`elapsed > 75` of 334 days from June is roughly 20 February. Class 8 Science at 30% coverage in November returns `Behind: false`. The screen shows the percentage, so a head of department who reads the number carefully can infer the problem; the flag that would put it in front of them cannot fire until it is too late to fix. `syllabus_units` carries `term_id` but no planned completion date, so the fix wants either a per-unit target date or a straightforward `percent < elapsed - tolerance` comparison. Lesson plans themselves are properly modelled — section-scoped rather than class-scoped precisely so that 8-A and 8-B can diverge (`00017_syllabus_lesson_plans.sql:36-44`), with a real `draft/submitted/returned/approved` workflow feeding `lesson_plan_approval_queue`.

## Two smaller notes

**Discipline follows the child but never reaches the parent.** `discipline_records` (`00001_baseline.sql:383`) is keyed on `student_id` with no academic-year column, so an incident does follow the child across years, and the admin log surfaces a prior-incident count (`admin_academics.go:1594`). Confidentiality is handled — `visible_to_student`, a separate counselling note the teacher's own screen cannot read (`admin_academics.go:1681-1684`), and `welfare.discipline.write` distinct from `students.write`. But `parent_notified` is a boolean somebody ticks. No `EmitMessageEvent` call exists for discipline (the only three are `ptm.upcoming`, `substitution.assigned`, and the generic emit endpoint), and there is no `parent.*` discipline key in the catalogue. A suspension is recorded and the family is told by telephone.

**Document verification stops at the application.** `application_documents` has `verified_by` and a file reference, and `student_documents` exists as a table — but no code path moves the verified birth certificate, Aadhaar copy or previous-school TC from the first to the second. `grep -rn "INSERT INTO student_documents" internal/` returns nothing. At handoff the child's verified paperwork stays attached to a closed application rather than to the student, which is where an inspection or a TC request will look for it.
