# Acceptance tests — the academic chain (Faculty ↔ Student ↔ Parent)

Scope: the eight relationships in which a teacher's work becomes something a child
or a family can see — homework, the attendance register and its correction, marks
through to a published report card, the timetable and the substitution that
changes it, study material and the live class, the homework forum and the student
wall, the parent-teacher meeting, and the conduct file. Every test below is
grounded in a route that exists in `internal/api/` and, where the SPA is the way a
tester will drive it, in a screen under `web/src/features/`. All API paths are
relative to `/api/v1` (`internal/api/api.go:1`). Tests are in dependency order: a
test needing a published timetable comes after the one that publishes it, and a
test needing a published report card comes after the generate step. Where
`docs/gap_analysis/00_TIMELINE.md` or `03_monthly_term.md` records that the chain
is already cut, the test says so and states what failing looks like today, so a
tester confirming a fix knows what changed.

**The negative half is the point.** This product has a scope resolver
(`internal/scope/scope.go`) that is genuinely good and a small number of places
where it is bypassed or defaulted. The sibling case, the wrong-class case and the
before-publication case are written first-class in every test below.

## Standing fixtures

Referenced by name throughout. Build these once.

| Name | What it is |
|---|---|
| `SEC-6A`, `SEC-6B` | Two sections of the same class. |
| `T-MATHS` | Faculty role. Timetabled into `SEC-6A` Maths only. |
| `T-SCI` | Faculty role. Timetabled into `SEC-6B` Science only. Teaches nothing in 6A. |
| `T-CLASS6A` | Class teacher role, `sections.class_teacher_id` = this user on `SEC-6A`. |
| `EXAMCTL` | `exam_controller` role — holds `StudentsReadAll`, `AttendanceReadAll`, `ExamsWrite`, `MarksWrite`, `ReportCardsGenerate` (`internal/rbac/rbac.go:338`). |
| `PRINCIPAL` | Holds `ReportsRead`, `AttendanceWriteAny`. |
| `S-ANIL` | Student in `SEC-6A`, has `students.user_id` (a portal login). |
| `S-BINA` | Student in `SEC-6B`. Sibling of `S-ANIL`. |
| `S-CHAN` | Student in `SEC-6A`, unrelated family. |
| `P-SHARMA` | Guardian linked via `student_guardians` to **both** `S-ANIL` and `S-BINA`, with `guardians.user_id` set. |
| `P-OTHER` | Guardian of `S-CHAN` only. |

**Prerequisite that is itself a known gap.** `guardians.user_id` is written only by
`cmd/migrate/demo.go`; neither the admissions handoff nor student creation sets it,
and there is no invitation flow (`docs/gap_analysis/00_TIMELINE.md:74-81`). Every
parent-side test below therefore requires the tester to seed `guardians.user_id`
by hand or run against demo data. If a fix has landed, AC-00 is the test.

---

## AC-00 — A guardian created through a production path can log in

**Roles** Admissions clerk → Parent
**Features** `admissions.admissions.enrollment_handoff`, `parent.academics.homework_academics`
**Endpoints**
- `POST /admissions/applications/{id}/enrol` — `internal/api/api.go:404`
- `POST /students` — `internal/api/api.go:85`
- `GET /portal/students` → `listMyStudents`, `internal/api/role_scoped.go:218`

**Setup** An application with a guardian's name, relation and phone recorded.
**Steps**
1. Clerk enrols the applicant.
2. Tester queries `guardians` for the new row.
3. Guardian attempts to sign in with whatever credential the flow issued.

**Expected** `guardians.user_id` is non-NULL, a `users` row exists for the guardian,
and signing in returns a session whose `GET /portal/students` lists exactly the
enrolled child.
**Negative** The guardian must not be able to sign in with a credential shared
across families, and `GET /portal/students` must not return a second family's child.
**Known gap** `00_TIMELINE.md:74` — "No parent can log in." Both production paths
insert a guardian without `user_id`. **This test fails today at step 2.** Every
`P-SHARMA` / `P-OTHER` test below is therefore currently only executable against
hand-seeded data.

---

## Timetable — publish before anything reads it

## AC-01 — Admin publishes a draft timetable and it becomes the live grid

**Roles** Admin (timetable) → Faculty → Student
**Features** `institution_admin.academics.master_timetable_generation`, `institution_admin.academics.timetable`
**Endpoints**
- `POST /timetable-optimizer/drafts` → `generateTimetableDraft`, mount `internal/api/timetable_ops.go:74`, route `:80`
- `POST /timetable-optimizer/drafts/{id}/publish` → `publishTimetableDraft`, `internal/api/timetable_ops.go:931`
- `GET /timetable/entries` → `listTimetableEntries`, `internal/api/timetable.go:57`; route `internal/api/api.go:128-133`
- Screens `web/src/features/academics/TimetableOptimizer.tsx`, `web/src/features/shared/Timetable.tsx`

**Setup** Classes, sections, periods, `class_subjects`, teacher assignments for `SEC-6A` and `SEC-6B`. An existing (stale) set of `timetable_entries` for `SEC-6A`.
**Steps**
1. Admin generates a draft covering `SEC-6A` and `SEC-6B`.
2. Admin publishes it.
3. `T-MATHS` calls `GET /timetable/entries?teacher_id=me`.
4. `S-ANIL` calls `GET /timetable/entries`.

**Expected** The publish response reports `replaced` equal to the count of stale
6A entries and `inserted` equal to the draft's entry count. Step 3 returns only
periods where `teacher_user_id` is `T-MATHS`. Step 4 returns only `SEC-6A` periods —
`TimetablePredicate` derives a family's sections from the enrolment
(`internal/scope/scope.go:191-202`).
**Negative**
- `S-ANIL` must not see any `SEC-6B` row.
- Publishing a draft already `published` must return the `errDraftNotOpen` refusal, not silently re-insert (`timetable_ops.go:954`).
- Publishing a draft with `blocking_issues > 0` and no `acknowledged: true` must be refused (`timetable_ops.go:957`).
- A draft that collides with a grid edited since must return the `errGridMoved` error rather than dropping the offending periods (`timetable_ops.go:1002`).

## AC-02 — A parent cannot open the timetable endpoint at all

**Roles** Parent
**Features** `student.timetable.timetable`, `parent.dashboard.child_summary`
**Endpoints**
- `GET /timetable/entries` — group gated on `rbac.TimetableRead`, `internal/api/api.go:128-129`
- `GET /portal/summary` → `getPortalSummary`, `internal/api/role_scoped.go:281`; route `internal/api/api.go:269`
- Role grants: `student` holds `TimetableRead`, `parent` does **not** (`internal/rbac/rbac.go:375-378`)

**Setup** AC-01 complete.
**Steps**
1. `P-SHARMA` calls `GET /timetable/entries`.
2. `P-SHARMA` calls `GET /portal/summary?student_id=<S-ANIL>`.

**Expected** Step 1 returns 403. Step 2 returns `today[]` — today's periods for
`S-ANIL`'s section, with subject, teacher and room (`role_scoped.go:376-384`).
**Negative** Step 2 with `student_id=<S-CHAN>` must return 404, not a filtered
empty list — the id is validated against the caller's resolved set
(`role_scoped.go:283-292`).

## AC-03 — The child switcher is required, not optional, on family reads

**Roles** Parent (two children)
**Features** `parent.dashboard.child_switcher`
**Endpoints**
- `whichChild`, `internal/api/portal_family.go:33-56` — defaults to `res.StudentIDs[0]`
- `portalChild`, `internal/api/portal_requests.go:113-135` — refuses when >1 child and none named
- `myClassroom`, `internal/api/student_learning.go:174` (calls `whichChild`)

**Setup** `P-SHARMA` with `S-ANIL` (6A) and `S-BINA` (6B).
**Steps**
1. `P-SHARMA` calls `GET /portal/results` with **no** `student_id`.
2. `P-SHARMA` calls `GET /portal/learning/resources` with no `student_id`.
3. `P-SHARMA` calls `POST /portal/school-life/ptm/book` with no `student_id`.

**Expected** Steps 1 and 2 must either name which child the answer is for in the
response body, or refuse. Step 3 must refuse (404 via `denyChild`) — a write
against a guessed sibling is what `portalChild` exists to prevent
(`portal_requests.go:119-125`).
**Negative** Steps 1 and 2 must not silently answer for `S-ANIL` merely because
they sort first. **This is the failure today**: `whichChild` returns
`res.StudentIDs[0]` (`portal_family.go:45`), so a parent of two opening Resources
or the Wall sees one child's classroom with nothing saying which. The response of
`getFamilyResults` does carry `student_id` (`portal_family.go:268`); the resource,
wall, diary, forum and live-class lists do not. Fail this test if any of those
returns another child's section content with no identification.

---

## Homework

## AC-04 — Faculty sets homework for a section they teach; the student sees it with a due date

