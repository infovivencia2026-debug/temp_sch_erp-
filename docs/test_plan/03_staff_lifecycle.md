# Acceptance tests 03 — the staff lifecycle

**Scope.** The chain by which a school hires, allocates, pays, rosters, appraises and
releases a member of staff, and the handoffs between HR, Faculty, the Institution
Admin (principal / vice principal / HOD) and Finance. Every test below is grounded in
a route that exists in `internal/api/` and a screen in `web/src/features/`, cited by
file and line. Where `docs/gap_analysis/00_TIMELINE.md` or `03_monthly_term.md` says a
chain is cut, the test asserts the cut behaviour rather than a happy path that cannot
happen — those are marked **Known gap**. Confidentiality is treated as a first-class
subject, not an afterthought: staff records here carry pay, KYC, police verification,
medical fitness, grievances and appraisal scores, and section F tests the boundary as
hard as sections A–E test the work. Two corrections to the brief are recorded in the
tests that carry them: `hr_lifecycle.go` **now does** narrow (ST-31 is the regression
test, not a failing test), and a previously unreported P0 — nothing anywhere writes
`salary_structures` — blocks the whole payroll section (ST-14). Two further findings
not in the gap analysis are recorded where they bite: the leave register is not
narrowed at all (ST-36) and the HR dashboard's pending-leave tile is structurally
zero (ST-21).

Roles are the seeded ones in `internal/rbac/rbac.go:283-360`. The permissions that
matter throughout:

| Role key | Holds | Does **not** hold |
|---|---|---|
| `hr` | `hr.employees.read`+`write`, `hr.leave.approve`, `hr.payroll.read`+`write`, `hr.attendance.write` | — |
| `institution_admin` | everything except the two platform grants | — |
| `hod` | `hr.employees.read`, `hr.leave.approve`, `academics.write`, `timetable.write` | `hr.employees.write`, `hr.payroll.read` |
| `vice_principal` | `hr.employees.read` (rbac.go:300) | `hr.employees.write`, `hr.payroll.read` |
| `exam_controller` | `reports.read`, exam grants (rbac.go:338-341) | **no** `hr.*` grant at all |
| `faculty` | `self.profile.read`, `self.profile.write` | every `hr.*` grant |

One inaccuracy in the source comments, worth knowing before a tester builds fixtures:
`hr_growth.go:149-151` and `hr_lifecycle.go:103-105` both say the seeded examinations
controller holds `hr.employees.read`. It does not — `rbac.go:338-341` grants that role
no HR permission. Build the "employees.read without employees.write" fixtures from
`hod` and `vice_principal`, which genuinely hold it.

---

## A. Hiring

### ST-01 — A vacancy is raised and approved, and the same permission does both

    Roles       HR (raise) → Institution Admin (approve)
    Features    hr.hiring_growth.recruitment
    Endpoints   POST /api/v1/hr-growth/vacancies         internal/api/hr_growth.go:85 → :439 saveVacancy
                POST /api/v1/hr-growth/vacancies/{id}/decide  hr_growth.go:86 → :522 decideVacancy
                GET  /api/v1/hr-growth/vacancies         hr_growth.go:84 → :375 listVacancies
                Screen: web/src/features/hr/Recruitment.tsx (key hr.hiring_growth.recruitment,
                        web/src/features/hr/growth-keys.ts:22)
    Setup       A department, a designation, and a user holding hr.employees.write.
    Steps       1. HR POSTs a vacancy with code, title, department_id, designation_id,
                   positions: 2, salary_min_paise < salary_max_paise, submit: true.
                2. HR GETs /vacancies and reads the row.
                3. Institution Admin POSTs /vacancies/{id}/decide {"action":"approve"}.
                4. Institution Admin GETs /vacancies again.
    Expected    Step 1 → 201, {"status":"pending_approval"}. Step 2 shows applicants 0,
                remaining 2. Step 3 → 200 {"status":"approved"}, and approved_by /
                approved_at are both set (a CHECK refuses one without the other,
                hr_growth.go:518). Step 4 shows status approved and the approver's name.
    Negative    (a) A HOD (hr.employees.read only) POSTing the same vacancy → 403, because
                the route carries RequirePermission(EmployeesWrite) (hr_growth.go:85).
                (b) POST decide with {"action":"promote"} → 400 "action must be approve,
                reject, hold, close or withdraw".
                (c) decide against an unknown uuid → 404 (hr_growth.go:568).
    Known gap   **No separation of duties.** Raise and approve are gated on the same
                permission (`EmployeesWrite`), so the person who raised the post can
                approve it in the next request. Record this; it is not a code defect the
                tester can work around, it is the design as built.

### ST-02 — An approved vacancy cannot be edited

    Roles       HR
    Features    hr.hiring_growth.recruitment
    Endpoints   POST /api/v1/hr-growth/vacancies   hr_growth.go:439, UPDATE guarded at :469
                ("WHERE id = $1 AND status IN ('draft','pending_approval')")
    Setup       ST-01 completed; the vacancy is 'approved'.
    Steps       1. HR POSTs the same vacancy with {"id": <approved id>, "positions": 5}.
    Expected    409 with the message from errVacancyLocked (hr_growth.go:511): "an approved
                vacancy cannot be edited; withdraw it and raise another". positions is
                still 2 on a re-read.
    Negative    Withdraw first (decide action "withdraw" → status draft), then the same
                edit succeeds with 201. That is the intended route and must work.

### ST-03 — Applications enter the funnel and cannot jump to "joined"

    Roles       HR
    Features    hr.hiring_growth.recruitment
    Endpoints   POST /api/v1/hr-growth/candidates              hr_growth.go:88 → :661
                POST /api/v1/hr-growth/candidates/{id}/stage   hr_growth.go:89 → :753
                GET  /api/v1/hr-growth/recruitment/funnel      hr_growth.go:97 → :1316
    Setup       An approved vacancy (ST-01).
    Steps       1. HR creates three candidates against the vacancy.
                2. HR moves candidate A to "screened", then "shortlisted".
                3. HR attempts to move candidate A to "joined".
                4. HR GETs the funnel.
    Expected    Steps 1–2 → 200 each, with stage_changed_at advancing and an event row
                logged (logCandidateEvent, hr_growth.go:728). Step 3 → **409 "use_hire"**
                with the message pointing at POST .../hire (hr_growth.go:767). Step 4
                returns one bucket per stage in pipeline order with a
                median_days_waiting per stage.
    Negative    Move to "interviwed" (typo) → 400 "unknown stage". Move a candidate whose
                stage is already 'joined' → the CTE matches no row → 404/500 path; assert
                it is not a silent success and the stage is unchanged.

### ST-04 — Interview and demo lesson are scheduled, sat and recorded

    Roles       HR (schedule) → HOD + Faculty as panel → HR (record)
    Features    hr.hiring_growth.recruitment
    Endpoints   POST /api/v1/hr-growth/interviews             hr_growth.go:92 → :1042
                POST /api/v1/hr-growth/interviews/{id}/result hr_growth.go:93 → :1091
                GET  /api/v1/hr-growth/interviews?upcoming=true  hr_growth.go:91 → :1002
    Setup       A shortlisted candidate (ST-03).
    Steps       1. HR schedules round "panel" with panel_user_ids = [HOD, a teacher],
                   mode "in_person", scheduled_at tomorrow.
                2. HR schedules round "demo_lesson" naming section_id and subject_id.
                3. HR GETs ?upcoming=true.
                4. HR records the demo result {"result":"pass","score":8.5,
                   "advance_to":"demo_lesson"}.
    Expected    201 twice. Step 3 lists both with result "scheduled" and the panel
                resolved to full names (array_agg over users, hr_growth.go:1008). Step 4
                → 200; the interview carries recorded_by/recorded_at and the candidate's
                stage has moved in the same transaction.
    Negative    (a) result "maybe" → 400. (b) {"advance_to":"joined"} → 409 "use_hire"
                (hr_growth.go:1108). (c) panel_user_ids containing a non-uuid → 400.
    Known gap   The demo lesson names a section and subject but nothing checks that the
                section is free at scheduled_at, and no clash is raised against the
                timetable. A demo lesson can be booked into a live period.

### ST-05 — An offer is made, and a declined offer returns the candidate to the pool

    Roles       HR → Institution Admin (signs) → candidate responds → HR records
    Features    hr.hiring_growth.recruitment
    Endpoints   POST /api/v1/hr-growth/offers                 hr_growth.go:95 → :1203
                POST /api/v1/hr-growth/offers/{id}/respond    hr_growth.go:96 → :1258
                GET  /api/v1/hr-growth/offers                 hr_growth.go:94 → :1162
    Setup       A candidate at stage "demo_lesson" (ST-04).
    Steps       1. HR POSTs an offer, gross_monthly_paise in paise, valid_until in 7 days,
                   send: true.
                2. HR GETs /offers.
                3. HR records {"status":"accepted"}.
                4. Repeat 1–3 for a second candidate with {"status":"declined"}.
    Expected    Step 1 → 201 {"status":"sent"} and the candidate's stage becomes "offered"
                in the same transaction (hr_growth.go:1240). Step 2 shows lapsed=false.
                Step 3 → 200; responded_on is today. Step 4: the declined candidate moves
                to stage "withdrawn" with outcome_reason "offer declined"
                (hr_growth.go:1291) — deliberately back in the pool, not deleted.
    Negative    (a) gross_monthly_paise 0 or negative → 400 "must be a positive number of
                paise". (b) status "pending" → 400. (c) An offer whose valid_until has
                passed and status is still 'sent' must report lapsed=true on the list
                (hr_growth.go:1170) — set valid_until to yesterday and assert.
    Known gap   No approval step on the offer itself. `issued_by` is recorded but there is
                no second signature between "HR drafts an offer" and "the offer is sent",
                and gross_monthly_paise is not checked against the vacancy's salary band.

