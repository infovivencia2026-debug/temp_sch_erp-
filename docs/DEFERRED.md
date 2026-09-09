# Deferred work

Everything the catalogue lists that this codebase does not build, and why.
Written down so the reason survives the person who decided it.

As of 19 Aug 2026: **447 catalogued, 414 built, 33 deferred.**

Five entries left the catalogue entirely rather than being deferred — the
product owner's decision, recorded under "Withdrawn" below. Three others moved
into the product; they are the section immediately after this one, which this
file had named as the first things to pick up.

The product owner's instruction was to leave the rest alone for now. Nothing
here is abandoned; each entry says what would unblock it.


## Buildable today — all three now built

These needed no hardware and no vendor account, and all three have since been
picked up. Kept here with what was actually done, because the next person to
read this file will otherwise go looking for them in the catalogue.

### ~~`faculty.attendance.absence_alert_to_guardian`~~ — built in ac7399f
**faculty.attendance.absence_alert_to_guardian** — Faculty

Built as a policy over the rules that already existed: the absence occurrence keys on the child and the date, which collapses eight period rows into one message home, and a queued message is withdrawn when the absence is explained. Screen is `web/src/features/communication/AbsenceAlerts.tsx`.

### ~~`finance.student_dues.automated_fee_reminders`~~ — built in ac7399f
**finance.student_dues.automated_fee_reminders** — Accounts & Finance

Built as a `message_trigger_rules` row evaluated by the existing `applyRule`. The chase number is derived from how overdue the invoice is rather than counted, so the sweep is idempotent and a week the worker was down resumes at the right chase. Screens are `FeeReminders.tsx` and `ReminderPlans.tsx`.

### ~~`super_admin.platform_configuration.integrations`~~ — built in 0b57c65
**super_admin.platform_configuration.integrations** — Super Admin

An index of every connector and its status, aggregating `integrations` and the provider tables. It reports rather than decides: nothing on the screen changes a connector's behaviour.


## Blocked on hardware or a vendor account

Each of these is a view over a data stream no device here produces, or a call
to a service with no account. The software half is often trivial; building it
would ship a screen that says "no data" forever, so it is not built.

Where a seam already exists it is noted -- `tally.go`, `connectors.go` and
`statutory.go` all show the pattern: a live implementation that refuses by name,
with a test pinning the refusal so it cannot quietly become a fake success.

| Feature | Role | Needs |
|---|---|---|
| admissions.gate_security.gate_rfid_entry_management | Admissions | RFID reader at the gate + tags |
| finance.collections.cashless_campus_wallet | Accounts & Finance | a payment gateway merchant account |
| hr.attendance.biometric_machine_attendance_sync | HR & Payroll | fingerprint/face reader on site |
| hr.attendance.biometric_punch_in_out_grace_period | HR & Payroll | fingerprint/face reader on site |
| institution_admin.transport.ais_140_telematics_vahan_compliance | Institution Admin | AIS-140 certified device + VAHAN registration |
| institution_admin.transport.bus_speeding_rash_driving_alerts | Institution Admin | GPS tracker fitted to each vehicle |
| institution_admin.transport.fuel_sensor_mileage_telematics | Institution Admin | fuel-level sensor per vehicle |
| institution_admin.transport.geo_fenced_bus_stop_alerts | Institution Admin | GPS tracker fitted to each vehicle |
| institution_admin.transport.live_vehicle_tracking | Institution Admin | GPS tracker fitted to each vehicle |
| institution_admin.transport.real_time_vehicle_tracking_vts | Institution Admin | GPS tracker fitted to each vehicle |
| institution_admin.transport.seatbelt_cctv_video_streaming | Institution Admin | cameras fitted to each vehicle |
| parent.alerts_preferences.parent_app_live_bus_tracking_refresh_rate_customizer | Parent | GPS tracker fitted to each vehicle |
| parent.alerts_preferences.parent_bus_proximity_radius_customizer | Parent | GPS tracker fitted to each vehicle |
| parent.alerts_preferences.real_time_school_bus_live_video_feed_access | Parent | cameras fitted to each vehicle |
| parent.my_childs_bus.live_bus_tracking_map | Parent | GPS tracker fitted to each vehicle |
| parent.my_childs_bus.school_transport_driver_call_button | Parent | GPS tracker fitted to each vehicle |
| parent.my_childs_bus.transport_snapshot | Parent | GPS tracker fitted to each vehicle |
| parent.profile.parent_app_biometric_lock_face_id_fingerprint | Parent | fingerprint/face reader on site |
| student.profile.digital_student_id_card_nfc_tap_pass | Student | NFC-capable cards and a reader |
| super_admin.payments_devices.biometric_device_integration | Super Admin | fingerprint/face reader on site |
| super_admin.payments_devices.gps_hardware_integration | Super Admin | GPS tracker fitted to each vehicle |
| super_admin.payments_devices.payment_gateway_connectors | Super Admin | a payment gateway merchant account |
| super_admin.statutory_boards.digilocker_issuer_integration | Super Admin | DigiLocker issuer onboarding (government) |