**Roles** Faculty → Student → Parent
**Features** `faculty.teaching.homework_classwork`, `student.homework.homework_assignments`, `parent.academics.homework_academics`
**Endpoints**
- `POST /homework` → `publishHomework`, `internal/api/mod_workflow.go:589`; route `internal/api/api.go:168`
- `GET /homework` → `listHomework`, `internal/api/mod_workflow.go:690`; route `internal/api/api.go:167`
- `GET /portal/diary` → `getStudentDiary`, `internal/api/student_life.go:972`
- Screen: all three catalogue keys resolve to `web/src/features/workflow/Homework.tsx` (`web/src/features/registry.ts:77-79`)

**Setup** AC-01. `T-MATHS` timetabled into `SEC-6A` Maths.
**Steps**
1. `T-MATHS` posts `{section_id: SEC-6A, subject_id: MATHS, title: "Ex 4.2", due_on: <tomorrow>, allow_submission: true}`.
2. `S-ANIL` calls `GET /homework`.
3. `P-SHARMA` calls `GET /homework`.
4. `S-ANIL` calls `GET /portal/diary`.

**Expected** 201 at step 1 with an id. Steps 2 and 3 return the task with
`due_on` set, `overdue: false`, `submitted: false`, `teacher` naming `T-MATHS`,
and `strength` equal to the active enrolment count of `SEC-6A`. Step 4 shows the
same task on the diary against its due date.
**Negative**
- Posting with `subject_id` for a subject not on `SEC-6A`'s `class_subjects` must return 400 "that subject is not on this class's timetable" (`mod_workflow.go:653`), not create an orphan row.
- `S-BINA` (6B) calling `GET /homework` must not see this task — the family branch keys on the child's own active enrolment (`mod_workflow.go:697-700`).

## AC-05 — A teacher cannot set homework for a class they do not teach

**Roles** Faculty (wrong class)
**Features** `faculty.teaching.homework_classwork`
**Endpoints** `POST /homework` → `publishHomework`, scope check at `internal/api/mod_workflow.go:614-617` (`res.CanMarkSection`, `internal/scope/scope.go:346`)

**Setup** `T-SCI` teaches only `SEC-6B`.
**Steps**
1. `T-SCI` posts homework naming `section_id: SEC-6A`.

**Expected** 403 "homework for this section". No `homework` row is created.
**Negative** The refusal must come from the scope resolver, not from the SPA. Drive
this with a raw HTTP call, not the screen. `T-SCI` holds `HomeworkWrite`
(`internal/rbac/rbac.go:325-328`), so the route permission alone would let this
through — the handler check is the whole defence.

## AC-06 — Student turns in homework; the teacher sees the submission and who is missing

**Roles** Student → Faculty
**Features** `student.homework.homework_assignments`, `faculty.teaching.assignments_submissions`
**Endpoints**
- `POST /homework/{id}/submit` → `submitHomework`, `internal/api/mod_workflow.go:781`; route `internal/api/api.go:169`
- `GET /homework/{id}/submissions` → `listHomeworkSubmissions`, `internal/api/mod_workflow.go:886`; route `internal/api/api.go:173`
- `GET /teaching/my-work` → `getMyWork`, `internal/api/faculty_work.go:45`

**Setup** AC-04. `SEC-6A` has 32 active enrolments.
**Steps**
1. `S-ANIL` submits with a `text_answer`.
2. `T-MATHS` calls `GET /homework/{id}/submissions`.
3. `S-ANIL` submits again with different text.
4. `T-MATHS` re-reads the register.
5. `T-MATHS` checks their in-app notifications.

**Expected** Step 2 returns **32 rows** in roll order — every enrolled child, with
`status: "pending"` for the 31 who have not turned in. This is the LEFT JOIN from
`enrollments`, and a query returning only submitters is a fail
(`mod_workflow.go:919-931`). Step 4 shows one row for `S-ANIL` with the second
answer and an updated `submitted_at` — the upsert is keyed
`(homework_id, student_id)` (`mod_workflow.go:809`). Step 5 shows exactly **one**
`homework_submitted` notification after two submissions; `notify` is keyed on the
homework id, not the submission (`mod_workflow.go:850-852`).
**Negative**
- `P-SHARMA` calling `GET /homework/{id}/submissions` must get **403**, not a filtered list — there is no family version of the class register (`mod_workflow.go:906-909`).
- `T-SCI` calling it must get 403 for the same reason.
- `S-ANIL` posting `{student_id: <S-CHAN>}` to `/submit` must get 404 — `OwnsStudent` guards it (`mod_workflow.go:800-806`).

## AC-07 — A guardian of two children cannot submit for the sibling who was not named

**Roles** Parent
**Features** `parent.academics.homework_academics`
**Endpoints** `POST /homework/{id}/submit`, target selection at `internal/api/mod_workflow.go:796-807`

**Setup** `P-SHARMA` guardian of `S-ANIL` (6A) and `S-BINA` (6B). A homework set for `SEC-6A`.
**Steps**
1. `P-SHARMA` submits the 6A homework with **no** `student_id`.
2. `P-SHARMA` submits it with `student_id: <S-BINA>`.
3. `P-SHARMA` submits it with `student_id: <S-CHAN>`.

**Expected** Step 3 returns 404. Step 1 must either refuse or record against the
child actually enrolled in the homework's section.
**Negative** Step 1 must not silently write a submission for whichever child
`res.StudentIDs` happens to list first. **This is a live defect**: `submitHomework`
sets `target := res.StudentIDs[0]` when `student_id` is omitted
(`mod_workflow.go:799`), with no check that the child is in the homework's section.
Step 2 likewise creates a `homework_submissions` row for a 6B child against a 6A
task, which then appears nowhere on any register. Both are fails.

## AC-08 — Withdrawn homework disappears from the family view

**Roles** Faculty → Student
**Features** `faculty.teaching.homework_classwork`
**Endpoints** `GET /homework` — the list is gated on `h.is_published` (`internal/api/mod_workflow.go:751`)

**Setup** A homework row with `is_published = false` (set directly; see gap below).
**Steps**
1. `S-ANIL` calls `GET /homework`.

**Expected** The unpublished task is absent.
**Known gap** `publishHomework` hard-codes `is_published = true` on insert
(`mod_workflow.go:649`) and there is no update or withdraw handler for homework.
A task set by mistake cannot be pulled back through the API. Record this as a
missing endpoint, not a failing assertion.

---

## Attendance

## AC-09 — Faculty marks the register; the student and the parent see the same day

**Roles** Faculty → Student → Parent
**Features** `faculty.attendance.take_attendance`, `student.attendance.attendance`, `parent.attendance.attendance`
**Endpoints**
- `POST /attendance` → `markAttendance`, `internal/api/attendance.go:81`; route `internal/api/api.go:137`
- `GET /attendance?on_date=&section_id=` → `listAttendance`, `internal/api/attendance.go:25`; route `internal/api/api.go:136`
- `GET /portal/attendance` → `listPortalAttendance`, `internal/api/role_scoped.go:416`; route `internal/api/api.go:270`
- Screens `web/src/features/shared/Attendance.tsx` (`registry.ts:124`), `web/src/features/portal/Portal.tsx` (`registry.ts:141,146`)

**Setup** AC-01. `T-CLASS6A` is class teacher of `SEC-6A`.
**Steps**
1. `T-CLASS6A` posts a full-section register for today: `S-ANIL` absent, the rest present.
2. `T-CLASS6A` re-reads `GET /attendance?section_id=SEC-6A`.
3. `S-ANIL` calls `GET /portal/attendance`.
4. `P-SHARMA` calls `GET /portal/attendance?student_id=<S-ANIL>`.

**Expected** Step 1 returns `submitted` equal to the entry count and `written`
equal to the number of rows actually changed. Steps 3 and 4 show today with
`status: "absent"`.
**Negative**
- An entry with `status: "sick"` must be refused with 400 before any write, and the whole batch must be rejected — the status set is validated against the check constraint up front (`attendance.go:105-114`).
- Re-posting the identical register must return `written: 0`; the upsert only updates `WHERE status IS DISTINCT FROM EXCLUDED.status` (`attendance.go:150`).
- `P-SHARMA` calling with `student_id=<S-CHAN>` must return 404 (`role_scoped.go:429-436`).
- `P-OTHER` calling with `student_id=<S-ANIL>` must return 404.

## AC-10 — A teacher cannot mark a register for a section they do not teach

**Roles** Faculty (wrong class)
**Features** `faculty.attendance.take_attendance`
**Endpoints** `POST /attendance`, scope check `internal/api/attendance.go:117-123`

**Steps**
1. `T-SCI` posts a register for `SEC-6A`.
2. `PRINCIPAL` (holds `AttendanceWriteAny`) posts a register for `SEC-6A`.

**Expected** Step 1: 403 "academics.attendance.write for this section". Step 2:
succeeds — `AnySection` is the deliberate override (`internal/scope/scope.go:347-352`).
**Negative** Step 1 must not create partial rows. The whole batch runs in one
transaction (`attendance.go:161`); check `student_attendance` for `SEC-6A` is
unchanged.

## AC-11 — A period-level mark and a day-level mark do not overwrite each other

**Roles** Faculty
**Features** `faculty.attendance.take_attendance`
**Endpoints** `POST /attendance` with and without `period_id`; two partial unique indexes and two `ON CONFLICT` targets, `internal/api/attendance.go:140-156`