### ST-06 — The candidate becomes an employee, exactly once

    Roles       HR
    Features    hr.hiring_growth.recruitment, hr.records.employee_master
    Endpoints   POST /api/v1/hr-growth/candidates/{id}/hire   hr_growth.go:90 → :841
                appointEmployee (shared with the staff screen) internal/api/setup.go:876
                GET  /api/v1/hr/employees                     internal/api/api.go:361 → role_backoffice.go:301
    Setup       A candidate with an accepted offer (ST-05); vacancy positions = 2.
    Steps       1. HR POSTs /hire with employee_code, joined_on, create_login: true,
                   role_key "faculty".
                2. HR immediately POSTs /hire again on the same candidate.
                3. HR GETs /hr/employees and finds the new row.
                4. HR hires the second candidate against the same vacancy.
    Expected    Step 1 → 201 with employee_id, user_id and vacancy_filled=false. The user
                is created with status 'invited' and no password (setup.go:882), so the
                account cannot be signed into yet. The candidate row is updated, not
                deleted: stage 'joined', employee_id set, hired_at set. Step 2 → **409
                "already_hired"** — the hired_at check is inside the transaction with
                FOR UPDATE OF c (hr_growth.go:871), so two clicks a second apart cannot
                both pass. Step 3 shows the employee at status 'active'. Step 4 →
                vacancy_filled=**true**, and the vacancy status becomes 'filled' only
                because both positions are now taken (hr_growth.go:927).
    Negative    (a) hire with an employee_code already in use → 409 "duplicate".
                (b) hire with create_login: true and no email on the candidate → 400
                ("an email is required to create a login", setup.go:859).
                (c) A HOD calling /hire → 403 (route carries EmployeesWrite).
    Note        Assert there is only one INSERT path into `employees`. A hire that appeared
                in recruitment and not in payroll is the failure appointEmployee exists to
                prevent; grep for a second INSERT is part of this test.

### ST-07 — KYC and documents gate the joining, and completing it opens the service book

    Roles       HR
    Features    hr.onboarding_exit.staff_onboarding_kyc_verification,
                hr.records.staff_service_book_digitalization, hr.records.employee_documents
    Endpoints   GET  /api/v1/hr/onboarding             hr_lifecycle.go:39 → :240
                POST /api/v1/hr/onboarding             hr_lifecycle.go:40 → :319
                GET  /api/v1/hr/service-book           hr_lifecycle.go:56 → :1277
                GET  /api/v1/hr/documents?expiring=true internal/api/api.go:362 → role_backoffice.go:534
                Screens: hr/Lifecycle.tsx, hr/ServiceRecords.tsx (lifecycle-keys.ts:18,24)
    Setup       The employee created in ST-06.
    Steps       1. HR GETs /hr/onboarding?pending=true.
                2. HR POSTs {"employee_id":…, "status":"verified"} with no Aadhaar date.
                3. HR POSTs status "verified" with aadhaar_verified_on and pan_verified_on.
                4. HR POSTs status "completed" with no contract_signed_on.
                5. HR POSTs status "completed" with contract_signed_on.
                6. HR GETs /hr/service-book for that employee.
    Expected    Step 1 lists the new joiner with a **named** pending list —
                ["Aadhaar","PAN","bank","originals","contract"] — not a percentage
                (hr_lifecycle.go:262). Employees with no onboarding row at all appear
                with a null id, so a school that started in June sees two hundred rows
                rather than an empty table. Step 2 → 400 with the sentence "Aadhaar and
                PAN have to be verified, with the date each was checked…"
                (hr_lifecycle.go:339). Step 3 → 200. Step 4 → 400 "onboarding is not
                complete until the contract is signed". Step 5 → 200. Step 6 shows one
                `appointment` entry, attested by the person who completed the KYC, created
                automatically (hr_lifecycle.go:387) and **idempotent** — repeat step 5 and
                assert still exactly one appointment entry (NOT EXISTS guard, :400).
    Negative    A HOD POSTing to /hr/onboarding → 403 (EmployeesWrite, hr_lifecycle.go:40).

---

## B. Allocation

### ST-08 — Heading a department is what creates the HOD's reach

    Roles       Institution Admin → HOD
    Features    institution_admin.directory_workload.faculty_directory_workload
    Endpoints   scope resolution: internal/scope/scope.go:107
                ("SELECT id FROM departments WHERE head_user_id = $1")
                and department sections at scope.go:128
                GET /api/v1/hr-growth/appraisal/records  hr_growth.go:104 (proves the reach)
    Setup       Two departments, D1 and D2, each with two employees. A HOD user is
                `departments.head_user_id` for D1 only, holding role `hod`.
    Steps       1. Set head_user_id of D1 to the HOD user.
                2. HOD calls any narrowed list (e.g. GET /hr/background-checks).
                3. Unset head_user_id and repeat.
    Expected    Step 2 returns D1's staff plus the HOD's own row. Step 3 returns **only
                the HOD's own row** — employeeFilter falls through to `e.id = $n`
                (hr_growth.go:208), never to every row. A HOD who heads nothing sees one
                person: themselves. This is the load-bearing assertion behind every test
                in section F.
    Negative    A user with no `employees` row at all (a platform operator) yields
                OwnEmpID nil and DeptIDs empty → employeeFilter returns literal **FALSE**
                (hr_growth.go:214), i.e. no rows. Assert the response is an empty list and
                not an unfiltered one.

### ST-09 — Subjects are allocated to teachers, and a cell can be cleared

    Roles       Institution Admin / HOD (academics.write)
    Features    institution_admin.directory_workload.faculty_allocation_workload
    Endpoints   GET  /api/v1/academics/admin/faculty-allocation   admin_academics.go:79
                POST /api/v1/academics/admin/faculty-allocation   admin_academics.go:80 → :699
                POST /api/v1/setup/assign-teacher (single cell)   internal/api/api.go:207
    Setup       A class with class_subjects carrying periods_per_week, and two sections.
    Steps       1. HOD GETs the allocation grid for the class.
                2. HOD POSTs allocations naming section_id, class_subject_id and
                   teacher_user_id for four cells.
                3. HOD POSTs one allocation with teacher_user_id: "" .
                4. HOD re-GETs the grid.
    Expected    Step 2 → 200 {"assigned":4,"cleared":0}; the upsert targets
                (section_id, class_subject_id) so re-posting the same grid is idempotent
                (admin_academics.go:737). Step 3 → {"assigned":0,"cleared":1} — the bulk
                path is the only one that can empty a cell (comment at :696). Step 4
                shows the cleared cell unstaffed.
    Negative    (a) A subject teacher (`faculty` role) POSTing → 403, the route carries
                RequirePermission(AcademicsWrite) (admin_academics.go:50).
                (b) An empty allocations array → 400 "send at least one allocation".
                (c) A malformed section_id → 400 "section_id must be a uuid", and assert
                **no partial write**: the loop runs inside one InTenant transaction, so
                a bad fifth row must roll back the first four.

### ST-10 — Teaching load is capped when the timetable draft is edited

    Roles       Institution Admin / Vice Principal (timetable.write)
    Features    institution_admin.directory_workload.staff_allocation_workload
    Endpoints   master timetable draft edit: internal/api/master_timetable.go:750-780
                (per-day cap :775, per-week cap :778; defaults 6/day and 35/week from
                teacher_load_rules, :754)
                GET /api/v1/.../staff-workload  internal/api/api.go:239 → role_principal.go:176
    Setup       A published year, periods, a draft, and a teacher already carrying 6
                periods on Monday.
    Steps       1. Place a 7th Monday period for that teacher in the draft.
                2. Set teacher_load_rules.max_periods_per_day = 7 for them and retry.
                3. Drive the weekly cap the same way against max_periods_per_week.
                4. Call /staff-workload.
    Expected    Step 1 → refused with errTeacherDayCap. Step 2 → accepted. Step 3 →
                refused with errTeacherWeekCap. Note the counting is a UNION of draft
                entries and live entries for sections **not** in the draft
                (master_timetable.go:762-770) — assert a teacher's live load in an
                untouched section still counts against the cap. Step 4 returns weekly
                periods, distinct subjects and distinct sections per active employee.
    Negative    A teacher on `teacher_unavailability` for that weekday/period → refused
                with errTeacherUnavail regardless of cap, and a teacher already booked
                elsewhere → errTeacherBusy. Confirm the three refusals are distinguishable
                to the user, not one generic 409.
    Known gap   `getStaffWorkload` (role_principal.go:176) is **not narrowed** and is not
                bounded by academic year: `count(*) FROM timetable_entries WHERE
                teacher_user_id = u.id` counts every year ever recorded. In year two this
                number is wrong for everybody.