### The transport cluster is the bulk of it

Routes, stops, driver profiles, student allocation, route attendance, delays,
incidents, breakdown dispatch, sobriety checklists and fee slabs are all **built**.
What is deferred is every feature whose content is a live position stream. Fit
trackers and most of these become configuration rather than a project.

AIS-140 is different in kind: it is a statutory certification of a specific
device. Software claiming compliance without the hardware would be a false
claim, not merely an empty screen.


## Withdrawn from the catalogue

Not deferred — removed. These were catalogued, never built, and the product
owner decided against them on 19 Aug 2026. Recorded here because a feature that
simply disappears from the CSV looks like an accident to the next person to
count, and because "we decided not to" is a different answer from "not yet".

| Feature | Role | Was |
|---|---|---|
| `faculty.question_papers_online_tests.ai_examcell_paper_generator` | Faculty | AI Examcell Paper Generator |
| `faculty.question_papers_online_tests.ved_ai_assessment_assistant` | Faculty | Ved AI Assessment Assistant |
| `parent.academics.ai_child_performance_summary_audio` | Parent | AI Child Performance Summary Audio |
| `parent.messages.ai_voice_search_for_school_notices` | Parent | AI Voice Search for School Notices |
| `parent.documents.digilocker_document_pull` | Parent | DigiLocker Document Pull |

`super_admin.statutory_boards.digilocker_issuer_integration` was **not**
withdrawn: it is the school pushing certificates *into* DigiLocker, which is a
different act from a parent pulling them out, and it remains blocked on issuer
onboarding.

`parent.profile.parent_app_biometric_lock_face_id_fingerprint` is **archived,
not withdrawn** — it stays catalogued at tier `optional`, which in this
codebase means routable but never in anyone's navigation. It is listed in the
hardware table below and is reachable only by direct link.


## Speculative — AI and gamification

The ten that remain after the four withdrawals above. Untouched by explicit
instruction across every run, and listed so nobody mistakes the omission for an
oversight.

- `admissions.enquiries.24_7_admission_chatbot` — admissions.enquiries.24_7_admission_chatbot
- `admissions.enquiries.ai_voice_agent_integration` — admissions.enquiries.ai_voice_agent_integration
- `student.campus_life.digital_hall_of_fame` — student.campus_life.digital_hall_of_fame
- `student.learning.ai_personal_learning_companion` — student.learning.ai_personal_learning_companion
- `student.learning.gamified_learning_badge_showcase` — student.learning.gamified_learning_badge_showcase
- `student.learning.gamified_learning_streak_counter` — student.learning.gamified_learning_streak_counter
- `super_admin.ai_automation.ai_sentiment_analysis_on_feedback` — super_admin.ai_automation.ai_sentiment_analysis_on_feedback
- `super_admin.ai_automation.automated_exam_question_translation` — super_admin.ai_automation.automated_exam_question_translation
- `super_admin.ai_automation.predictive_dropout_risk_engine` — super_admin.ai_automation.predictive_dropout_risk_engine
- `super_admin.ai_automation.smart_fee_cash_flow_predictor` — super_admin.ai_automation.smart_fee_cash_flow_predictor

---

# Known defects and open decisions

Found during the build runs, not acted on, and each one real. These are not
features — they are things that are wrong or undecided in code that ships today.

## Security — needs a product decision, not a fix

Each of these changes who can see what, so none was changed unilaterally.

### ~~A head of department can read every staff member's police verification~~ — fixed

`internal/api/hr_lifecycle.go` called `resolveScope` zero times across 35
handlers. `hod` holds `EmployeesRead`, so one GET to `/hr/background-checks`
returned the whole school's — plus medical fitness, exits and settlements,
grievances, service book and the LOP register. No id guessing, a real seeded
role, one request.