**Steps**
1. `T-CLASS6A` posts a day register (no `period_id`) marking `S-ANIL` present.
2. `T-MATHS` posts a period register for period 3 marking `S-ANIL` absent.
3. Read `GET /attendance?on_date=<today>&student_id=<S-ANIL>`.

**Expected** Two rows: one with `period_id` NULL and status present, one with
period 3 and status absent. Neither call errors.
**Negative** A `no unique or exclusion constraint matching the ON CONFLICT
specification` 500 on either call is a fail — that is the exact failure the two
conflict clauses exist to avoid.

## AC-12 — The parent is alerted the same day, once, for a child absent all day

**Roles** Faculty → system (cron/manual run) → Parent
**Features** `faculty.attendance.absence_alert_to_guardian`, `parent.attendance.attendance`
**Endpoints**
- `POST /admin/messaging/plans/{id}/preview` → `previewReminderPlan`, `internal/api/message_rules.go:1386`; mount `internal/api/message_rules.go:974`, spliced at `internal/api/api.go:625`
- `POST /admin/messaging/plans/{id}/run` → `runReminderPlan`, `internal/api/message_rules.go:1427`
- Subject finder `absenceAlertSubjects`, `internal/api/message_rules.go:385`
- Legacy path `POST /attendance-workflow/absence-alerts` → `sendAbsenceAlerts`, `internal/api/mod_academics.go:184`; route `internal/api/api.go:417`

**Setup** `S-ANIL` marked absent in **eight** period rows today. An `absence_alert`
plan enabled, channel sms, audience guardians, `skip_explained: true`.
**Steps**
1. Admin previews the plan.
2. Admin runs it.
3. Admin runs it a second time within the same day.

**Expected** The preview names `S-ANIL` **once**, not eight times — subjects are
grouped `student_id, on_date` with `periods_absent` as a fact
(`message_rules.go:393-406`). One message queued at step 2. Step 3 queues
**zero** and reports the occurrence as `already sent`; the occurrence key is
`student:date` (`message_rules.go:427`) and prior sends are loaded from
`message_log` (`message_rules.go:752-760`).
**Negative**
- If `P-SHARMA` has already filed a leave/absence report covering today (`POST /portal/absence` → `reportChildAbsence`, `internal/api/portal_requests.go:273`), the preview must show `S-ANIL` skipped as *explained* (`message_rules.go:398-404,424`), and an already-queued message must be withdrawn by `cancelSettled` (`message_rules.go:515`).
- The preview must not report "14 guardians" where two guardians of one child share a collapsed occurrence key — the `Collapsed` count exists precisely to stop that over-promise (`message_rules.go:819-830`).
- The alert must name the right child. Run with `S-ANIL` absent and `S-BINA` present and confirm no message references `S-BINA`.

## AC-13 — The legacy absence-alert endpoint reaches nobody in a real tenant

**Roles** Faculty/office
**Features** `faculty.attendance.absence_alert_to_guardian`
**Endpoints** `POST /attendance-workflow/absence-alerts` → `sendAbsenceAlerts`, `internal/api/mod_academics.go:184`; recipient query at `:200-208`

**Setup** A tenant where guardians were created through `POST /students` or the
admissions handoff (i.e. `guardians.user_id IS NULL`).
**Steps**
1. Office calls the endpoint for today, with several children marked absent.

**Expected (after a fix)** `absent_students` > 0 **and** `messages_queued` equal to
the number of reachable guardians, with a stated count of unreachable ones.
**Negative / today's behaviour** The query filters `g.user_id IS NOT NULL`
(`mod_academics.go:208`), so it returns `absent_students: 0, messages_queued: 0`
and reports success. A 200 with two zeroes when eleven children are absent is the
fail condition.
**Known gap** `00_TIMELINE.md:74-82` — "circular fan-out resolves recipients with
`g.user_id IS NOT NULL` and silently reaches nobody."

## AC-14 — A teacher corrects a mistaken mark; the correction is audited and the family view updates

**Roles** Faculty → Approver → Parent
**Features** `faculty.attendance.attendance_correction`, `institution_admin.academics.attendance_corrections`
**Endpoints**
- `POST /attendance-workflow/corrections` → `requestCorrection`, `internal/api/mod_academics.go:32`; route `internal/api/api.go:409`
- `GET /attendance-workflow/corrections` → `listCorrections`, `internal/api/mod_academics.go:158`; route `internal/api/api.go:410`
- `POST /attendance-workflow/corrections/{id}/decide` → `decideCorrection`, `internal/api/mod_academics.go:97`; route `internal/api/api.go:416`, gated `AttendanceWriteAny`
- Screen `web/src/features/workflow/Corrections.tsx` (`registry.ts:396-397`)

**Setup** AC-09. `S-ANIL` is marked absent today but was in fact present.
**Steps**
1. `T-CLASS6A` requests a correction on that `attendance_id` to `present` with a reason.
2. `T-CLASS6A` attempts to decide their own request.
3. `PRINCIPAL` lists pending corrections and approves it.
4. `P-SHARMA` re-reads `GET /portal/attendance?student_id=<S-ANIL>`.
5. Tester inspects the `student_attendance` row.

**Expected** Step 1 returns 201 `pending`, with `from_status` captured from the
register, not from the request body (`mod_academics.go:57-62`). Step 2 returns
403 — `T-CLASS6A` does not hold `AttendanceWriteAny`. Step 3 flips the row. Step 4
shows `present`. Step 5 shows `corrected_from = 'absent'`, `corrected_by =
PRINCIPAL`, `corrected_at` set (`mod_academics.go:126-131`), and the
`attendance_corrections` row carries `decided_by` and `decided_at`.
**Negative**
- A correction request against a section the caller does not teach must return 403 (`mod_academics.go:53-55`), even though the route permission `AttendanceWrite` is held by every teacher.
- Deciding an already-decided correction must return 404 "no pending correction with that id" — the update is guarded `AND status = 'pending'` (`mod_academics.go:118`).
- A rejected correction must leave `student_attendance` untouched (`mod_academics.go:121-123`).
- Marking the register directly over the top (`POST /attendance` again) also writes `corrected_from`/`corrected_by` (`attendance.go:143-149`) but creates **no** `attendance_corrections` row. Confirm the corrections list does not claim to be the full audit trail: a tester must be able to tell a reviewed amendment from a silent re-mark.

## AC-15 — A withdrawn alert and the corrected register agree

**Roles** Faculty → system → Parent
**Features** `faculty.attendance.attendance_correction`, `faculty.attendance.absence_alert_to_guardian`
**Endpoints** AC-12 and AC-14 combined; `cancelSettled`, `internal/api/message_rules.go:447`

**Steps**
1. `S-ANIL` marked absent; the absence plan runs and queues a message.
2. Before the queue drains, the correction from AC-14 is approved to `present`.
3. The plan runs again.

**Expected** The queued message is withdrawn, not delivered, and the run reports
`withdrawn: 1`.
**Negative / risk to confirm** `cancelSettled`'s absence branch withdraws on the
family having *explained* the absence (`message_rules.go:515`), which is a
`leave_requests` row — not on the mark having been *corrected*. Verify explicitly
whether a corrected register withdraws the alert. If it does not, the school has
already texted a parent about an absence the school itself has since retracted.
Record the outcome; this is the assertion most likely to fail.

## AC-16 — The student's own record and the office's report agree on the same period

**Roles** Student → Principal
**Features** `student.attendance.attendance`, `institution_admin.standard.comprehensive_attendance_report`
**Endpoints**
- `GET /portal/attendance` → `listPortalAttendance`, `internal/api/role_scoped.go:416` — hard bound to the last **120 days**, `:441`
- `GET /principal/attendance-trend` → `getAttendanceTrend`, `internal/api/role_principal.go:104` — hard-wired to **30 days**
- `GET /principal/attendance-shortage` → `getAttendanceShortage`, `internal/api/role_principal.go:138`

**Steps**
1. `S-ANIL` reads their own attendance.
2. `PRINCIPAL` reads the shortage list.

**Expected** Both are labelled with the period they cover, and the shortage
percentage for `S-ANIL` is computed over the current academic year.
**Known gap** `03_monthly_term.md:54` — `getAttendanceShortage` aggregates **all
attendance ever recorded**, with no year or term bound, and the trend is fixed at
30 days while the portal shows 120. A student who changed school within the tenant,
or any second-year student, gets a percentage over their whole history. Fail this
test if the two screens report different denominators without saying so.

---

## Marks, report cards and publication

## AC-17 — Faculty enters marks; the grade is derived from the band table

**Roles** Faculty
**Features** `faculty.marks_report_cards.marks_entry`
**Endpoints**
- `GET /exams/gradebook?exam_subject_id=` → `getGradebook`, `internal/api/mod_academics.go:362`; route `internal/api/api.go:429`
- `POST /exams/marks` → `enterMarks`, `internal/api/mod_academics.go:261`; route `internal/api/api.go:432`
- Screen `web/src/features/exams/Gradebook.tsx` (`registry.ts:154`)