---

## C. The working month

### ST-11 — The staff register is marked, and it is the only thing payroll reads

    Roles       HR (hr.attendance.write)
    Features    hr.attendance.staff_attendance
    Endpoints   GET  /api/v1/workflow/staff-register    internal/api/api.go:162 → mod_workflow.go:304
                POST /api/v1/workflow/staff-attendance  internal/api/api.go:163 → mod_workflow.go:225
                Screen: web/src/features/hr/StaffAttendance.tsx (registry.ts:260)
    Setup       Five active employees with linked user accounts.
    Steps       1. HR POSTs a register for the 3rd with statuses present, absent, late,
                   half_day, leave — with check_in "09:25" on the late row.
                2. HR GETs /workflow/staff-register.
                3. HR re-POSTs the 3rd changing one person from absent to present.
    Expected    Step 1 → 200 {"written":5}. check_in is stored as timestamptz anchored to
                the register's date in the institution's timezone (mod_workflow.go:258),
                **not** as a bare time — assert the stored instant, because a UTC box
                is what makes an evening register empty. Step 3 upserts on
                (user_id, on_date) and updates marked_by; assert one row per person per
                day, not two.
    Negative    (a) status "sick" → 400 "invalid status: sick", listing exactly the set
                the CHECK allows (mod_workflow.go:242). (b) Empty entries → 400.
                (c) A HOD POSTing → 403 (StaffAttend is not in the `hod` role,
                rbac.go:309). (d) A teacher marking their own attendance → 403.
    Known gap   Biometric sync is `deferred` (`hr.attendance.biometric_machine_attendance_sync`,
                ROLES_AND_FEATURES.csv:130). Every day of the month is typed by hand, and
                that typing is the sole input to loss of pay.

### ST-12 — A teacher applies for leave and HR decides it

    Roles       Faculty → HR (or HOD, both hold hr.leave.approve)
    Features    hr.leave.leave, faculty.my_profile.leave_self_service
    Endpoints   POST /api/v1/workflow/leave              internal/api/api.go:155 → mod_workflow.go:39
                POST /api/v1/workflow/leave/{id}/decide  internal/api/api.go:160 → mod_workflow.go:139
                GET  /api/v1/hr/leave                    internal/api/api.go:355 → role_backoffice.go:353
                Screen: web/src/features/hr/Leave.tsx (registry.ts:361 and :379)
    Setup       The teacher's user is linked to an employees row; a leave_type with a
                leave_balances row.
    Steps       1. Teacher POSTs from 2026-09-10 to 2026-09-12, reason given.
                2. Teacher GETs /hr/leave and sees their own request as pending.
                3. HR POSTs decide {"decision":"approved"}.
                4. HR re-reads leave_balances.
    Expected    Step 1 → 201 {"days":3,"status":"pending"}; a half-day request records
                days 0.5 (mod_workflow.go:64). Step 2 works **without** any hr.* grant —
                the route is deliberately mounted outside the /hr group (api.go:347-355)
                and the query narrows to `e.user_id = $2` when the caller lacks
                EmployeesRead (role_backoffice.go:357). Step 3 → 200. Step 4: `used` has
                increased by 3 (mod_workflow.go:184) — without this the entitlement means
                nothing.
    Negative    (a) to_date before from_date → 400 "the leave ends before it starts".
                (b) Empty reason → 400. (c) A user with no employee row → 400 "your
                account is not linked to an employee record". (d) Deciding an already
                decided request → 404 "no pending leave request with that id" (the guard
                is inside the UPDATE, mod_workflow.go:174, so there is no read-then-write
                window). (e) A class teacher without hr.leave.approve deciding a *staff*
                request → no row matches → 404, while the same teacher deciding their own
                student's request succeeds (the `$5 OR EXISTS(...)` guard, :156).

### ST-13 — The leave policy is configured and the LOP register honours it

    Roles       HR
    Features    hr.leave.leave_policy_configuration, hr.leave.half_day_leave_deduction_calculation,
                hr.leave.late_arrival_loss_of_pay_lop
    Endpoints   GET  /api/v1/hr/leave-policy   hr_lifecycle.go:79 → :2257
                POST /api/v1/hr/leave-policy   hr_lifecycle.go:80 → :2320
                GET  /api/v1/hr/lop?year=&month=  hr_lifecycle.go:81 → :2410
                function staff_lop_register  migrations/00031_hr_lifecycle.sql:801 (3-arg)
                                             and :933 (2-arg wrapper the handler calls)
                Screen: web/src/features/hr/LeavePolicy.tsx (lifecycle-keys.ts:33-35)
    Setup       A month of staff attendance for one teacher: 2 absent, 2 half_day,
                4 late marks with check_in past the grace, 1 day of *unpaid* approved
                leave and 1 day of *paid* approved leave.
    Steps       1. HR saves a policy: half_day_fraction 0.5, shift_starts_at 09:00,
                   grace_minutes 10, late_marks_per_lop_day 3, lop_on_absent true,
                   lop_on_unpaid_leave true, max_lop_days_per_month null.
                2. HR GETs /hr/lop for that month.
                3. HR sets max_lop_days_per_month = 2 and re-reads.
    Expected    Step 2: absent 2 + half_days 1.0 (2 × 0.5) + unpaid leave 1.0 + one LOP
                day from 3 of the 4 late marks (the 4th waits, it is not carried forward —
                migrations/00031:797) = **4.0 lop_days**, and the paid leave day costs
                nothing. The response also carries total_lop_days summed server-side
                (hr_lifecycle.go:2437). Step 3 caps it at 2.0.
                Every day lands in exactly one bucket — assert absent + half + unpaid never
                double-charge the same date (the single CASE at 00031:870).
    Negative    A school that has never opened the policy screen must still get a register:
                delete the leave_policy row and re-run; the function falls back to the
                documented defaults (00031:822-832) rather than erroring.

### ST-14 — Payroll cannot start, because nothing creates a salary structure

    Roles       HR
    Features    hr.payroll.salary_structure_builder, hr.payroll.payroll
    Endpoints   POST /api/v1/payroll/run   internal/api/api.go:503 → mod_ops.go:547
                the employee query INNER JOINs salary_structures at mod_ops.go:607
                Screen: web/src/features/payroll/Payroll.tsx (registry.ts:205)
    Setup       A fresh tenant with active employees, staff attendance marked, and no
                manual SQL.
    Steps       1. Search the product for any writer of `salary_structures`,
                   `salary_structure_items` or `salary_components`.
                2. HR POSTs /payroll/run for the month.
    Expected    Step 1 finds **none** — there is no INSERT into any of the three tables
                anywhere in `internal/`, `cmd/`, `migrations/` or the seed data; the only
                references are the four reads at payroll_statutory.go:575, :680 and
                mod_ops.go:607, :644. Step 2 therefore returns 200 with
                **{"employees":0, "gross_paise":0}** — a payroll run that succeeds and
                pays nobody.
    Negative    Insert a structure by hand in psql, re-run, and assert the same employee
                now produces a payslip. That is the proof the blocker is the missing
                writer and not the run.
    Known gap   **P0, not previously reported.** `hr.payroll.salary_structure_builder` is
                `built` in ROLES_AND_FEATURES.csv:153, `true` in implemented_gen.go:154 and
                mapped to a screen in registry.ts:205, and the table it exists to fill has
                no writer. This is the same shape of near-miss as the Form 16 generator
                (ST-17) and the refunds finding in 03_monthly_term.md. **Every test from
                ST-15 to ST-20 requires a hand-seeded salary structure.**

### ST-15 — LOP is computed twice, differently, and the payslip wins

    Roles       HR → Faculty (who is told a different number)
    Features    hr.payroll.payroll, hr.leave.late_arrival_loss_of_pay_lop
    Endpoints   GET  /api/v1/hr/lop        hr_lifecycle.go:2410 (calls staff_lop_register)
                POST /api/v1/payroll/run   mod_ops.go:547; the inline count at **:601-605**
                GET  /api/v1/payroll/payslips  api.go:502 → mod_ops.go:845
    Setup       ST-13's attendance month, plus a hand-seeded salary structure (ST-14).
    Steps       1. HR GETs /hr/lop for the month and records lop_days for the teacher.
                2. HR POSTs /payroll/run for the same month.
                3. HR GETs /payroll/payslips and reads lop_days and paid_days.
    Expected    **They disagree, and the test passes by proving they disagree.** The
                register says 4.0 (ST-13). The payslip says 2 — `runPayroll` counts only
                `staff_attendance.status = 'absent'` in an inline subquery
                (mod_ops.go:601-605): half days cost nothing, late marks cost nothing,
                unpaid leave costs nothing, and a day of *approved paid* leave that was
                marked 'absent' by mistake costs a full day. paid_days is
                daysInMonth − that count, and every earning is pro-rated on it
                (mod_ops.go:670).
    Negative    Mark one day of *approved paid* leave with status 'absent'. The register
                charges 0 for it; the payslip charges a full day. This is the specific case
                a teacher will bring to the office.
    Known gap   03_monthly_term.md §2, "Leave → LOP", P0. The comment on getLOPRegister
                (hr_lifecycle.go:2404) claims both the screen and the payslip call
                staff_lop_register — "the only way to guarantee they agree". They do not.
                A fix is one query: replace the inline count with the function.