**Decided as this file recommended**, and along the boundary `hr_growth.go`
already defines: `growthReach` narrows the back office (anyone holding
`hr.employees.write`) to the institution, a head of department to their
department and their own row, and everybody else to their own row.

Eleven personal registers narrowed — onboarding and its KYC, exits, exit
clearances, service certificates, transfers, the service book, qualifications,
medical fitness, background checks, grievances and the LOP register — plus
`listEmployeeDocuments` in `role_backoffice.go`, which sits in the same `/hr`
group and was the same defect one route along.

Five stayed institution-wide on the reasoning already written here: seniority
(an ordering per department is not a seniority list), the celebration diary,
the recognitions board, the clearance-department master and the leave policy.
`listEmployees` and the HR dashboard are also unnarrowed — a staff directory of
name, department and extension is what a directory is for, and the dashboard
returns counts rather than anybody's record.

Grievances got a **narrower** rule than the rest, which was the one judgement
call this file did not pre-decide. There is no departmental widening: outside
the back office a caller sees the grievances they raised about themselves and
the ones they were assigned to handle. Handing a head of department every
complaint raised inside their department includes the complaints raised about
them, and the staff work that out in one round.

Writes needed no narrowing — every one carries
`RequirePermission(EmployeesWrite)`, which is what `growthReach` calls the back
office — and a router walk now pins that, because the reads depend on it.

Two loose ends this did **not** close, both worth a decision:

- A teacher cannot raise their own grievance. `POST /hr/grievances` requires
  `hr.employees.write`, so the complaint has to be entered by the office it may
  be about. That is a product gap rather than a leak, and closing it means a
  self-service route on `self.profile.read`.
- The narrowing covers the metadata rows only. Whether `GET /files/{id}` lets a
  narrowed caller fetch a document whose row they can no longer list was not
  checked.

### `operations` reaches every child's clinical record

The seeded bundle carries `HealthRead` + `StudentsReadAll`, and
`listInfirmaryVisits` applies no narrowing beyond RLS: omit `student_id` for
the whole school's day, or pass any id for that child's full history, each row
carrying allergies, chronic conditions and blood group.

It is an optional role, not seeded by default — but it is documented as a
bundle to trim per person and ships with clinical read included, so a librarian
granted "Operations Staff" gets it. The reviewer's preferred fix, and mine:
**split the permission** — an emergency summary (allergies, blood group,
chronic conditions) that a warden or trip supervisor genuinely needs at 2am,
separate from the clinical record.

### Grievances and IEP notes are still readable through the audit trail

Clinical records and counselling messages were withheld from `audit_log`
bodies (see `confidentialBody` in `internal/api/audit.go`). Grievances were
deliberately left in: a member of staff holding `AuditRead` can read the
complaint filed against them via `?entity=comms.grievances`, defeating the
subject-exclusion the grievance hub enforces everywhere else.

It was left because "an auditor cannot see what a grievance update said" is a
real loss. The same question applies to IEP/support-plan writes and discipline
notes.

### `StudentPredicate` has no enrolment-status filter

`reachesTaughtStudent` filters `e.status = 'active'`; `StudentPredicate`
(`scope.go`) does not. A child promoted out of 8-B keeps the 8-B row as
`promoted`, one who left keeps `withdrawn` — so **last year's teacher of 8-B
still reaches every child who ever passed through it, including children who
have left the school**, across 13 call sites including the student record and
the fee ledger.

Do not simply add the filter: finance legitimately reaches a departed pupil who
still owes money. The recommendation is an explicit `ActiveStudentPredicate`
beside the existing one — the way `AttendancePredicate` already sits there —
with pastoral and record callers moved onto it and finance left alone.

## Bugs that ship today

- ~~**`docs/AGENT_CONTRACT.md` §0 is dangerous.**~~ Fixed: §0 now names the
  explicit-SHA rule and tells a worker never to reset to a branch name on
  reflex.
- **`relaxed` density does nothing.** The API and database accept
  `relaxed`; `web/src/index.css` implements `spacious`. Silently inert.
- **"1 subjects" and "1 seats"** — `portal.results.subject_count` and
  `portal.event_passes.seats_count` have no singular form. Both reachable.
  Left because fixing them changes English rendering under a UI freeze.