**Setup** An exam with a `grading_scale_id` and populated `grade_bands`; an
`exam_subjects` row for 6A Maths with `max_marks = 100`.
**Steps**
1. `T-MATHS` opens the gradebook for that paper.
2. `T-MATHS` posts marks for the whole roster, one child `is_absent: true`, one on 95.
3. `T-MATHS` posts a mark of 950 for one child.

**Expected** Step 1 returns the roster from `enrollments`, not from `marks` — a
child with no mark yet must appear (`mod_academics.go:371-376`). Step 2 stores a
`grade` derived server-side from the band table; a client-supplied grade is ignored
(`mod_academics.go:298-313`). Step 3 returns 400 "marks must be between zero and
the paper maximum" and **writes nothing at all** — the whole entry runs in one
transaction (`mod_academics.go:288,331`).
**Negative**
- After step 3, re-read the gradebook and confirm the marks from step 2 that preceded the bad row in the same request are absent. A partial write is a fail.
- The absent child must have `is_absent: true` and no derived grade (`mod_academics.go:299`).

## AC-18 — Marks are signed off, and an incomplete paper is refused

**Roles** Faculty → Exam controller
**Features** `institution_admin.academics.exams_marks_monitoring`
**Endpoints**
- `GET /academics/admin/exam-monitor` → `getExamMonitor`, `internal/api/admin_academics.go:426`; route `internal/api/admin_academics.go:75`
- `POST /academics/admin/exam-monitor/approve` → `approveExamMarks`, `internal/api/admin_academics.go:532`; route `internal/api/admin_academics.go:76`
- Screen `web/src/features/academics/ExamMonitoring.tsx`

**Setup** Two papers for one exam: 6A Maths fully entered, 6A Science with three children missing.
**Steps**
1. `EXAMCTL` reads the monitor.
2. `EXAMCTL` approves by `exam_subject_id` for Science.
3. `EXAMCTL` approves by `exam_id` for the whole exam.
4. `T-MATHS` re-posts a different mark for a child on the now-approved Maths paper.
5. `EXAMCTL` re-reads the monitor.

**Expected** Step 1 shows Science with `marks_pending: 3`. Step 2 returns **409
`marks_incomplete`** (`admin_academics.go:582-584`). Step 3 approves Maths only and
reports `papers_incomplete: 1`. Eligibility is counted from active enrolments, not
from rows already in `marks` (`admin_academics.go:547-551`) — verify by adding a
child to the section and confirming the paper drops back to incomplete.
**Negative — the one that matters** Step 4 must be refused, or must clear the
sign-off.
**Known gap** `03_monthly_term.md:63` — **approval does not lock**. `enterMarks`
upserts without checking `approved_at` and the update does not clear it
(`mod_academics.go:315-326`). Today step 4 succeeds and step 5 still shows the
paper as signed off, with a mark nobody approved. **This test fails today at step 4.**

## AC-19 — Report cards generate with correct totals, rank and readiness

**Roles** Class teacher → Exam controller
**Features** `institution_admin.examinations.report_cards`, `faculty.marks_report_cards.report_cards`
**Endpoints**
- `GET /exams/report-cards/readiness` → `getReportCardReadiness`, `internal/api/mod_academics.go:564`; route `internal/api/api.go:431`
- `POST /exams/report-cards/generate` → `generateReportCards`, `internal/api/mod_academics.go:399`; route `internal/api/api.go:433`, gated `ReportCardsGenerate`
- `GET /exams/report-cards` → `listReportCards`, `internal/api/mod_academics.go:649`; route `internal/api/api.go:430`
- Screen `web/src/features/exams/ReportCards.tsx` (`registry.ts:228,243`)

**Setup** AC-17/18 for all papers of Term 1 exam `E1`, section `SEC-6A`.
**Steps**
1. `T-CLASS6A` reads readiness with one paper still outstanding.
2. `T-CLASS6A` generates with `publish: false`.
3. Complete the outstanding paper; regenerate with `publish: false`.
4. `T-CLASS6A` reads `GET /exams/report-cards?section_id=SEC-6A`.

**Expected** Step 1 names the outstanding paper **and its teacher**, not just a
count (`mod_academics.go:588-596`). Step 2 succeeds but produces totals that
divide entered marks by expected marks — verify the card for a child whose paper is
missing reads as a deficit, which is why readiness exists. After step 3, ranks are
a single windowed pass with consistent ties (`mod_academics.go:436-437`). Step 4
shows staff the unpublished drafts (`mod_academics.go:665-671`).
**Negative**
- `T-SCI` (no `ReportCardsGenerate`, `internal/rbac/rbac.go:325`) must get 403 on generate.
- Regenerating must update the existing card, not create a second (`ON CONFLICT (student_id, academic_year_id) WHERE term_id IS NULL`, `mod_academics.go:453`).
- Attendance printed on the card is `count(*) FROM student_attendance WHERE student_id = …` with **no date bound** (`mod_academics.go:428-432`). For a mid-year joiner this is a percentage of the days they were there for. Assert the number against the child's enrolment window and record the mismatch (`03_monthly_term.md:75`).

## AC-20 — **Term 2 must not overwrite Term 1** *(known broken — write this to fail)*

**Roles** Class teacher → Parent
**Features** `institution_admin.examinations.report_cards`, `parent.academics.results_report_cards`
**Endpoints**
- `POST /exams/report-cards/generate` → `generateReportCards`, `internal/api/mod_academics.go:399`; the INSERT column list at `:441-445` and the conflict target at `:453`
- Schema: `report_cards_student_id_academic_year_id_term_id_key UNIQUE (student_id, academic_year_id, term_id)`, `migrations/00001_baseline.sql:1871`; the partial index `migrations/00006_report_card_uniqueness.sql:11`
- `GET /portal/results` → `getFamilyResults`, `internal/api/portal_family.go:195`

**Setup** Two terms `TERM-1` and `TERM-2` in the same academic year, each with its
own exam (`E1` with `term_id = TERM-1`, `E2` with `term_id = TERM-2`), both fully
marked for `SEC-6A`.
**Steps**
1. `T-CLASS6A` generates and publishes cards for `E1`.
2. `P-SHARMA` reads `GET /portal/results?student_id=<S-ANIL>` and records the Term 1 total, percentage and rank.
3. `T-CLASS6A` generates and publishes cards for `E2`.
4. `P-SHARMA` re-reads `GET /portal/results?student_id=<S-ANIL>`.
5. Tester counts rows in `report_cards` for `S-ANIL` in this academic year.

**Expected (the fix)** Step 4 returns **two** cards, one labelled Term 1 with the
figures recorded at step 2 and one labelled Term 2. Step 5 shows two rows with
distinct non-NULL `term_id`.
**Negative — the failure to catch** Step 4 must not return a single card. Today it
does: `generateReportCards` never supplies `term_id` in its INSERT column list
(`mod_academics.go:441-445`), so every card is the annual card, the upsert targets
the `term_id IS NULL` partial index, and the Term 2 pass **overwrites** the Term 1
row in place. The Term 1 mid-year card is destroyed the moment the school produces
the final one, and the parent's `LEFT JOIN terms t ON t.id = rc.term_id`
(`portal_family.go:211`) has nothing to join to, so both display as
`COALESCE(t.name, ay.name, 'Result')` — the academic year name.
**Also assert the two-half-cards defect.** Have `T-CLASS6A` write a Term 1 remark
via `PUT /teaching/report-remarks` → `saveReportRemark`
(`internal/api/faculty_comms.go:603`, route `internal/api/faculty_comms.go:72`),
then re-read `GET /portal/results`. That handler inserts into `report_cards` with
`term_id` **always set**, targeting `ON CONFLICT (student_id, academic_year_id,
term_id)` (`faculty_comms.go:660-694`) — a *different row* from the one
`generateReportCards` writes. The result is one row with numbers and no words and
another with words and no numbers. The parent must see one card carrying both.
**Known gap** `00_TIMELINE.md:34`, `03_monthly_term.md:65` and finding 4.

## AC-21 — **A parent must not see a mark before its exam is published** *(known broken — write this to fail)*

**Roles** Faculty → Parent
**Features** `parent.academics.results_report_cards`, `student.exams_results.exams_grades`, `faculty.marks_report_cards.marks_entry`
**Endpoints**
- `GET /portal/results` → `getFamilyResults`, `internal/api/portal_family.go:195`; the offending gate at **`internal/api/portal_family.go:245-246`** — `AND EXISTS (SELECT 1 FROM report_cards rc WHERE rc.student_id = m.student_id AND rc.is_published)`
- `POST /exams/marks` → `enterMarks`, `internal/api/mod_academics.go:261`
- `exams.is_published` exists in the schema (`migrations/00001_baseline.sql`, `exams` table) and is **read** at `internal/api/admin_academics.go:449,461`
- Screen `web/src/features/portal/Results.tsx` (`registry.ts:157-158`)

**Setup**
- Exam `E1` (Term 1) fully marked, cards generated **and published** for `SEC-6A`.
- Exam `E2` — a September unit test, `is_published = false`, no report card generated.