### ST-16 — A payroll run computes PF, ESI and PT from the wage, plus proxy periods and advances

    Roles       HR
    Features    hr.payroll.payroll, hr.statutory.pf_esi_statutory_compliance,
                hr.statutory.professional_tax_pt_slab_configuration,
                hr.payroll.substitute_workload_allowance, hr.payroll.staff_loan_advance_management
    Endpoints   PUT  /api/v1/payroll/settings  api.go:508 → payroll_statutory.go:140
                POST /api/v1/payroll/run       mod_ops.go:547; computeStatutory at
                                               payroll_statutory.go:248, called :705
                GET  /api/v1/payroll/statutory payroll_statutory.go:328
                POST /api/v1/payroll/loans     api.go:517 → payroll_tax.go:536
    Setup       Payroll settings with PF enabled, ceiling set, ESI enabled with a
                threshold, PT slabs with a February row. One teacher above the ESI
                threshold, one below. One teacher with 9 substitutions taken this month
                (`substitutions.substitute_user_id`). One teacher with an active advance
                whose remaining balance is *less* than the instalment.
    Steps       1. HR runs payroll.
                2. HR reads the payslip breakup for each of the four.
                3. HR GETs /payroll/statutory for the month.
                4. HR runs February's payroll.
    Expected    • PF is computed on **BASIC + DA only**, capped at the ceiling, not on
                  gross (payroll_statutory.go:250-258); the ceiling caps the wage, it does
                  not exclude the employee.
                • EPS comes **out of** the employer's share, and PF_EMPLOYER + EPS add back
                  to the employer contribution (payroll_statutory.go:262-264).
                • ESI is zero for the employee above the threshold and non-zero below
                  (:267).
                • A PF/ESI/PT component that also exists as a fixed deduction on the
                  structure is skipped, so nothing is deducted twice (mod_ops.go:659-663).
                • SUBST = 9 × substitution rate appears as an **earning** (mod_ops.go:697).
                • The advance instalment is capped at what is still owed and the loan is
                  closed the moment the last instalment is taken (mod_ops.go:770-786);
                  a `loan_deductions` row exists keyed (loan_id, year, month) so a re-run
                  amends rather than accumulates.
                • Step 3: the register is computed **from the payslips issued**, not
                  recomputed from structures (payroll_statutory.go:322-325), so it can never
                  disagree with them; employees missing a UAN/ESI/PAN are named in
                  `missing` rather than silently dropped.
                • Step 4: the February PT slab is used (professionalTax, :287, month==2).
    Negative    Earnings pro-rate on paid days; **deductions do not** (mod_ops.go:646-652).
                Give a teacher 10 absent days and assert PF/ESI/PT are unchanged while
                BASIC falls — then argue whether that is right, and record the answer.

### ST-17 — There is no TDS line, and no Form 16

    Roles       HR → Faculty (who discovers it in Q4)
    Features    hr.statutory.income_tax_form_16_generator, hr.statutory.form_12bb_investment_declarations
    Endpoints   GET  /api/v1/payroll/tax?employee_id=   api.go:513 → payroll_tax.go:125
                GET  /api/v1/payroll/declarations       api.go:514 → payroll_tax.go:353
                POST /api/v1/payroll/declarations       api.go:515 → payroll_tax.go:389
                computeStatutory                        payroll_statutory.go:248
    Setup       A teacher with a salary structure well above the exemption limit, an
                elected regime, and two verified investment declarations.
    Steps       1. HR GETs /payroll/tax for that employee and records monthly_tds_paise.
                2. HR runs payroll for the month.
                3. HR reads the payslip breakup.
                4. Search the router for any Form 16 or Form 24Q endpoint.
    Expected    Step 1 returns a full, defensible working: gross projected over 12 months
                from the months actually paid (payroll_tax.go:176), Chapter VI-A capped at
                the 80C limit, standard deduction, slab tax, rebate, cess, and
                monthly_tds_paise spread over the months remaining (:259). Step 3: the
                breakup contains PF, EPS, ESI, ESI_EMPLOYER, PF_EMPLOYER, PT, SUBST,
                ADVANCE — and **no TDS key of any kind**. `computeStatutory` returns a
                struct with four fields and none of them is tax (payroll_statutory.go:225-232).
                Step 4 finds **no Form 16 handler** anywhere.
    Negative    Assert the new-regime path does **not** apply Chapter VI-A
                (payroll_tax.go:243-252) — under `"regime":"new"` deductions are the
                standard deduction alone. Under `"old"` they are standard + Chapter VI-A +
                professional tax. Getting this backwards always under-withholds.
    Known gap   03_monthly_term.md §2, "TDS", P0. `hr.statutory.income_tax_form_16_generator`
                is `built` in ROLES_AND_FEATURES.csv:165 and `true` in
                implemented_gen.go:175, and the generator does not exist. A school running
                this as built deducts nothing under s.192 all year.

### ST-18 — The bank file is exported, and it names the unpayable rather than dropping them

    Roles       HR → Finance
    Features    hr.payroll.direct_bank_payroll_transfer_file
    Endpoints   GET /api/v1/payroll/bank-file?year=&month=  api.go:511 → payroll_statutory.go:474
                GET /api/v1/payroll/ecr                     api.go:510 → payroll_statutory.go:411
    Setup       A processed run (ST-16) in which one employee has no bank_account and one
                has a comma in their name.
    Steps       1. HR GETs /payroll/bank-file.
                2. HR GETs /payroll/ecr.
    Expected    Step 1 → text/csv with the header row, Content-Disposition
                salary-YYYY-MM.csv, and an **X-Missing-Bank-Details: 1** response header
                (payroll_statutory.go:517). The employee with no account is written into
                the file with empty columns, not skipped — a silently shorter file is how
                one person goes unpaid. The comma in the name is replaced with a space
                (csvSafe, :523). Amounts are rupees to 2dp.
                Step 2 → the EPFO 11-field hash-separated format, no header, one line per
                member, whole rupees only (divided once, at :453), members with zero PF
                skipped, ordered by UAN.
    Negative    Ask for a month with no run at all → an empty file with only the header
                and X-Missing-Bank-Details: 0, not a 500.
    Known gap   No ESI return file, no PT challan, no Form 24Q (03_monthly_term.md,
                "Statutory returns after payroll", P1).

### ST-19 — Payroll can be silently recomputed after the bank file was exported

    Roles       HR → Finance (who has already paid) → Faculty (whose payslip changes)
    Features    hr.payroll.payroll, finance.reconciliation.connected_banking_payouts
    Endpoints   POST /api/v1/payroll/run   mod_ops.go:547
                the guard at **mod_ops.go:574** ("status == locked || status == paid")
                the delete at **mod_ops.go:580** (DELETE FROM payslips WHERE payroll_run_id)
                the only status write in the codebase, **mod_ops.go:812** (sets 'processed')
                payout eligibility at internal/api/banking.go:2912
                ("WHERE pr.status IN ('processed','locked')")
    Setup       A processed run, a bank file downloaded (ST-18), and a payout batch built
                from those payslips.
    Steps       1. Record every payslip's net_paise.
                2. Change one employee's staff attendance for that month (mark two extra
                   absences).
                3. HR POSTs /payroll/run for the **same** month again.
                4. Re-read the payslips and the payout batch.
    Expected    Step 3 → **200, not 409.** The upsert on
                (institution_id, period_year, period_month) returns the existing run with
                status 'processed'; the guard only fires on 'locked' or 'paid', and
                nothing in the product ever writes either — grep `UPDATE payroll_runs`
                across the repo returns exactly one hit, mod_ops.go:812, setting
                'processed'. So `errPayrollLocked` (mod_ops.go:832) is **unreachable
                code**. The old payslips are deleted and rebuilt; the employee's net pay
                is now different from the amount already in the bank file, and the ECR
                built from the old numbers no longer ties.
    Negative    Attempt to reach the 409 at all: there is no endpoint, job or migration
                that sets status 'locked' or 'paid'. Assert this by search — the absence
                is the finding. Until a lock verb exists, no test can make the guard fire.
    Known gap   00_TIMELINE.md, OCT: "payroll can be silently recomputed after bank
                export"; 03_monthly_term.md §1, P0. The comment above runPayroll
                (mod_ops.go:543) states an intention — "A locked run is never recomputed —
                a payslip already issued must keep its numbers" — that the code does not
                implement.

### ST-20 — A teacher cannot see their own payslip at all

    Roles       Faculty
    Features    hr.payroll.payslip_generation_email_dispatch
    Endpoints   GET /api/v1/payroll/payslips  api.go:500-502; the group carries
                RequirePermission(rbac.PayrollRead) at api.go:501
    Setup       A processed run containing the teacher's payslip.
    Steps       1. Teacher GETs /payroll/payslips.
                2. Search the router for any self-service payslip route
                   (`/me/payslip`, under /profile, or in hr_growth's self-service group
                   at hr_growth.go:63-68).
    Expected    Step 1 → **403**: `hr.payroll.read` is not in the `faculty` role
                (rbac.go:325-328). Step 2 finds nothing — the self-service group carries
                appraisals, training and duties, and no payslip. There is no PDF, no
                password-protected dispatch and no publish-to-portal handler.
    Negative    HR calling the same route with ?month=&year= sees **every** employee's
                payslip; listPayslips (mod_ops.go:845) applies no narrowing at all. That
                is defensible for the payroll office and must be asserted deliberately,
                because it means PayrollRead is an all-or-nothing grant over pay.
    Known gap   03_monthly_term.md, "Payslip issue to staff", P1. The catalogue calls this
                feature `built` (ROLES_AND_FEATURES.csv:151).