- **Timestamp format bug**: `'YYYY-MM-DD"T"HH24:MI:SSOF:00'` across
  `timetable_ops.go` and `admin_ops.go` renders IST as `+05:30:00` — `OF`
  already emits minutes, so the literal `:00` is wrong for any half-hour
  offset. Worth a sweep.
- **Six `/hr-growth` endpoints once had no client**; that was fixed, but the
  training panel still cannot show hours against the requirement because
  `GET /me/training` returns records without the target and the requirements
  route needs a permission a teacher does not hold. Needs a server change.
- **No school-wide media/photo consent register exists.** Publication of a
  child's photograph is gated per achievement instead. A real consent register
  is still missing from the product.

## Things that work but are not wired

- **PTM reminders need a `message_trigger_rules` row on `ptm.upcoming`.** The
  emit is correct and dispatch now runs; a school with no rule gets nothing,
  and no rule is seeded. The administrator's trigger-rules screen should show
  the event as unconfigured — it does not.
- **WhatsApp needs a System-User token and approved templates.** Configuration,
  allowlist, template mapping and error handling are all built and tested;
  nothing reaches Meta without both. Outside the 24-hour window only approved
  templates may be sent, so an approved template per event is a prerequisite,
  not a nicety.
- **The SMS gateway needs a paired handset.** Server and app are built. The
  catalogue key it is bound to
  (`super_admin.messaging.sms_gateway_integration`) is scoped *platform* and
  describes vendor credentials, while pairing is the institution admin's act —
  a new key such as `institution_admin.communication.sms_gateway_phone` is
  probably warranted. Deliberately not minted; catalogue keys move the
  completeness count.

---

## Agreed after the MyClassboard comparison (1 Sep 2026)

Both are approved in principle and deliberately NOT started. Wait to be asked.

### 1. Concessions and scholarships — catalogue what already exists

The cheapest real win of the comparison. MCB ships manage/assign/report for
concessions and scholarships, plus staff-kid and sibling concessions. Our
catalogue has **zero** features matching `concession|scholar` — but the API
already serves `/concessions/scholarships/imports` and
`/concessions/scholarships/imports/`, and `concessions.go` exists.

So this is mostly a WIRING gap, not a build: backend without a catalogued
feature, which means it is unreachable from navigation and invisible to search.

When picked up:
- Read `internal/api/concessions.go` first and establish what is genuinely
  served before minting any key — the endpoint list is not proof of a complete
  feature.
- Minting catalogue keys moves the completeness count, so mint only what is
  actually reachable, and check `implemented_gen.go` afterwards.
- Likely home: `finance.*` and/or `institution_admin.fees.*`.
- Fee concessions touch money. Every figure must name its population the way
  the collected/outstanding/billed trio now does — a concession applied to
  "this year's bills" is not the same measure as one applied to arrears.

### 2. Board-specific grade books — ship every board, reveal one

MCB carries separate grade-book structures for CBSE/State, IB, Cambridge,
ICSE and Pre-School, plus Blooms Taxonomy and subject outcomes. We have ONE
generic exam model and no board-specific structure at all, so an IB or
Cambridge school cannot use the product as it stands.

**The explicit instruction: build all the boards, but do not show them all.
The school picks its board during setup and sees only that one.**

That shape matters — it is the difference between a product that supports five
boards and a menu with five boards in it. The other four should be invisible,
not merely unused.

When picked up:
- The board is already on `institutions` (`education_board`, referenced by the
  setup checklist's `profile` step), so the selector likely exists; check
  before adding a second source of truth for the same fact.
- Setup step 1 "Confirm the school's details" is where the choice belongs —
  it is already blocking, and everything academic depends on it.
- Grading scales are already a setup step (`grading`, non-blocking): "Marks
  cannot become grades without it." Board structures must build on that rather
  than beside it.
- Scope: large. Worth it only when chasing IB/Cambridge schools — say so at the
  time rather than assuming the reason still holds.

### Deliberately NOT copied from MCB

Recorded so a future pass does not treat the gap as a to-do:

- **The report sprawl.** MCB has 15+ fee-due reports (Classwise, Branchwise,
  Aging, Batchwise, Month wise, All year, Previous AY…) — the same question
  answered fifteen times because nobody could filter. One filtered view.
- **A "Reports" sub-menu under every module.**
- **Per-branch duplicates** of reports that a filter would cover.