**Steps**
1. `P-SHARMA` reads `GET /portal/results?student_id=<S-ANIL>`; record the `subjects[]` list.
2. `T-MATHS` enters `E2` Maths marks for `SEC-6A` — one paper only, unmoderated, not signed off.
3. `P-SHARMA` immediately re-reads `GET /portal/results?student_id=<S-ANIL>`.
4. `S-ANIL` performs the same read on their own account.

**Expected (the fix)** Step 3's `subjects[]` is **identical to step 1's**. The `E2`
Maths mark is absent. The mark becomes visible only once `E2` is itself published
(`exams.is_published`) — or once an `E2` report card is generated and published,
if publication is defined at card level.
**Negative — the failure to catch** Step 3 must not contain a row
`{exam: "E2", subject: "Maths"}`. Today it does. The marks query is gated on
`EXISTS (… report_cards rc WHERE rc.is_published)` — **any** published card, ever,
for that child — and `exams.is_published` is not referenced anywhere in the query
(`portal_family.go:239-247`). Publishing the Term 1 card in step 0 therefore opens
every mark the child will ever receive for the rest of the year, visible the second
a teacher saves the gradebook. The comment above the query claims the opposite.
**Second half of the same defect** There is no way to publish an exam at all.
`grep "INTO exams"` finds one insert (`internal/api/setup.go:685`) which does not
set `is_published`, and there is no `UPDATE exams` anywhere in `internal/api/`. So
even a corrected gate on `exams.is_published` would show a parent nothing until a
publish handler exists. Raise both.
**Also assert** step 4 — a student's own view uses the same handler and the same
gate. The leak is identical for the child.
**Known gap** `00_TIMELINE.md:33`, `03_monthly_term.md:67` and finding 4.

## AC-22 — Publication is a decision, not a checkbox on generation

**Roles** Class teacher → Exam controller → Parent
**Features** `institution_admin.examinations.report_cards`
**Endpoints**
- `POST /exams/report-cards/generate` with `{"publish": true}` — `internal/api/mod_academics.go:407,470-472`
- Permission `rbac.ReportCardsGenerate`, held by `class_teacher` (`internal/rbac/rbac.go:331`)
- `notifyReportCardPublished`, `internal/api/mod_academics.go:494`

**Steps**
1. `T-CLASS6A` generates with `publish: false`. Check for family notifications.
2. `T-CLASS6A` generates with `publish: true`.
3. `P-SHARMA` and `S-ANIL` check `GET /portal/notifications` (`listFamilyNotifications`, `internal/api/portal_school_life.go:1848`).
4. Tester inspects `report_cards.pdf_file_id` and any record of who released.

**Expected** Step 1 sends **no** notification — silence on an unpublished
regeneration is deliberate (`mod_academics.go:474-483`). Step 3 shows exactly one
`report_card` notification per recipient per child, each linking to that child's own
card; a family of three gets three alerts (`mod_academics.go:494-535`).
**Negative**
- A guardian of two children must get two notifications carrying two distinct `student_id`s, not one generic alert. Run with `P-SHARMA` and confirm.
- `P-OTHER` must receive nothing for `SEC-6A`.
**Known gap** `03_monthly_term.md:66` — there is **no distinct approval or release
step**. Whoever can generate can release to parents, in the same call, with no
record of who released and no PDF (`pdf_file_id` is never written). Assert step 4
and record the absence; the principal's "verify and issue" has no handler.

## AC-23 — Staff see drafts; families see only published

**Roles** Faculty → Parent
**Features** `institution_admin.examinations.report_cards`, `parent.academics.results_report_cards`
**Endpoints**
- `GET /exams/report-cards` → `listReportCards`, branch at `internal/api/mod_academics.go:663-676`; route group gated on `rbac.ExamsRead` (`internal/api/api.go:422`)
- `GET /portal/results` → `getFamilyResults`, card query gated `rc.is_published` (`internal/api/portal_family.go:213`)

**Steps**
1. `T-CLASS6A` generates unpublished cards; reads `GET /exams/report-cards?section_id=SEC-6A`.
2. `P-SHARMA` calls `GET /exams/report-cards`.
3. `P-SHARMA` calls `GET /portal/results?student_id=<S-ANIL>`.

**Expected** Step 1 lists the drafts with `is_published: false`. Step 2 returns
**403** — neither `student` nor `parent` holds `ExamsRead` (`internal/rbac/rbac.go:375-378`).
Step 3 returns `cards: [], published: false` with the explicit `published` flag, so
the SPA can say "your school has not released results" rather than showing an empty
page (`portal_family.go:267-274`).
**Negative** `T-SCI` calling step 1 must see only sections in their own scope — the
staff branch narrows on `res.SectionIDs` (`mod_academics.go:672-674`). Confirm a 6B
teacher gets no 6A cards.
**Note for the tester** The `len(res.StudentIDs) > 0` family branch in
`listReportCards` (`mod_academics.go:665-667`) is dead code in practice: the route
requires `ExamsRead`, which no family role holds. Do not treat it as the parent's
path.

## AC-24 — A student cannot read another student's academic record

**Roles** Student
**Features** `student.exams_results.academic_record`, `student.exams_results.exams_grades`
**Endpoints**
- `GET /portal/academic-record` → `getAcademicRecord`, `internal/api/student_learning.go:2263`
- `GET /portal/results` → `getFamilyResults` via `whichChild`, `internal/api/portal_family.go:33`

**Steps**
1. `S-ANIL` calls `GET /portal/results?student_id=<S-CHAN>`.
2. `S-ANIL` calls `GET /portal/academic-record?student_id=<S-CHAN>`.
3. `S-ANIL` calls `GET /portal/results?student_id=<S-BINA>` (a sibling — but `S-ANIL` is a student, not a guardian).

**Expected** All three return **404**, not 403. The identical answer for
"not yours" and "does not exist" is deliberate so the endpoint cannot be walked to
discover which admission numbers are real (`portal_family.go:52-54`).
**Negative** A 403, a 200 with an empty body, or any response that differs between
a real-but-forbidden id and a fabricated uuid is a fail — the difference is the
enumeration oracle.

---

## Substitution

## AC-25 — A teacher is absent, a substitute is assigned from the board, and the proxy is genuinely free

**Roles** Admin/HOD → Faculty (substitute)
**Features** `institution_admin.academics.faculty_substitution_engine`, `hod.timetable.substitution_requests`
**Endpoints**
- `GET /academics/admin/substitution-board` → `getSubstitutionBoard`, `internal/api/admin_academics.go:796`; route `internal/api/admin_academics.go:83`
- `POST /timetable-admin/substitutions` → `createSubstitution`, `internal/api/mod_ops.go:384`; route `internal/api/api.go:487`, gated `TimetableWrite`
- `GET /teaching/my-work` → `getMyWork`, cover block at `internal/api/faculty_work.go:142-165`
- Screen `web/src/features/academics/SubstitutionBoard.tsx`

**Setup** AC-01. `T-MATHS` marked absent in `staff_attendance` for today, or holding an approved `leave_requests` row covering today.
**Steps**
1. Admin reads the board for today.
2. Admin assigns a suggested free teacher to `T-MATHS`'s period-3 6A Maths slot.
3. The substitute reads `GET /teaching/my-work`.

**Expected** Step 1 lists every period `T-MATHS` was due to teach today, each with
up to eight candidates ordered by "teaches this subject" then by lightest day
(`admin_academics.go:818-844`). Candidates exclude anyone who is themselves absent,
anyone timetabled in that period, and anyone already given cover in that period
(`admin_academics.go:830-843`). Step 3 shows the cover as a `substitution` work
item with `overdue: true` when it is today (`faculty_work.go:167-174`).
**Negative**
- Assigning a teacher who is timetabled in that period must return **409 `proxy_busy`** (`mod_ops.go:423-427`).
- **Assign the same proxy to two different classes in the same period, in two calls.** The board excludes such a candidate from its suggestions (`admin_academics.go:838-842`), but `createSubstitution`'s busy check queries **only `timetable_entries`** (`mod_ops.go:407-418`) — it does not check existing `substitutions`. The second call succeeds and double-books the proxy. Compare with `decideCoverRequest`, which checks both (`internal/api/timetable_ops.go:2330-2338`). **This is the failure to catch.**
- Assigning twice for the same `timetable_entry_id` and date must not 500: `substitutions_timetable_entry_id_on_date_key` is UNIQUE (`migrations/00001_baseline.sql:1952`) and `createSubstitution` has no `ON CONFLICT` clause (`mod_ops.go:417-421`), while the cover-request path does (`timetable_ops.go:2349-2355`). Confirm the error is a 409, not a 500.

## AC-26 — A teacher requests cover for their own periods and it is decided

**Roles** Faculty → HOD/Admin → Faculty (substitute)
**Features** `faculty.timetable.substitution_request_submission`, `hod.timetable.substitution_requests`
**Endpoints**
- `GET /timetable-cover/my-periods` → `listCoverablePeriods`, route `internal/api/timetable_ops.go:109` (mount `:107`)
- `POST /timetable-cover/requests` → `createCoverRequest`, route `internal/api/timetable_ops.go:112`
- `POST /timetable-cover/requests/{id}/decide` → `decideCoverRequest`, `internal/api/timetable_ops.go:2248`; route `:114`, gated `TimetableWrite`
- Screen `web/src/features/faculty/SubstitutionRequest.tsx`