### ST-21 — The HR dashboard's pending-leave count is always zero

    Roles       HR
    Features    hr.home.hr_kpis
    Endpoints   GET /api/v1/hr/dashboard   api.go:360 → role_backoffice.go:262
                the query at **role_backoffice.go:274** ("subject_kind = 'employee'")
                the writer at mod_workflow.go:105 (kind := "staff")
                the CHECK at migrations/00001_baseline.sql:881
                (subject_kind IN ('staff','student'))
    Setup       Three pending staff leave requests (ST-12).
    Steps       1. HR GETs /hr/dashboard.
                2. HR GETs /hr/leave?status=pending and counts.
    Expected    Step 1 returns **leave_pending: 0**. Step 2 returns 3. The dashboard filters
                on a value the check constraint forbids, so the tile can never be non-zero.
    Negative    Compare with internal/api/attention.go:341, which counts pending leave with
                no subject_kind filter and is correct. Two counts of the same thing, one
                of them structurally zero.

---

## D. Duty

### ST-22 — Gate duty is rostered, and a teaching clash is refused with the list attached

    Roles       Institution Admin / HR → Faculty (who reads the roster)
    Features    hr.attendance.staff_shift_rostering
    Endpoints   GET  /api/v1/hr-growth/roster/shifts   hr_growth.go:125 → :2818 (seeds the
                     standard shifts on first read, incl. INVIG "Exam invigilation")
                POST /api/v1/hr-growth/roster          hr_growth.go:128 → :3026 assignDuty
                GET  /api/v1/hr-growth/roster          hr_growth.go:127 → :2958
                GET  /api/v1/hr-growth/roster/conflicts hr_growth.go:130 → :3209
                GET  /api/v1/hr-growth/me/duties       hr_growth.go:68 → :2972
                Screen: web/src/features/hr/Rostering.tsx (growth-keys.ts:25)
    Setup       A teacher timetabled to teach period 1 on Tuesdays; the seeded GATE_AM
                shift 07:15–08:00.
    Steps       1. HR GETs /roster/shifts on a fresh tenant.
                2. HR POSTs a roster for that teacher, from_date to to_date spanning two
                   weeks, no override_reason, on a shift overlapping their teaching period.
                3. HR re-POSTs the identical request with
                   override_reason: "invigilation replaces the lesson".
                4. HR GETs /roster; the teacher GETs /me/duties.
    Expected    Step 1 seeds GATE_AM, DISPERSAL, BUS_ESC, LIB_DESK, LAB_DUTY and INVIG
                exactly once per institution (the NOT EXISTS guard, hr_growth.go:2816).
                Step 2 → **409 with code "roster_clash" and a `clashes` array** naming the
                date, person, kind and detail (hr_growth.go:3147) — not a bare "something
                clashed" — and the **whole batch is rolled back** (:3135), so a fortnight
                is never half written. Step 3 → 201 with `assigned` = the number of rows
                and the reason written onto every one of them. Step 4: the roster is
                **not** narrowed by department (comment at :2953-2956) — any member of staff
                can see who is on the gate on Tuesday, which is what makes a swap
                arrangeable; /me/duties returns only the caller's.
    Negative    (a) Re-post step 3 a third time: `ON CONFLICT (user_id, on_date, shift_id)
                WHERE status <> 'cancelled' DO NOTHING` makes it a no-op, assigned=0
                (hr_growth.go:3093) — a roster is published twice more often than it is
                written once. (b) to_date before from_date → 400. (c) A range over 200
                days → 400. (d) An inactive shift id → 400 "no active shift with that id".
                (e) weekday arithmetic: assert Sunday maps to 7, not 0 (:3077).

### ST-23 — Double-booking and approved leave are refused outright, and no reason overrides them

    Roles       HR
    Features    hr.attendance.staff_shift_rostering
    Endpoints   POST /api/v1/hr-growth/roster  hr_growth.go:3026; the DB refusals surface
                at :3144-3149 (pg codes 23514 / P0001 → 409 "refused")
                duty_roster_conflicts()  migrations/00054_hr_growth.sql (roster triggers)
    Setup       A teacher already rostered on DISPERSAL 15:00–15:45 on the 8th, and a
                second teacher with approved leave on the 8th.
    Steps       1. HR rosters teacher 1 onto an overlapping shift on the 8th, **with** an
                   override_reason.
                2. HR rosters teacher 2 (on approved leave) onto any shift on the 8th,
                   **with** an override_reason.
    Expected    Both → 409 "refused", carrying the database's own message. These two are
                the trigger's and are not negotiable; the override reason applies only to
                the teaching clash of ST-22. Assert the reason does not soften either.
    Negative    Cancel the first duty (POST /roster/{id}/cancel, hr_growth.go:129 → :3177)
                and re-roster: it now succeeds, because the partial unique index excludes
                cancelled rows. Cancelling an already-cancelled duty → 404.

### ST-24 — Invigilation cannot be tied to an exam, a paper or a hall

    Roles       Exam Controller → HR → Faculty
    Features    hr.attendance.staff_shift_rostering, institution_admin.examinations.hall_ticket_issue
    Endpoints   the INVIG shift, hr_growth.go:2815 (duty_shifts seed)
                duty_assignments columns: shift_id, user_id, on_date, starts_at, ends_at
                exam halls: internal/api/exam_hall.go (halls, seats, hall sheet at :418)
    Setup       An exam with halls allocated and seats assigned.
    Steps       1. Roster three teachers onto INVIG for the exam dates.
                2. Attempt to record which of them invigilates Hall 2 for Class X Maths.
    Expected    Step 1 works — a generic date + shift roster with the ST-22 clash check.
                Step 2 **cannot be done**: `duty_assignments` carries no exam_id,
                exam_subject_id or hall_id, and no endpoint accepts one. The question
                "who invigilates Hall 2 for Class X Maths" is unanswerable from this
                database.
    Known gap   03_monthly_term.md, "Invigilation duty", P1. Compounded by the datesheet
                gap (same document, P0): `exam_subjects.exam_date` / `starts_at` /
                `duration_minutes` are read in eight places and written by none, so there
                are no per-paper times to roster against in the first place.

### ST-25 — Onerous duty is distributed, and the staff room can see whether it is

    Roles       Faculty (asks) → Institution Admin (answers)
    Features    hr.attendance.staff_shift_rostering
    Endpoints   GET /api/v1/hr-growth/roster/fairness?from=&to=  hr_growth.go:131 → :3248
    Setup       Over one month: teacher A on 8 gate/dispersal duties, teacher B on 1,
                teacher C on 6 library-desk slots (is_onerous false).
    Steps       1. Institution Admin GETs /roster/fairness for the month.
    Expected    Rows ordered by onerous duties descending. `onerous_index` is each person's
                share of the unpopular duties **against the average**, so 2.0 means twice
                everybody else's (hr_growth.go:3264-3265). Teacher C's six library slots do not
                inflate their onerous count — `is_onerous` on the shift is what makes the
                question answerable at all. Hours are summed from ends_at − starts_at.
    Negative    A range in which nobody was rostered → empty list, not a division by zero;
                the avg(onerous) guard is at :3264.

---

## E. Growth

### ST-26 — A cycle opens only when the KPI weights total 100

    Roles       HR → Institution Admin
    Features    hr.hiring_growth.annual_performance_appraisal_kpi
    Endpoints   POST /api/v1/hr-growth/appraisal/cycles   hr_growth.go:101 → :1398
                PUT  /api/v1/hr-growth/appraisal/kpis     hr_growth.go:103 → :1516
                GET  /api/v1/hr-growth/appraisal/cycles   hr_growth.go:100 → :1359
                POST /api/v1/hr-growth/appraisal/records  hr_growth.go:106 → :1806
                Screen: web/src/features/hr/Appraisal.tsx (growth-keys.ts:23)
    Setup       Three designations: teacher (weights summing 100), accountant (summing 90),
                librarian (no KPIs at all).
    Steps       1. HR creates the cycle with opens_on, self_due_on, review_due_on,
                   closes_on and score_scale_max 5.
                2. HR saves the three KPI sets.
                3. HR GETs /appraisal/cycles.
                4. HR raises appraisals for the whole school, naming reviewer_user_id per
                   department.
    Expected    Step 3 reports **unbalanced_roles: 2** on the cycle, before anybody tries
                to raise it (hr_growth.go:1356). Step 4 returns a per-employee result:
                "43 raised, 6 skipped because the accountant's KPIs total 90" — the
                database refusal is reported per employee, **not** as one 500 for the
                batch (comment at hr_growth.go:1800-1804). Each appraisal is created with its
                designation snapshotted and one rating row per KPI carrying **the weight
                as it stands today**, copied not joined, so editing the cycle next month
                cannot restate a score already signed (:1798).
    Negative    Change a KPI weight after step 4 and re-read an appraisal's ratings: the
                stored weight is unchanged. This is the assertion that makes a signed
                appraisal evidence.