**Steps**
1. `T-MATHS` lists their coverable periods for a future date and raises a request over two of them.
2. `T-MATHS` attempts to decide their own request.
3. Admin decides, assigning a free proxy to one line only.
4. `T-MATHS` re-reads the request.

**Expected** Step 2: 403. Step 3 writes into the **existing `substitutions` table**,
not a parallel one (`timetable_ops.go:2349`), sets the covered line's
`substitution_id`, and returns status `partially_approved` because one line remains
pending (`timetable_ops.go:2376-2381`).
**Negative** Assigning a proxy who is busy — either timetabled or already covering
in that period — must return the `errCoverBusy` refusal **naming the teacher**
(`timetable_ops.go:2342-2347`). Confirm the name is in the message; "that teacher is
busy" without a name sends the head of department back to the grid.

## AC-27 — The class register and "who is teaching now" reflect the substitution

**Roles** Admin → Faculty (substitute) → Student → Parent
**Features** `faculty.dashboard.todays_classes`, `faculty.attendance.take_attendance`, `student.timetable.timetable`
**Endpoints**
- `GET /teaching/today` → `listTodaysClasses`, `internal/api/role_scoped.go:168`; route `internal/api/api.go:252`
- `POST /attendance` → `markAttendance`, scope via `CanMarkSection`, `internal/api/attendance.go:117`
- Scope resolution for sections: `internal/scope/scope.go:112-119` — `section_subject_teachers` ∪ `timetable_entries` ∪ `sections.class_teacher_id`
- `GET /portal/summary` → today's periods, `internal/api/role_scoped.go:370-384`

**Setup** AC-25 complete: `T-SCI` is the assigned substitute for `T-MATHS`'s period-3 6A Maths slot today.
**Steps**
1. `T-SCI` calls `GET /teaching/today`.
2. `T-SCI` attempts `POST /attendance` for `SEC-6A`, period 3.
3. `S-ANIL` calls `GET /portal/summary`.
4. `P-SHARMA` calls `GET /portal/summary?student_id=<S-ANIL>`.

**Expected (the fix)** Step 1 includes the covered 6A period, flagged as cover.
Step 2 succeeds for that period. Steps 3 and 4 name `T-SCI` against period 3 today.
**Negative — the failures to catch, all three live**
- Step 1 today returns **only** rows where `te.teacher_user_id = $1` (`role_scoped.go:186-197`). The covered period is absent from the substitute's own day sheet; it appears only under `GET /teaching/my-work` (`faculty_work.go:142`), which is a different screen. A substitute reading "Today's classes" is told they have nothing.
- Step 2 today returns **403**. `scope.Resolve` builds `SectionIDs` from `section_subject_teachers`, `timetable_entries` and `class_teacher_id` — **`substitutions` is not one of the three** (`internal/scope/scope.go:112-119`). The teacher the school put in front of the class cannot mark its register. Verify, then verify that `PRINCIPAL` (holding `AttendanceWriteAny`) can, which is the only current workaround.
- Steps 3 and 4 today still name `T-MATHS`: both the portal summary (`role_scoped.go:370-384`) and `listTodaysClasses` join `timetable_entries` with no `LEFT JOIN substitutions`. The family is told the absent teacher is taking the class.

## AC-28 — A substitution does not survive the day it was made for

**Roles** Admin → Faculty
**Features** `institution_admin.academics.faculty_substitution_engine`
**Endpoints** `GET /academics/admin/substitution-board?on_date=`, `internal/api/admin_academics.go:796`; `substitutions.on_date` join at `:853`

**Steps**
1. Assign cover for today.
2. Read the board for tomorrow.
3. Read `GET /teaching/my-work` as the substitute the day after.

**Expected** The board for tomorrow shows the slot uncovered. `my-work` filters
`sb.on_date >= CURRENT_DATE` (`faculty_work.go:146`), so yesterday's cover has gone.
**Negative** A substitution must not silently repeat on the same weekday next week.
Confirm by advancing the date seven days and re-reading the board.

---

## Study material and the virtual class

## AC-29 — Faculty uploads material; the student's own class opens it

**Roles** Faculty → Student
**Features** `faculty.teaching.lms_study_material_upload`, `student.learning.e_learning_resource_hub`
**Endpoints**
- `POST /teaching/materials` → `createTeachingMaterial`, `internal/api/teaching.go:605`; route `internal/api/teaching.go:77`
- `PUT /teaching/materials/{id}` → `updateTeachingMaterial`, `internal/api/teaching.go:703`; route `:78`
- `GET /portal/learning/resources` → `listMyResources`, `internal/api/student_learning.go:282`; route `internal/api/student_learning.go:57`
- Screens `web/src/features/faculty/LMSUpload.tsx`, `web/src/features/learning/Resources.tsx`

**Steps**
1. `T-MATHS` posts a material for `SEC-6A` with an `external_url`.
2. `S-ANIL` calls `GET /portal/learning/resources`.
3. `S-BINA` (6B) calls the same.
4. `T-MATHS` withdraws it (`PUT` with `is_published: false`).
5. `S-ANIL` re-reads.

**Expected** Step 1 succeeds. Step 2 lists it. Step 3 does not — the query matches
`sm.section_id = <the child's section>` or a class-wide row
(`student_learning.go:298-300`). Step 5 no longer lists it — withdrawal is
`is_published = false`, not a delete (`teaching.go:700-702,741`), so a worksheet
pulled back does not break links already handed out.
**Negative**
- Posting with neither `file_id` nor `external_url` must be refused with the explicit 400 (`teaching.go:624-629`) — a title that opens nothing.
- `T-SCI` posting for `SEC-6A` must get 403 "sharing material with this section" (`teaching.go:653-656`).
- `T-SCI` posting with a `class_subject_id` for a 6A subject must get 403 "sharing material for this subject" — checked inside the transaction against `classSubjectTaught` (`teaching.go:664-672,687-690`).
- A material with `kind: "worksheet7"` must be refused (`teaching.go:618-621`).

## AC-30 — Faculty schedules a live class; the student joins and raises a hand

**Roles** Faculty → Student
**Features** `student.learning.virtual_classroom_hand_raise_telemetry`, `super_admin.payments_devices.virtual_classroom_integration`
**Endpoints**
- `POST /teaching/virtual-classes` → `scheduleVirtualClass`, `internal/api/teaching.go:969`; route `internal/api/teaching.go:79`
- `POST /teaching/virtual-classes/{id}/launch` → `launchVirtualClass`, `internal/api/teaching.go:1136`; route `:81`
- `GET /portal/live-classes` → `listMyLiveClasses`, `internal/api/student_life.go:2091`; route `internal/api/student_life.go:117`
- `POST /portal/live-classes/{id}/hand` → `raiseHand`, `internal/api/student_life.go:2141`; route `:118`
- `GET /portal/live-classes/{id}/hands` → `listRaisedHands`, `internal/api/student_life.go:2251`; route `:123`, gated `HomeworkWrite`
- Screens `web/src/features/faculty/VirtualClasses.tsx`, `web/src/features/learning/HandRaise.tsx`

**Steps**
1. `T-MATHS` schedules a session for `SEC-6A` with **no** `join_url`.
2. `T-MATHS` launches it.
3. `T-MATHS` sets a `join_url` and launches again.
4. `S-ANIL` lists live classes and raises a hand.
5. `S-ANIL` raises a hand again without lowering.
6. `T-MATHS` reads the raised hands and calls on `S-ANIL`.

**Expected** Step 1 returns `status: "provider_pending"` with the honest note that
no provider integration is wired (`teaching.go:1004-1008,1042-1046`). Step 2 returns
**503 `provider_unconfigured`** with instructions, not a 500 and not a fake link
(`teaching.go:1174-1179`). Step 3 sets `status: "live"`. Step 4 returns 201.
Step 5 returns **409 `hand_already_up`** (`student_life.go:2185-2187`).
**Negative**
- `S-BINA` (6B) raising a hand in the 6A session must get 404 — the session is looked up `WHERE id = $1 AND section_id = $2` against the child's own room (`student_life.go:2166-2168`).
- Raising a hand in a session that is `scheduled` or `ended` must be refused ("that class is not live", `student_life.go:2172`).
- `S-ANIL` calling `GET /portal/live-classes/{id}/hands` must get 403 — the staff group requires `HomeworkWrite` (`student_life.go:120-121`).
- A hand that is *lowered* and a hand that is *never called on* must be distinguishable in `virtual_class_hand_raises` (`lowered_at` vs `answered_at`) — the whole point of the table.

---

## The homework forum and the student wall

## AC-31 — A student asks about tonight's homework and a classmate answers

**Roles** Student → Student → Faculty
**Features** `student.homework.classmate_homework_help_forum`
**Endpoints**
- `POST /portal/homework/forum/threads` → `openForumThread`, `internal/api/student_life.go:1535`; route `internal/api/student_life.go:102`
- `GET /portal/homework/forum/threads` → `listForumThreads`, `internal/api/student_life.go:1471`; route `:101`
- `GET /portal/homework/forum/threads/{id}` → `getForumThread`, `internal/api/student_life.go:1664`; route `:103`
- `POST /portal/homework/forum/threads/{id}/posts` → `replyToForumThread`, `internal/api/student_life.go:1779`; route `:104`
- Screen `web/src/features/learning/HomeworkForum.tsx`

**Setup** AC-04: homework `HW-1` set for `SEC-6A`, `due_on` = tomorrow.
**Steps**
1. `S-ANIL` opens a thread anchored to `HW-1`.
2. `S-CHAN` (also 6A) replies with `kind: "hint"`.
3. `S-CHAN` replies again with `kind: "solution"`.
4. `S-ANIL` reads the thread.
5. Advance to the day after `due_on`; `S-ANIL` reads it again.
6. `T-MATHS` reads the thread.

**Expected** Step 4: the hint's body is present; the solution's body is `""` with
`withheld: true` (`student_life.go:1727-1737`). Step 5: the solution body is
visible — the withholding expires with `hw.due_on` (`student_life.go:1729`).
Step 6: staff see the solution immediately (`is_staff` and the `$3` staff flag both
bypass the mask).
**Negative**
- `S-BINA` (6B) calling `GET .../threads` must not see this thread — the list is keyed `t.section_id = <the child's own section>` (`student_life.go:1502`). Section scope, not campus scope, is the difference between this and the wall.
- `S-BINA` fetching the thread by id must get 404 (`student_life.go:1696-1712`).
- Opening a thread anchored to a homework set for a **different** section must be refused — the anchor is checked against the database, not trusted (`student_life.go:1589-1593`).
- The solution author must still see their own post's body (`p.author_user_id = $2`).

## AC-32 — A teacher supervises and takes down a forum thread

**Roles** Student → Faculty
**Features** `student.homework.classmate_homework_help_forum`
**Endpoints**
- `GET /portal/homework/forum/supervision` → `superviseForumThreads`, `internal/api/student_life.go:1932`; route `internal/api/student_life.go:111`, gated `HomeworkWrite`
- `POST /portal/homework/forum/threads/{id}/remove` → `removeForumThread`, `internal/api/student_life.go:1980`; route `:112`
- `POST /portal/homework/forum/posts/{id}/remove` → `removeForumPost`; route `:113`
- Moderation trail `logStudentContent`, `internal/api/student_life.go:133`

**Steps**
1. `T-MATHS` reads supervision for threads hanging off their own homework.
2. `T-MATHS` removes a thread with a reason.
3. `S-ANIL` (the author) lists threads.
4. `S-CHAN` (not the author) lists threads.
5. Tester reads `student_content_moderation`.