### ST-27 — The teacher's self-assessment, and what it closes

    Roles       Faculty
    Features    hr.hiring_growth.annual_performance_appraisal_kpi, faculty.my_profile.*
    Endpoints   GET  /api/v1/hr-growth/me/appraisals            hr_growth.go:63 → :2209
                GET  /api/v1/hr-growth/me/appraisals/{id}       hr_growth.go:64 → :2224
                POST /api/v1/hr-growth/me/appraisals/{id}/self-assessment
                                                               hr_growth.go:65 → :1941
                Screen: web/src/features/hr/MyGrowth.tsx
    Setup       An appraisal raised for the teacher (ST-26).
    Steps       1. Teacher (holding only self.profile.read + write) GETs /me/appraisals.
                2. Teacher submits ratings per KPI with notes and comments.
                3. Teacher re-submits with different scores.
                4. Reviewer reviews (ST-28); teacher submits again.
    Expected    Step 1 → 200 **without any hr.* grant** — the self-service group is mounted
                separately on SelfProfileRead (hr_growth.go:61-69) precisely so a teacher
                opening their own appraisal is not 403'd. Step 2 → 200 status
                'self_submitted'; self_score is recomputed **in the database** as a
                weighted mean of the ratings actually stored (weightedScoreSQL,
                hr_growth.go:1975-1980), never a number the client sent. Step 3 → still
                allowed (status is 'self_submitted'). Step 4 → refused with
                errAppraisalClosed: "this appraisal is past the stage that can be edited"
                (:1965, :2036).
    Negative    (a) The ownership check is the WHERE clause of the read, not a prior
                read (comment at :1959) — submit against another employee's appraisal id
                and assert **404**, not 403 (see ST-33). (b) A parent or platform operator
                calling /me/appraisals → 404 "not_staff" with the message "you have no
                staff record in this school" (ownEmployee, hr_growth.go:249) — they have not been
                denied anything, they are not staff.
    Note        `listMyAppraisals` filters to statuses not_started, self_submitted,
                published, acknowledged (:2219) — a teacher must **not** see their own
                appraisal while it is 'reviewed' or 'moderated'. Assert that a mid-
                calibration draft score is invisible.

### ST-28 — The reviewer is a HOD with `employees.read` only, and that must stay true

    Roles       HOD (reviewer) → HR
    Features    hr.hiring_growth.annual_performance_appraisal_kpi
    Endpoints   POST /api/v1/hr-growth/appraisal/records/{id}/review
                **hr_growth.go:110 — deliberately NOT wrapped in `write`**, see the
                comment at :107-109; the handler is at :2010
    Setup       A HOD holding the seeded `hod` role — which carries `hr.employees.read`
                and **not** `hr.employees.write` (rbac.go:309-313) — named as
                `reviewer_user_id` on an appraisal in their department.
    Steps       1. HOD POSTs ratings and comments to .../review.
                2. HR (holding employees.write) POSTs a review on an appraisal where they
                   are not the named reviewer.
                3. Walk the router and assert /review is the **only** POST under
                   /hr-growth/appraisal that does not carry RequirePermission(EmployeesWrite).
    Expected    Step 1 → **200**, status 'reviewed', reviewer_score recomputed in the
                database. Step 2 → 200: `backOffice := id.Can(EmployeesWrite)`
                (hr_growth.go:2020) lets HR review anything. Step 3 → exactly one such
                route, and it is /review.
    Negative    A HOD who is **not** the named reviewer POSTing → **403** with "you are not
                the reviewer named on this appraisal" (hr_growth.go:2063). Note this is
                403 and not 404 — and that is correct here, because the caller reached a
                write verb on a record they were legitimately shown; contrast ST-33.
    Known gap   None — this is a *design assertion*, and it must not regress. Wrapping
                /review in `RequirePermission(EmployeesWrite)` would 403 the only person
                who ever uses it, because HODs do not hold that grant and should not be
                given write over employee records in order to fill in a form about their
                own team. The narrowing here is the rule ("you are the named reviewer"),
                which is strictly narrower than any permission. If this test starts
                failing with 403 for the named reviewer, the fix is to remove the
                middleware, not to widen the role.