**Expected** Step 3: the author still sees the thread with `removal_reason`
(`student_life.go:1503`) — "my thread disappeared and nobody said why" is the
failure the rule exists to prevent. Step 4: it is gone. Step 5: one row recording
the actor, action and reason, committed in the same transaction as the removal
(`student_life.go:133-142`).
**Negative**
- `S-ANIL` calling `/remove` must get 403 — the group requires `HomeworkWrite` (`student_life.go:107-113`).
- A removal with no reason must be refused.
- `T-SCI` must not be able to remove a thread on 6A homework — confirm the handler narrows to sections the caller teaches (`student_life.go:2028-2046` resolves the thread's section before acting).

## AC-33 — The student wall is pre-moderated, and a pending post is nobody else's business

**Roles** Student → Class teacher → Student
**Features** `student.campus_life.student_wall_peer_recognition`
**Endpoints**
- `POST /portal/campus/wall` → `postToWall`, `internal/api/student_life.go:651`; route `internal/api/student_life.go:74`
- `GET /portal/campus/wall` → `listWallPosts`, `internal/api/student_life.go:563`; route `:73`
- `GET /portal/campus/wall/queue` → `listWallQueue`, `internal/api/student_life.go:751`; route `:81`, gated `AnnouncementsWrite`
- `POST /portal/campus/wall/{id}/moderate` → `moderateWallPost`, `internal/api/student_life.go:809`; route `:82`
- `GET /portal/campus/wall/{id}/history` → `listWallModeration`, `internal/api/student_life.go:922`; route `:83`
- Screen `web/src/features/learning/StudentWall.tsx`

**Steps**
1. `S-ANIL` posts a recognition naming `S-CHAN`, body 40 characters.
2. `S-CHAN` lists the wall.
3. `S-ANIL` lists the wall.
4. `T-CLASS6A` reads the queue and approves it.
5. `S-CHAN` and `S-BINA` list the wall.
6. `T-CLASS6A` removes it with a reason; tester reads the history.

**Expected** Step 2: the pending post is **absent** — pre-moderation, not
post-moderation (`student_life.go:599-602`). Step 3: the author sees their own
pending post. Step 5: both see it, because the wall is **campus**-scoped
(`p.campus_id = $1`, `student_life.go:598`) — this is the deliberate difference from
the section-scoped forum. Step 6: a `student_content_moderation` row per action.
**Negative**
- Posting about yourself must be refused ("you cannot recognise yourself", `student_life.go:672-675`).
- A body under 10 characters must be refused (`student_life.go:677-681`); over 500 likewise.
- Naming a subject student on a different campus must be refused (`student_life.go:694-697`).
- `reject` or `remove` without a reason must be refused (`student_life.go:835-839`).
- `S-ANIL` calling the queue must get 403.
- **The sibling case:** `P-SHARMA` calling `GET /portal/campus/wall` with no `student_id` gets whichever child `whichChild` returns first (`myClassroom` → `whichChild`, `portal_family.go:45`), i.e. one campus's wall with nothing saying whose. See AC-03.

---

## Parent-teacher meetings

## AC-34 — A parent books a slot, the meeting is held, and the notes are recorded

**Roles** Admin (slots) → Parent → Faculty
**Features** `parent.school_life.parent_teacher_meeting_booking`, `parent.school_life.calendar_ptm`, `faculty.communication.ptm_notes_action_items`
**Endpoints**
- `GET /portal/school-life/ptm/slots` → `listPTMSlots`, `internal/api/portal_school_life.go:323`; route `:67`
- `POST /portal/school-life/ptm/book` → `bookPTMSlot`, `internal/api/portal_school_life.go:443`; route `:69`
- `GET /portal/school-life/ptm/bookings` → `listPTMBookings`, `internal/api/portal_school_life.go:394`; route `:68`
- `POST /portal/school-life/ptm/{id}/cancel` → `cancelPTMBooking`, `internal/api/portal_school_life.go:624`; route `:70`
- `POST /teaching/ptm-notes` → `savePTMNote`, `internal/api/faculty_comms.go:817`; route `internal/api/faculty_comms.go:73`
- `GET /teaching/ptm-notes` → `listPTMNotes`, `internal/api/faculty_comms.go:744`; route `:64`
- Screens `web/src/features/portal/PTM.tsx`, `web/src/features/faculty/PTMNotes.tsx`

**Setup** `ptm_slots` published for `T-CLASS6A`, some section-restricted to `SEC-6A`.
**Steps**
1. `P-SHARMA` lists slots.
2. `P-SHARMA` books one, naming `student_id: <S-ANIL>`.
3. `P-OTHER` attempts to book the same slot.
4. The meeting is held. `T-CLASS6A` saves a PTM note for `S-ANIL` with concerns, agreed actions, a follow-up date and `visible_to_family` true.
5. `P-SHARMA` reads `GET /portal/school-life/ptm/bookings`.

**Expected** Step 1 shows only slots open to `P-SHARMA`'s children's sections
(`portal_school_life.go:355-357`). Step 3 loses the race cleanly — separation is by
the partial unique index `appointments_no_double_booking`, not a check-then-insert
(`portal_school_life.go:450-455`). Step 5 shows the booking **with** `concerns` and
`agreed_actions` joined from `ptm_notes` (`portal_school_life.go:414-419`).
**Negative**
- Booking with no `student_id` when the guardian has two children must be refused (`portal_school_life.go:471-474` via `portalChild`).
- A note saved with `visible_to_family` false must **not** appear at step 5 — the lateral join checks `p.visible_to_family` (`portal_school_life.go:417`).
- A note with `attendance != 'none'` and neither concerns nor actions must be refused (`faculty_comms.go:834-839`) — an empty meeting record.
- `T-SCI` saving a note for `S-ANIL` must get 404 — `reachesTaughtStudent` guards it (`faculty_comms.go:849-856`).
- Cancelling a meeting already held or already cancelled must be refused; `cancellable` is computed server-side so the button is not offered (`portal_school_life.go:410`).

## AC-35 — Last term's agreed actions are surfaced at the next meeting

**Roles** Faculty
**Features** `faculty.communication.ptm_notes_action_items`
**Endpoints** `GET /teaching/ptm-notes?student_id=` → `listPTMNotes`, `internal/api/faculty_comms.go:744`; the "previous sitting" retrieval `internal/api/portal_school_life.go:388`

**Setup** A PTM note from October for `S-ANIL` with `agreed_actions` and
`follow_up_on` in January, `follow_up_done` false.
**Steps**
1. `T-CLASS6A` opens the PTM note screen for `S-ANIL` in January.
2. `T-CLASS6A` saves a second note for the same child on the same day.

**Expected** Step 1 shows the October note's concerns, agreed actions and the
outstanding follow-up. Step 2 **updates** the October-keyed row only if the key
matches; the unique index is `(student_id, met_on, COALESCE(recorded_by, …))`, so a
second note by the same teacher on the same day updates rather than duplicating
(`faculty_comms.go:868-880`), and a different teacher's note on the same day is a
separate row.
**Known gap** `03_monthly_term.md:69` — `ptm_notes` is **not linked to the
`appointments` row**. A slot booked and not honoured is invisible: there is no way to
ask "which parents booked and did not come". Assert this by booking a slot,
recording no note, and confirming no endpoint reports the no-show.

---

## Discipline

## AC-36 — Faculty records an incident; who may read it

**Roles** Faculty → Student → Parent → Counsellor
**Features** `institution_admin.students.disciplinary_incident_log`
**Endpoints**
- `POST /students/notes` → `recordDisciplineNote`, `internal/api/my_classes.go:337`; route `internal/api/api.go:73`, gated `DisciplineWrite`
- `GET /students/notes` → `listDisciplineNotes`, `internal/api/my_classes.go:283`; route `internal/api/api.go:72`, gated `StudentsRead`
- `GET /portal/notes` → the **same handler**, `internal/api/api.go:280`
- Visibility gate: `visible := "TRUE"` unless the caller lacks `DisciplineWrite`, then `dr.visible_to_student` (`internal/api/my_classes.go:294-298`)
- Screen `web/src/features/students/DisciplineLog.tsx`

**Steps**
1. `T-MATHS` records a note about `S-ANIL` with `visible_to_student: false` ("spoke to the counsellor about trouble at home").
2. `T-MATHS` records a positive note with `visible_to_student: true`.
3. `S-ANIL` calls `GET /portal/notes`.
4. `P-SHARMA` calls `GET /portal/notes?student_id=<S-ANIL>`.
5. `T-CLASS6A` calls `GET /students/notes?student_id=<S-ANIL>`.
6. `T-SCI` records a note about `S-ANIL`.

**Expected** Steps 3 and 4 return **only** the positive note. Step 5 returns both —
`T-CLASS6A` holds `DisciplineWrite`. Step 6 returns **404**: `reachesStudent`
narrows to children the caller actually teaches (`my_classes.go:355-364`), and 404
rather than 403 so the endpoint cannot be probed.
**Negative**
- A note with an empty `description` must be refused with the explicit message (`my_classes.go:346-349`) — a category with no words is unusable at a parent meeting.
- **The visibility flag is single, and it is named for the student.** `visible_to_student` governs both the child's view and the parent's, because both go through the same handler and the same predicate. Assert deliberately: a teacher who wants a parent to see a note the child should not, or vice versa, cannot express it. Record as a design finding.
- `P-OTHER` calling with `student_id=<S-ANIL>` must return nothing — `StudentPredicate` narrows to the caller's own set (`my_classes.go:292`).

## AC-37 — Does the parent learn of an incident at all?

**Roles** Faculty → Parent
**Features** `institution_admin.students.disciplinary_incident_log`, `parent.academics.child_remarks`
**Endpoints**
- `recordDisciplineNote` writes `parent_notified` (`internal/api/my_classes.go:375-382`)
- `GET /portal/notifications` → `listFamilyNotifications`, `internal/api/portal_school_life.go:1848`
- `GET /portal/remarks` → `listChildRemarks`, `internal/api/faculty_comms.go:1276`; route `internal/api/api.go:275`

**Steps**
1. `T-CLASS6A` records a serious note with `parent_notified: true` and `visible_to_student: true`.
2. `P-SHARMA` checks `GET /portal/notifications`.
3. `P-SHARMA` checks `GET /portal/notes?student_id=<S-ANIL>`.

**Expected (the fix)** Step 2 shows a notification. Step 3 shows the note.
**Negative — the failure to catch** Step 2 today shows **nothing**.
`recordDisciplineNote` stores `parent_notified` as a boolean claim and calls no
`notify`, queues no message and sends no SMS — compare `submitHomework`, which does
call `notify` (`mod_workflow.go:850`), and `notifyReportCardPublished`
(`mod_academics.go:494`). `parent_notified: true` is an assertion by the teacher
that they telephoned, and the product records it as if the system had done it. A
parent learns of an incident only if they happen to open the portal. Raise this.
**Also assert** `GET /portal/remarks` is a *different* table (`student_remarks`,
gated on `sr.visible_to_family`, `faculty_comms.go:1308`) from `GET /portal/notes`
(`discipline_records`, gated on `visible_to_student`). Confirm a tester can tell
which screen carries which, and that a remark written by `createRemark`
(`internal/api/faculty_comms.go:301`) with `visible_to_family` false does not appear.

## AC-38 — A staff member with institution-wide student access reads the private half

**Roles** Counsellor / Discipline officer
**Features** `institution_admin.students.disciplinary_incident_log`
**Endpoints** `GET /students/notes`, `internal/api/my_classes.go:283`; role grants `internal/rbac/rbac.go:367-372`

**Steps**
1. A `counsellor` (holds `StudentsRead` + `StudentsReadAll`, **not** `DisciplineWrite`) reads notes for `S-ANIL`.
2. A `discipline_officer` (holds `StudentsReadAll` **and** `DisciplineWrite`) reads the same.

**Expected** Step 1 returns only `visible_to_student` notes across the whole
institution — `AllStudents` widens *which children*, `DisciplineWrite` widens *which
notes*, and the two are independent (`my_classes.go:292-298`). Step 2 returns
everything.
**Negative** Step 1 must not return the private counselling note. A counsellor
reading every child's private conduct file institution-wide because
`StudentsReadAll` was mistaken for a discipline right is exactly the shape of the
"counselling message that reached the wrong family". Confirm the two permissions
compose as documented.

---

## Chains I could not test, because the endpoint does not exist

1. **Publishing an exam.** `exams.is_published`, `published_at` and `published_by`
   exist (`migrations/00001_baseline.sql`, `exams` table) and are read at
   `internal/api/admin_academics.go:449,461`. There is exactly one
   `INSERT INTO exams` (`internal/api/setup.go:685`), which does not set the flag,
   and **no `UPDATE exams` anywhere in `internal/api/`**. The column is permanently
   false. AC-21's correct behaviour cannot be reached even after the
   `portal_family.go:246` gate is fixed.

2. **Report card verify-and-release as a distinct step.** Publication is the
   `publish: true` argument to the generate call (`mod_academics.go:407,470`), held
   behind the same `ReportCardsGenerate` permission a class teacher has. There is no
   approve endpoint, no `released_by`, and `report_cards.pdf_file_id` is never
   written. AC-22 tests what exists; the two-person control it implies has no route.
   (`03_monthly_term.md:66`)

3. **Withdrawing or editing homework.** `publishHomework` hard-codes
   `is_published = true` (`mod_workflow.go:649`) and there is no update or delete
   handler on `/homework`. AC-08 is untestable through the API.

4. **Grading a homework submission.** `homework.max_marks` is accepted on creation
   (`mod_workflow.go:578`) and `homework_submissions.status` supports more than
   `submitted`, but `listHomeworkSubmissions` is read-only and no handler awards a
   mark against a homework. (The separate *assignments* module does grade —
   `POST /teaching/assignments/{id}/grade`, `internal/api/teaching.go:76` — but it is
   a different table and a different screen; homework and assignments do not meet.)

5. **The per-paper datesheet.** `exam_subjects.exam_date`, `starts_at` and
   `duration_minutes` are read in eight places and written by none. No test can put
   a date on a paper, so the hall-ticket and student-calendar chains that print it
   cannot be exercised end to end. (`03_monthly_term.md:59`)

6. **Moderation, scaling and grace marks.** `marks.grace_marks` is read by every
   analytics query and written by no handler; there is no before/after record of a
   changed mark (the audit middleware stores the request body, not the prior value —
   `internal/api/audit.go:222`). A test for "the head of department moderated this
   paper" has nothing to call. (`03_monthly_term.md:64`)

7. **Section change mid-year.** No handler sets `enrollments.section_id`. The
   obvious route, `POST /lifecycle/promote`, closes the current enrolment and then
   hits `UNIQUE (student_id, academic_year_id)` with `ON CONFLICT DO NOTHING`,
   leaving the child with **no active enrolment** — off the register, the gradebook,
   the report-card generator and the homework list, all of which filter
   `status = 'active'`. I have deliberately not written this as an acceptance test
   because running it destroys the fixture. Treat it as a P0 defect, not a test.
   (`03_monthly_term.md:77`)

8. **A term-scoped attendance denominator.** Report-card attendance
   (`mod_academics.go:428`) and the shortage list (`role_principal.go:138`) have no
   date bound, so "attendance for Term 1" cannot be asserted against anything. AC-16
   and AC-19 record the mismatch rather than testing a correct value.