### ST-29 — Moderation, publication and the teacher's acknowledgement

    Roles       HOD (review) → HR (moderate) → HR (publish) → Faculty (acknowledge)
    Features    hr.hiring_growth.annual_performance_appraisal_kpi
    Endpoints   POST .../{id}/moderate    hr_growth.go:111 → :2077
                POST .../{id}/publish     hr_growth.go:112 → :2130
                POST .../{id}/discussion  hr_growth.go:113 → :2176
                POST /me/appraisals/{id}/acknowledge  hr_growth.go:66 → :2244
    Setup       Two appraisals reviewed by two different HODs, one lenient one not.
    Steps       1. HR moderates one of them, sending revised per-KPI scores and a note.
                2. HR moderates the other sending **no** ratings, only a note.
                3. HR records the discussion note and date.
                4. HR publishes both with final_band and increment_percent.
                5. Teacher GETs /me/appraisals/{id} and POSTs acknowledge with comments.
                6. HR attempts to moderate a published one.
    Expected    Step 1 → status 'moderated', moderator_user_id set from the session
                (COALESCE, so it is not overwritten on a second pass). Step 2 →
                moderated_score falls back to **reviewer_score** — "nothing moderated
                leaves the reviewer's number standing", which is what "no change" has to
                mean (hr_growth.go:2104). Step 3 → 200; an empty note → 400 ("a note of
                what was discussed is required", :2197). Step 4 → 200 with final_score =
                COALESCE(moderated, reviewer) — **never the self-assessment**, which is an
                input and not a verdict (:2144); the row now shows to the teacher. Step 5
                → 200 status 'acknowledged' with the employee's right of reply stored.
                Step 6 → 409 errAppraisalClosed (the UPDATE excludes published/acknowledged
                and reports 0 rows affected as a refusal, :2073).
    Negative    (a) Publish an appraisal that was never reviewed → 409 errNotReviewed:
                "an appraisal can only be published once it has been reviewed and has a
                score" (:2166). (b) Acknowledge an appraisal that is not yet published →
                the UPDATE matches no row → 404 (:2262). (c) Acknowledge *someone else's*
                published appraisal by id → 404, because employee_id is in the WHERE.
    Known gap   **The increment does not reach pay.** `increment_percent` and
                `increment_paise` are written on the appraisal (migrations/00054:403-404)
                and read by nothing: no handler creates or amends a `salary_structure`
                from an appraisal outcome — and per ST-14, nothing creates one at all. The
                chain "outcome → increment → next year's salary" is cut at the last link.

### ST-30 — Training hours are logged and counted against the requirement

    Roles       HR → Faculty
    Features    hr.hiring_growth.staff_training_workshop_logs
    Endpoints   POST /api/v1/hr-growth/training/programmes    hr_growth.go:117 → :2350
                POST /api/v1/hr-growth/training/records       hr_growth.go:119 → :2509
                PUT  /api/v1/hr-growth/training/requirements  hr_growth.go:121 → :2614
                GET  /api/v1/hr-growth/training/compliance    hr_growth.go:122 → :2675
                GET  /api/v1/hr-growth/me/training            hr_growth.go:67 → :2751
                Screen: web/src/features/hr/Training.tsx (growth-keys.ts:24)
    Setup       A requirement of 20 hours a year for the teaching category; two
                programmes, one with counts_towards_requirement true and one false.
    Steps       1. HR nominates five teachers onto both programmes.
                2. HR marks four of them completed with hours logged.
                3. HR GETs /training/compliance.
                4. A teacher GETs /me/training.
    Expected    Step 3 counts only hours from programmes that count towards the
                requirement, per employee, against the 20; the shortfall is named. The
                list is narrowed by growthReach (hr_growth.go:2682) — a HOD sees their
                department's compliance and not the school's. Step 4 returns the caller's
                own record on `self.profile.read` alone.
    Negative    A teacher calling /training/compliance → 403 (the HR group requires
                EmployeesRead). A teacher calling /me/training → 200 with only their rows.

---

## F. Confidentiality — the sharpest thing in this cluster

### ST-31 — A HOD holding `employees.read` is narrowed on every personal register

    Roles       HOD
    Features    hr.verification.staff_criminal_background_verification,
                hr.verification.medical_fitness_certificate_registry,
                hr.onboarding_exit.*, hr.records.*, hr.leave.late_arrival_loss_of_pay_lop
    Endpoints   Every narrowed read, each calling lifecycleReach (hr_lifecycle.go:126) and
                narrow() (:144), which delegate to growthReach/employeeFilter
                (hr_growth.go:164, :197):
                  GET /hr/background-checks   hr_lifecycle.go:1662
                  GET /hr/medical-fitness     hr_lifecycle.go:1548
                  GET /hr/onboarding          hr_lifecycle.go:240
                  GET /hr/exits               hr_lifecycle.go:445
                  GET /hr/service-book        hr_lifecycle.go:1277
                  GET /hr/qualifications      hr_lifecycle.go:1421
                  GET /hr/transfers           hr_lifecycle.go:1065
                  GET /hr/lop                 hr_lifecycle.go:2410
                  GET /hr/documents           role_backoffice.go:534
    Setup       ST-08's shape: two departments, four people, a HOD heading D1 only. Seed a
                background verification, a medical fitness certificate, an exit, a service
                book entry, a qualification, a transfer, a document and a month of LOP for
                one person in **each** department.
    Steps       1. HOD GETs each of the nine endpoints in turn.
                2. HR (employees.write) GETs the same nine.
                3. A vice principal (employees.read, heads no department) GETs the same nine.
    Expected    Step 1: **D1's rows plus the HOD's own row, and nothing from D2** — in
                particular, the D2 employee's police-verification findings and their
                medical restrictions must not appear. Step 2: every row in the institution,
                because holding `hr.employees.write` is what growthReach calls the back
                office (hr_growth.go:170). Step 3: the vice principal's **own row only** —
                heading nothing means no rows, never all rows.
    Negative    Add `?employee_id=<a D2 employee>` to each of the nine. The parameter is
                ANDed with the reach predicate, never instead of it, so the result is an
                empty list — not that employee's file. This is the id-guessing attack and
                it must return nothing.
    Known gap   **Correction to the brief.** The stated defect — "`hr_lifecycle.go` never
                calls `resolveScope`, zero calls across 35 handlers" — describes an
                earlier state of this file and is **no longer true**. Every personal
                register above now resolves growthReach (which itself calls resolveScope
                at hr_growth.go:167) and splices `narrow()` into its WHERE. Run this test
                as a **regression test**: it is the one that must not go green-to-red.
                Two residues of the old state remain and should be reported:
                  • the stale comment at **internal/api/classroom.go:60** still asserts
                    "hr_lifecycle.go, which never calls resolveScope at all";
                  • the same claim survives in the file's own header at
                    **hr_growth.go:31-33**.
                Both will mislead the next reader into re-fixing a fixed thing, or worse,
                into believing the fix is still needed elsewhere.

### ST-32 — Another department's exit reads as "no such exit", not "no clearances"

    Roles       HOD
    Features    hr.onboarding_exit.staff_exit_interview_management
    Endpoints   GET /api/v1/hr/exits/{id}/clearances  hr_lifecycle.go:45 → :628
                exitInReach                            hr_lifecycle.go:155
    Setup       An exit raised for an employee in D2; the HOD heads D1.
    Steps       1. HOD GETs /hr/exits and notes the id is absent.
                2. HOD GETs /hr/exits/{that id}/clearances directly.
    Expected    Step 2 → **404**. The reach question is asked *before* the clearance list
                rather than folded into it (comment at hr_lifecycle.go:150), so the answer
                is "no such exit" rather than "no clearances raised" — the second sentence
                is untrue, and it tells the asker the id was worth trying.
    Negative    The same id fetched by HR → 200 with the full clearance list. Two callers,
                same URL, and the difference is 404 versus 200 — never 403.

### ST-33 — A colleague's appraisal by id is 404, not 403

    Roles       Faculty, then HOD
    Features    hr.hiring_growth.annual_performance_appraisal_kpi
    Endpoints   GET /api/v1/hr-growth/me/appraisals/{id}      hr_growth.go:64 → :2224
                GET /api/v1/hr-growth/appraisal/records/{id}  hr_growth.go:105 → :1692
                renderAppraisal                               hr_growth.go:1711, the 404 at :1774
                appraisalFilter                               hr_growth.go:221
    Setup       Published appraisals for teacher T1 (department D1) and teacher T2 (D2).
                A HOD heading D1. A reviewer who heads nothing but is named on three
                appraisals.
    Steps       1. T1 GETs /me/appraisals/{T2's id}.
                2. HOD(D1) GETs /appraisal/records/{T2's id}.
                3. HOD(D1) GETs /appraisal/records/{T1's id}.
                4. The department-less reviewer GETs one of their three reviewees'.
                5. The same reviewer GETs a fourth appraisal they were not named on.
    Expected    Steps 1, 2, 5 → **404**, with no body distinguishing "does not exist" from
                "not yours". The comment at hr_growth.go:1712 states the reason explicitly:
                *403 would confirm the record exists.* Steps 3 and 4 → 200 with the full
                detail and per-KPI ratings — step 4 because appraisalFilter adds
                "you were named to conduct it" on top of employeeFilter (hr_growth.go:221-236), so a
                reviewer who heads no department can still open their six.
    Negative    Assert the two failure modes are byte-identical: same status, same body,
                same headers apart from request id. A response that differs in length
                between "exists but not yours" and "does not exist" is the same leak by
                another route.
    Note        This is the pairing the brief asks to be tested explicitly. Read it beside
                ST-28: **404 on a read of a record you may not see; 403 on a write verb
                you reached legitimately but are not the named person for.** The
                distinction is intentional and both halves must hold.

### ST-34 — Grievances never widen to the department

    Roles       Faculty (raises) → HOD (must not see) → HR (decides)
    Features    hr.welfare.staff_grievance_cell
    Endpoints   GET  /api/v1/hr/grievances          hr_lifecycle.go:72 → :1934
                POST /api/v1/hr/grievances          hr_lifecycle.go:73 → :1988
                POST /api/v1/hr/grievances/{id}/decide  hr_lifecycle.go:74 → :2054
                grievanceFilter                     hr_lifecycle.go:191
                Screen: web/src/features/hr/Welfare.tsx (lifecycle-keys.ts:31)
    Setup       Teacher T1 in D1 raises a grievance **about their HOD**. A second grievance
                in D1 is assigned to that HOD to handle. A third is anonymous
                (no employee_id).
    Steps       1. HOD(D1) GETs /hr/grievances.
                2. T1 GETs /hr/grievances (T1 holds no hr.* grant — expect 403; then
                   repeat as a caller who holds employees.read).
                3. HR GETs /hr/grievances.
    Expected    Step 1 returns **only** the one assigned to them to handle — **not** the
                one raised about them, even though the complainant is in their department.
                grievanceFilter deliberately omits the departmental widening
                (hr_lifecycle.go:191-206): "a grievance mechanism whose complaints reach
                the person complained of is not a mechanism". Step 3 returns all three.
                The anonymous one carries no employee_id and so reaches neither the
                complainant nor a HOD — only the back office.
    Negative    Assert grievanceFilter is used and `narrow()` is **not**, on both the list
                and any future grievance endpoint. Two boundaries over one subject drift
                apart; this is the one place where the narrower rule must win.

### ST-35 — The school-wide registers are deliberately NOT narrowed

    Roles       Faculty, HOD, HR
    Features    hr.welfare.staff_birthday_anniversary_alerts, hr.welfare.staff_recognition_wall,
                hr.onboarding_exit.teacher_transfer_deputation (seniority),
                hr.leave.leave_policy_configuration, hr.records.employee_master
    Endpoints   GET /hr/seniority              hr_lifecycle.go:54 → :1225
                GET /hr/celebrations           hr_lifecycle.go:69 → :1817
                GET /hr/recognitions           hr_lifecycle.go:76 → :2120
                GET /hr/clearance-departments  hr_lifecycle.go:49 → :731
                GET /hr/leave-policy           hr_lifecycle.go:79 → :2257
                GET /hr/employees              api.go:361 → role_backoffice.go:301
                GET /hr/dashboard              api.go:360 → role_backoffice.go:262
                GET /hr-growth/roster          hr_growth.go:127 → :2958
    Setup       As ST-31.
    Steps       1. HOD GETs each of the eight.
    Expected    All eight return the **whole institution**, and that is correct, stated
                in the code (hr_lifecycle.go:88-99 and role_backoffice.go:541-545):
                a seniority list ordered within one department is not a seniority list —
                the single order is the whole point of it, and transfer counselling is run
                from it. A birthday only one department may see is not much of a birthday.
                The employee directory is name, department, designation and extension —
                what a directory is for. The dashboard returns counts, not anybody's
                record. The roster must be school-wide for a swap to be arrangeable.
    Negative    This test exists to stop an over-correction. If a later change narrows
                any of these eight, this test fails and the change is wrong. Pair it with
                ST-31: nine narrowed, eight open, and the line between them is
                "is this personal to one employee".

### ST-36 — Leave is readable in full by anyone holding `employees.read`

    Roles       HOD / Vice Principal
    Features    hr.leave.leave, hr.hr_workspace.staff_leave_application_management
    Endpoints   GET /api/v1/hr/leave  api.go:355 → role_backoffice.go:353;
                the predicate at **role_backoffice.go:356-358**
                ("mine := TRUE; if !id.Can(EmployeesRead) { mine = e.user_id = $2 }")
    Setup       Staff leave requests from both departments, with reasons naming medical
                and family circumstances.
    Steps       1. HOD (D1, employees.read, no employees.write) GETs /hr/leave.
                2. A vice principal who heads no department GETs /hr/leave.
                3. A teacher (no hr.* grant) GETs /hr/leave.
    Expected    Steps 1 and 2 → **every staff leave request in the institution, including
                the reason text**, for departments they do not head and people they do not
                manage. Step 3 → only their own.
    Negative    Compare with ST-31: the same caller is narrowed to their own department on
                LOP, medical fitness and background checks, and is not narrowed at all on
                leave — which carries the reason a person was away. Two boundaries over
                one subject, and this one is the loose one.
    Known gap   **Not previously reported.** `listLeaveRequests` predates growthReach and
                was never brought onto it. The fix is the same one-liner the lifecycle
                registers took: resolve growthReach and splice `narrow(re, "e", …)` in
                place of `mine = TRUE`. Related: `hod` also holds `hr.leave.approve`
                (rbac.go:312), and `decideLeave`'s guard is `$5 OR (class-teacher check)`
                where `$5 = id.Can(LeaveApprove)` (mod_workflow.go:174) — so a HOD can
                **approve** any employee's leave school-wide, not only their department's.

---

## G. Exit

### ST-37 — A resignation raises the clearance checklist with it

    Roles       Faculty (resigns) → HR
    Features    hr.onboarding_exit.teacher_relieving_no_deduction_clearance
    Endpoints   POST /api/v1/hr/exits                   hr_lifecycle.go:41 → :505
                GET  /api/v1/hr/exits/{id}/clearances   hr_lifecycle.go:45 → :628
                POST /api/v1/hr/exits/{id}/interview    hr_lifecycle.go:43 → :566
                GET  /api/v1/hr/clearance-departments   hr_lifecycle.go:49 → :731
                Screen: web/src/features/hr/Lifecycle.tsx
    Setup       An active employee; the clearance department master seeded.
    Steps       1. HR POSTs an exit with kind "resignation", notice_on, requested_last_day.
                2. HR GETs the clearances for it, without asking for them to be created.
                3. HR records the exit interview with primary_reason, would_rejoin and
                   the four ratings.
    Expected    Step 1 → 201. Step 2 → the **full checklist already exists**, one row per
                active clearance department, raised in the same transaction as the exit
                (comment at hr_lifecycle.go:495-504) — a list created on demand is a list
                created after the settlement was paid. Step 3 → 200; ratings outside 1–5
                are refused by the CHECK (migrations/00031:126).
    Negative    Raising a second exit for an employee who already has an open one → the
                schema should refuse it; assert the response is a 409, not a duplicate
                file.

### ST-38 — Relieving is refused until every department has signed

    Roles       Librarian / Finance / IT (sign) → HR (relieves)
    Features    hr.onboarding_exit.teacher_relieving_no_deduction_clearance,
                hr.onboarding_exit.staff_experience_relieving_cards
    Endpoints   POST /api/v1/hr/exits/{id}/clearances  hr_lifecycle.go:44 → :672
                POST /api/v1/hr/exits/{id}/relieve     hr_lifecycle.go:46 → :767
    Setup       ST-37's exit, with (say) five clearance departments.
    Steps       1. HR POSTs relieve straight away.
                2. Sign four departments "cleared"; sign the library "dues" with
                   dues_paise 250000 and remarks.
                3. HR POSTs relieve again.
                4. Sign the library "cleared".
                5. HR POSTs relieve.
    Expected    Steps 1 and 3 → **409 "clearance_outstanding"**: "a department has not
                signed yet; the relieving letter cannot be issued until every one has"
                (hr_lifecycle.go:839-840). Note step 1 is refused because `raised == 0 ||
                outstanding > 0` — an exit with no list at all is refused too, not waved
                through. Step 4: the exit's own status flips to 'cleared' **by itself**
                the moment the last department signs (hr_lifecycle.go:709-712), and flips back
                if a department is re-opened. Step 5 → 200.
    Negative    Sign a department with status "signed" → 400 "status must be pending, dues
                or cleared". Sign against a department code that does not exist on this
                exit → 404.

### ST-39 — Relieving issues both letters from one snapshot and closes the employment

    Roles       HR → Faculty (who takes the letters to their next school)
    Features    hr.onboarding_exit.staff_experience_relieving_cards,
                hr.records.staff_service_book_digitalization
    Endpoints   POST /api/v1/hr/exits/{id}/relieve      hr_lifecycle.go:767
                issueStaffCertificate                   hr_lifecycle.go:937
                GET  /api/v1/hr/service-certificates    hr_lifecycle.go:50 → :1014
                GET  /api/v1/hr/service-book            hr_lifecycle.go:56 → :1277
    Setup       ST-38 step 5.
    Steps       1. Read the relieve response.
                2. GET /hr/service-certificates for the employee.
                3. GET /hr/employees and find the row.
                4. GET /hr/service-book for the employee.
                5. Run payroll for the following month.
    Expected    Step 1 → {"relieved": true, "certificates": {"relieving": <serial>,
                "experience": <serial>}} — both generated together and from **one**
                snapshot, because they are read together by the next school and a pair
                that disagree on a date is worse than neither (comment at hr_lifecycle.go:759-766).
                They reuse `issued_certificates`, so there is one serial series, not two.
                Step 3: employment status is 'resigned' / 'retired' / 'terminated'
                according to the exit kind (hr_lifecycle.go:808-815) — leaving it 'active'
                would keep the leaver in every headcount, payroll run and published
                timetable. Step 4: a 'relieving' service-book entry, attested. Step 5:
                the leaver produces **no payslip** (runPayroll filters e.status='active',
                mod_ops.go:610).
    Negative    Re-POST relieve on an already relieved exit → assert it does not issue a
                second pair of certificates on a second serial.

### ST-40 — The settlement nets the dues, and the database refuses to outrun the clearance

    Roles       HR → Finance
    Features    hr.onboarding_exit.teacher_relieving_no_deduction_clearance
    Endpoints   POST /api/v1/hr/exits/{id}/settle  hr_lifecycle.go:47 → :867
                trigger hr_settlement_needs_clearance  migrations/00031_hr_lifecycle.sql:212
    Setup       An exit whose library clearance recorded dues_paise 250000, then cleared.
    Steps       1. HR POSTs settle with settlement_paise 4500000.
                2. On a *different* exit with one department still outstanding, POST settle.
                3. On an exit with **no** clearance list at all (created by direct SQL),
                   POST settle.
    Expected    Step 1 → 200 {"settlement_paise":4500000, "recovery_paise":250000,
                "net_paise":4250000}; recovery is summed from the clearances, and net is
                floored at 0 rather than going negative (hr_lifecycle.go:891). The exit's
                status becomes 'settled'. Step 2 → **409 "clearance_outstanding"** raised
                by the *database* trigger, whose message names how many departments are
                still waiting (migrations/00031:230). Step 3 → 409 "settlement blocked:
                no departmental clearance was raised for this exit" (:226).
    Negative    A negative settlement_paise → 400 "a settlement cannot be negative".
                The important assertion is that steps 2 and 3 are refused by the schema,
                not by the handler — repeat step 2 as a raw UPDATE in psql and confirm it
                is refused there too. A rule enforced only in the handler is silent for
                every import and every psql session.
    Note        Contrast with student exits: 03_monthly_term.md records that TC issuance
                has **no** dues gate and `exit_clearances` keys on `staff_exits` only.
                Staff exits are the model; students have none of this.

---

## Chains that could not be tested, because the endpoint does not exist

1. **Salary structure creation.** No writer for `salary_structures`,
   `salary_structure_items` or `salary_components` anywhere in the repo. Catalogued
   `built` (`hr.payroll.salary_structure_builder`, ROLES_AND_FEATURES.csv:153;
   implemented_gen.go:154; registry.ts:205). Every payroll test from ST-15 onward needs a
   hand-seeded row. This is the first thing to fix in this cluster.
2. **Locking a payroll run.** No endpoint, job or migration sets `payroll_runs.status`
   to 'locked' or 'paid'; the only write is mod_ops.go:812 setting 'processed'. The
   `errPayrollLocked` path (ST-19) is unreachable and cannot be tested into existence.
3. **TDS on the payslip, and Form 16.** `computeStatutory` has no tax component and no
   handler emits Form 16 or Form 24Q, despite `hr.statutory.income_tax_form_16_generator`
   being `built` (ST-17).
4. **ESI return, PT challan.** Only the EPFO ECR file exists (payroll_statutory.go:411).
5. **The appraisal increment reaching pay.** `appraisals.increment_percent` /
   `increment_paise` are written and read by nothing (ST-29); there is no path from an
   outcome to next year's salary.
6. **Invigilation tied to an exam, paper or hall.** `duty_assignments` carries no exam
   dimension, and the per-paper datesheet it would roster against is itself unwritable
   (ST-24).
7. **A teacher's own payslip.** No self-service payslip route; no PDF, no
   password-protected dispatch, no publish-to-portal (ST-20).
8. **Overtime.** `hr.payroll.overtime_ot_rate_setup` is catalogued `built`
   (ROLES_AND_FEATURES.csv:149) and mapped to the Statutory screen; no OT hours are
   captured anywhere and `runPayroll` computes no OT line.
9. **Staff ID card printing.** `hr.records.staff_id_card_printing` is catalogued `built`
   and mapped to `hr/Employees.tsx`; no render or export handler was found.
10. **A month-end close over payroll.** The only close in the product is the annual
    accounting year (ledgers.go:1392); nothing marks a month done, so every past
    payslip stays mutable (00_TIMELINE.md, OCT).
