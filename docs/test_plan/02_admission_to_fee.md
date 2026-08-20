# Acceptance tests 02 — ENQUIRY → STUDENT → MONEY

Scope: the three joined journeys that run between Admissions, the Institution
Admin, Finance and the Parent — the funnel (enquiry to seat), the handoff (an
accepted applicant becoming a student with a roll, a guardian, a bus and a fee
demand), and the money (structure to invoice to counter to receipt to
allocation to outstanding to reminder), plus concessions, the mid-year join and
exit, and the principal's oversight of intake and collection. Every test below
names a route that exists in `internal/api/api.go` and a handler that was read,
and every amount is `bigint` paise — a rupee on a screen is a conversion done at
the edge (`internal/fees/words.go:14`, `message_rules.go:326`) and never in the
ledger. Where `docs/gap_analysis/01_pre_year.md` or `02_onboarding_daily.md`
records that a chain is cut, the test says so under **Known gap** and states the
result a tester should see *today*, so that a later fix is confirmable rather
than assumed. Two facts colour the whole document and are repeated in every test
they touch: **no guardian can ever obtain a login** (`guardians.user_id` is
written only by `cmd/migrate/demo.go:261`), so any step phrased "the parent sees
it" is executable only as a demo-seeded tenant or by direct database read; and
**seat availability is computed across all academic years at once**
(`mod_admissions.go:383`), so any capacity number is wrong the moment next
year's sections exist.

All paths below are relative to `/api/v1`.

---

## Setup

### AF-01 — Stand up the year, the class, the section and the fee structure

| | |
|---|---|
| **Roles** | Institution Admin, then Finance |
| **Features** | `institution_admin.academics.academic_calendar`, `institution_admin.academics.classes_sections`, `finance.fee_structure.fee_head_group_setup`, `finance.fee_structure.class_wise_fee_structure_configuration` |
| **Endpoints** | `POST /setup/academic-years` (`internal/api/api.go:199` → `setup.go:56`); `POST /setup/classes` (`api.go:200`); `POST /setup/sections` (`api.go:201` → `setup.go:152`); `POST /setup/fee-heads` (`api.go:211` → `setup.go:448`); `POST /setup/fee-structures` (`api.go:212` → `setup.go:502`); `GET /setup/fee-structures` (`api.go:213` → `setup.go:596`) |

**Setup** A tenant with an institution and one campus, a user holding
`academics.write`, `settings.write` and `finance.fees.write`.

**Steps**
1. Institution Admin creates academic year 2026-27 marked current.
2. Institution Admin creates Class 1, then section 1-A with `capacity: 40` and
   `academic_year_id` = 2026-27.
3. Finance creates fee heads "Tuition" and "Development".
4. Finance creates a fee structure named "Class 1 — 2026-27" for Class 1 with
   two lines: Tuition 30000000 paise (₹3,00,000) instalment 1, Development
   5000000 paise (₹50,000) instalment 1.

**Expected** `POST /setup/fee-structures` returns 201 with
`{"lines": 2, "total_paise": 35000000}` — the handler sums the lines it wrote
(`setup.go:569`). `GET /setup/fee-structures` echoes `lines: 2`,
`total_paise: 35000000`, `is_active: true`.

**Negative** Re-post the same structure with a line whose `amount_paise` is
negative: 400 "amounts cannot be negative" (`setup.go:518`). Post a structure
with an empty `items` array: 400 "a fee structure needs at least one line"
(`setup.go:513`). Post the same fee head twice in one structure at the same
instalment: the second silently updates the first — the
`ON CONFLICT (fee_structure_id, fee_head_id, instalment_no) DO UPDATE`
(`setup.go:558-563`) means the total is the *last* amount, not the sum. Confirm the
returned `total_paise` in that case is wrong: the Go loop adds both
(`setup.go:569`) while the table holds one.

---

## The funnel

### AF-02 — An enquiry is captured at the front desk and assigned to a counsellor

| | |
|---|---|
| **Roles** | Admissions (front desk), then Admissions (head) |
| **Features** | `admissions.enquiries.enquiries_leads`, `admissions.enquiries.counselor_lead_assignment`, `admissions.enquiries.lead_source_tracking` |
| **Endpoints** | `POST /admissions/workflow/enquiries` (`api.go:399` → `mod_admissions.go:47`); `GET /admissions/enquiries` (`api.go:325` → `role_backoffice.go:200`); `GET /admissions/leads` (`api.go:331`); `POST /admissions/leads/assign` (`api.go:332` → `admissions_funnel.go:134`); `GET /admissions/sources` (`api.go:330`) |
| **Screen** | `web/src/features/admissions/Enquiries.tsx`, `Pipeline.tsx` |

**Setup** AF-01. A user holding `admissions.write` and a second user to receive
the lead.

**Steps**
1. Front desk posts an enquiry: `student_name`, `phone`, `class_sought: "Class 1"`
   (the *name*, not a uuid), `source: "walk_in"`.
2. Front desk lists `/admissions/enquiries` and finds it at status `new`.
3. Admissions head posts `/admissions/leads/assign` naming the enquiry and the
   counsellor.
4. Admissions head reads `/admissions/sources`.

**Expected** Step 1 returns 201 `{"status": "new"}` and the class name is
resolved to a class id inside the transaction (`mod_admissions.go:74-88`) rather
than reaching Postgres as a bad uuid. Step 3 sets `assigned_to`. Step 4 counts
the enquiry under `walk_in`.

**Negative** `source: "instagram"` → 400 naming the permitted set
(`mod_admissions.go:60`, vocabulary at `:37-44`). `class_sought: "Class 99"` →
400 "class_sought must be a class id or the name of a class this school runs"
(`mod_admissions.go:108`). A user without `admissions.write` posting an enquiry
→ 403 from the route middleware (`api.go:399`). Omit `phone` → 400
(`mod_admissions.go:54`).

---

### AF-03 — A lost enquiry cannot be closed without a reason

| | |
|---|---|
| **Roles** | Admissions counsellor |
| **Features** | `admissions.enquiries.counselor_activity_follow_ups`, `admissions.reports.lost_lead_reason_analysis` |
| **Endpoints** | `PUT /admissions/workflow/enquiries/{id}` (`api.go:400` → `mod_admissions.go:129`); `GET /admissions/lost-leads/analysis` (`admissions_growth.go:140`) |

**Setup** AF-02.

**Steps**
1. Counsellor puts `{"status": "contacted", "next_follow_up": "<+3 days>"}`.
2. Counsellor puts `{"status": "lost"}` with no reason.
3. Counsellor puts `{"status": "lost", "lost_reason": "Fee too high"}`.
4. Admissions head reads the lost-lead analysis.

**Expected** Step 2 → 400 "lost_reason is required when marking an enquiry lost"
(`mod_admissions.go:148`). Step 3 → 200, and the reason is appended to notes as
`"Lost: Fee too high"` (`mod_admissions.go:150-153`). Step 4 shows the reason
bucketed.

**Negative** `{"status": "enrolled"}` → 400 "invalid status: enrolled"; the
handler accepts only the five values the CHECK allows
(`mod_admissions.go:141-144`). A `PUT` on a uuid that does not exist → 404
(`mod_admissions.go:175`).

---

### AF-04 — The enquiry becomes an application with a gapless application number

| | |
|---|---|
| **Roles** | Admissions counsellor |
| **Features** | `admissions.applications.applications` |
| **Endpoints** | `POST /admissions/workflow/applications` (`api.go:401` → `mod_admissions.go:203`); `GET /admissions/applications` (`api.go:326`) |
| **Screen** | `web/src/features/admissions/Applications.tsx:61` |

**Setup** AF-02, and the class uuid from `GET /academics/classes` (`api.go:123`).

**Steps**
1. Counsellor posts an application citing `enquiry_id`, with
   `class_sought` as the class **uuid**.
2. Counsellor posts two more applications back to back.
3. Counsellor re-reads the enquiry.

**Expected** Each returns 201 with an `application_no` drawn from the same
row-locked allocator as receipts (`fees.NextNumber`, `internal/fees/fees.go:51`
called at `mod_admissions.go:229`). The three numbers are consecutive with no
gap. The enquiry's status is now `applied` (`mod_admissions.go:253`).

**Negative** `class_sought` as the *name* → 400 "class_sought must be a class
uuid" (`mod_admissions.go:215`) — note the asymmetry with AF-02, where the name
is accepted; this is a real usability defect worth logging, not a test failure.
Omit `parent_phone` → 400 (`mod_admissions.go:210`).

---

### AF-05 — Entrance test and interview are scored, and the merit list weights them

| | |
|---|---|
| **Roles** | Admissions counsellor, then Admissions head |
| **Features** | `admissions.applications.entrance_exam_scheduling`, `admissions.applications.interview_interaction_scheduler`, `admissions.admissions.merit_list_generation` |
| **Endpoints** | `POST /admissions/workflow/applications/{id}/assessment` (`api.go:402` → `mod_admissions.go:276`); `GET /admissions/workflow/merit` (`api.go:396` → `mod_admissions.go:328`) |
| **Screen** | `web/src/features/admissions/Applications.tsx:74` |

**Setup** AF-04, with three applications A, B, C on the same class.

**Steps**
1. Counsellor records `kind: "entrance_test"` with a future `scheduled_at` and
   no score for A, B and C.
2. Counsellor records the results: A 80/100, B 60/100, C no score at all.
3. Counsellor records `kind: "interview"`: A 50/100, B 90/100.
4. Head reads `/admissions/workflow/merit?class_id=…` at the default weights.
5. Head re-reads with `test_weight=50`.

**Expected** Step 4, default 70/30 (`mod_admissions.go:330`): A = 80×0.7 +
50×0.3 = **71.00**, B = 60×0.7 + 90×0.3 = **69.00**, C = **0.00** and sorted
last but *present* — an unassessed applicant is not dropped. Ranks are 1, 2, 3.
Step 5 at 50/50: A = 65.00, B = 75.00 — the ranks swap. Percentages are computed
as `100 × max(score) / max(max_score)` (`mod_admissions.go:339-344`), so a
second test row for the same applicant takes the higher, not the later.

**Negative** `kind: "aptitude"` → 400 "kind must be entrance_test or interview"
(`mod_admissions.go:288`). `test_weight=140` is clamped to 100
(`clampInt`, `mod_admissions.go:330`) rather than producing a score above 100;
confirm the interview weight then reads 0. Rejected and withdrawn applications
are absent from the list (`mod_admissions.go:347`).

---

### AF-06 — The seat matrix is read before any offer is made

| | |
|---|---|
| **Roles** | Admissions head |
| **Features** | `admissions.admissions.seat_allocation_management`, `admissions.admissions.rte_right_to_education_quota_tracking` |
| **Endpoints** | `GET /admissions/workflow/seats` (`api.go:397` → `mod_admissions.go:382`) |
| **Screen** | `web/src/features/admissions/Pipeline.tsx` (`'/api/v1/admissions/workflow/seats'`) |

**Setup** AF-01 with exactly **one** academic year in the tenant. Class 1 has
sections 1-A (capacity 40) and 1-B (capacity 40). Thirty students are already
actively enrolled in Class 1. Two applications sit at `offered`.

**Steps**
1. Head reads the seat matrix.

**Expected** For Class 1: `capacity` 80, `enrolled` 30, `offered` 2,
`available` = 80 − 30 − 2 = **48**, `rte_quota` = 80/4 = **20** (integer
division — a capacity of 82 gives 20, not 20.5; the statute says 25%, and the
truncation is a defect to log). `rte_filled` counts students flagged `is_rte`
enrolled in that class.

**Negative** Set 1-B capacity to NULL: `sum(sec.capacity)` COALESCEs to 0 and
`available` floors at 0 via `GREATEST` (`mod_admissions.go:390`) rather than
going negative. A user holding only `admissions.read` may read this; a user with
no admissions grant gets 403 from the group middleware (`api.go:395`).

---

### AF-07 — An offer is refused when the class is full

| | |
|---|---|
| **Roles** | Admissions head |
| **Features** | `admissions.admissions.offers_admission_decisions`, `admissions.admissions.seat_allocation_management` |
| **Endpoints** | `POST /admissions/workflow/applications/{id}/decision` (`api.go:403` → `mod_admissions.go:418`, guard at `:438-452`) |

**Setup** AF-06, narrowed: one academic year, Class 1 with a single section of
capacity 2, zero enrolments, three applications A, B, C.

**Steps**
1. Head offers A → 200.
2. Head offers B → 200.
3. Head offers C.
4. Head waitlists C instead.

**Expected** Step 3 → **409** with code `no_seats` and the message "no seats
remain in that class; waitlist the applicant instead"
(`mod_admissions.go:469-471`). Step 4 → 200 with status `waitlisted`. The seat
matrix now reads `offered` 2, `available` 0.

**Negative** `decision: "admitted"` → 400 (`mod_admissions.go:431`). A decision
on a nonexistent application → 404 (`mod_admissions.go:475`). Re-offer A a
second time: this is **not** blocked — A is already counted in the `offered`
subquery, so a re-offer consumes nothing extra but also silently rewrites
`decided_by`/`decided_at`; confirm the audit trail loses the original decider.
A user with `admissions.read` only → 403 (`api.go:403`).

---

### AF-08 — KNOWN BROKEN: creating next year's sections doubles this year's capacity

| | |
|---|---|
| **Roles** | Institution Admin, then Admissions head |
| **Features** | `admissions.admissions.seat_allocation_management`, `institution_admin.academics.classes_sections` |
| **Endpoints** | `POST /setup/academic-years` (`api.go:199` → `setup.go:56`); `POST /setup/sections` (`api.go:201` → `setup.go:152`); `GET /admissions/workflow/seats` (`api.go:397` → `mod_admissions.go:382`); `POST /admissions/workflow/applications/{id}/decision` (`api.go:403`, guard `mod_admissions.go:438`) |

**Setup** AF-06 as stated: one year 2026-27, Class 1 = two sections × 40 = 80,
30 active enrolments, seat matrix reading `available: 50` (no offers yet).

**Steps**
1. Institution Admin creates academic year 2027-28. It is created **without**
   disturbing `is_current` — this is the supported, intended action
   (`setup.go:56`, and `academic_years_one_current` keeps one live).
2. Institution Admin creates sections 1-A and 1-B for 2027-28, each capacity 40.
3. Admissions head re-reads `/admissions/workflow/seats`.
4. Admissions head offers a 2027-28 seat via the decision endpoint until the
   guard fires.

**Expected — what a correct system would do** Step 3 should report Class 1
capacity 80 for 2026-27 and 80 for 2027-28 separately, and 2027-28's
availability should be 80 (this year's 30 children will be in Class 2 next
year).

**Expected — what happens today, and the assertion that must fail** Step 3
returns a single Class 1 row with `capacity` **160**, `enrolled` **30**,
`available` **130**. There is no `academic_year_id` predicate on either the
sections join or the enrolment subquery (`mod_admissions.go:384-402`). Step 4
lets the head issue 130 offers before the 409 arrives, against 80 real seats.
Record both numbers; the test passes only when the matrix reports per-year rows
and the guard at `mod_admissions.go:438-452` filters on the application's year.

**Negative** The same year-blind arithmetic is repeated inline in the offer
guard, so the two doors agree with each other and both are wrong; confirm the
409 threshold matches the inflated matrix rather than the real capacity. Note
also that `listTextbookIndents` (`internal/api/library_desk.go:576`) inherits
the same year-blind roll count, so the librarian's shortfall is wrong for the
same reason.

**Known gap** `docs/gap_analysis/01_pre_year.md` §2, P0. Confirmed in code at
`mod_admissions.go:383` (`getSeatMatrix`) and `:436` (`decideApplication`).

---

### AF-09 — KNOWN BROKEN: waitlist promotion walks past the seat guard

| | |
|---|---|
| **Roles** | Admissions head |
| **Features** | `admissions.admissions.admission_waitlist_management` |
| **Endpoints** | `POST /admissions/waitlist/promote` (`api.go:336` → `admissions_funnel.go:471`); `GET /admissions/workflow/seats` (`api.go:397`) |

**Setup** AF-07 at its end state: capacity 2, A and B offered, C waitlisted,
`available` 0. Add D and E, also waitlisted, with `waitlist_rank` 1 and 2 set
through `POST /admissions/applications/patch` (`api.go:334` →
`admissions_funnel.go:347`).

**Steps**
1. Head posts `{"class_id": …, "seats": 3}` to the waitlist promoter.
2. Head re-reads the seat matrix.

**Expected — what a correct system would do** Refuse, or promote zero, because
`available` is 0.

**Expected today** 200 with `{"count": 3}` and all three named. The UPDATE
(`admissions_funnel.go:491-500`) has **no capacity check at all** — it is the
only path to `offered` that does not consult the guard. The matrix then reports
`offered` 5 against `capacity` 2 and `available` 0. The test fails until the
promoter shares the guard `decideApplication` uses.

**Negative** `seats: 0` is coerced to 1 (`admissions_funnel.go:481`) rather than
being a no-op. Promotion is ordered `waitlist_rank NULLS LAST, created_at`
(`admissions_funnel.go:497`), so an applicant with no rank is promoted after all
ranked ones — confirm D and E go before C. A duplicate `waitlist_rank` on patch
→ 409 `rank_taken` (`admissions_funnel.go:399`).

---

### AF-10 — Quota is recorded on the application and reserved nowhere

| | |
|---|---|
| **Roles** | Admissions counsellor, Admissions head |
| **Features** | `admissions.admissions.seat_allocation_management`, `admissions.admissions.sibling_priority_auto_matching`, `admissions.admissions.alumni_child_quota_allocation` |
| **Endpoints** | `POST /admissions/applications/patch` (`api.go:334` → `admissions_funnel.go:347`); `GET /admissions/register` (`api.go:333`); `GET /admissions/siblings` (`api.go:335`); `GET /admissions/workflow/seats` (`api.go:397`) |

**Setup** AF-04 with five applications on Class 1, capacity 40.

**Steps**
1. Counsellor patches quota `management` on three applications and `sibling` on
   two.
2. Head reads the admission register and the seat matrix.

**Expected** The patch accepts all eight quota values
(`admissions_funnel.go:358-359`) and the register shows them. The seat matrix
shows exactly one quota — `rte_quota`, hard-derived as `capacity / 4`
(`mod_admissions.go:396`). There is **no per-quota seat count**, so "we have
committed 15 management seats" cannot be expressed or enforced.

**Negative** `quota: "ews_extra"` → 400 "unknown quota" (`admissions_funnel.go:360`).
Offering all five applicants succeeds regardless of quota — the guard counts
heads, not quotas.

**Known gap** `01_pre_year.md`, seat allocation row, P1: eight quota values,
one quota table's worth of enforcement, and that one derived rather than
configured.

---

## The handoff

### AF-11 — The accepted applicant becomes a student, with a guardian, in one transaction

| | |
|---|---|
| **Roles** | Admissions head (offer), Institution Admin / registrar (`students.write`) |
| **Features** | `admissions.admissions.enrollment_handoff`, `admissions.admissions.offers_admission_decisions` |
| **Endpoints** | `POST /admissions/workflow/applications/{id}/enrol` (`api.go:404` → `mod_admissions.go:499`); `GET /students/{id}` (`api.go:84`); `GET /academics/sections` (`api.go:124`) |
| **Screen** | `web/src/features/admissions/Applications.tsx:107` — sends `section_id` and nothing else |

**Setup** AF-07: applicant A at status `offered`, section 1-A exists.

**Steps**
1. Registrar posts `{"section_id": "<1-A>"}` to the enrol route.
2. Registrar reads the created student.
3. Registrar reads `student_guardians` for that student (via
   `GET /students/{id}/profile`, `api.go:85`).
4. Registrar enrols a **second** child of the same family — same parent name and
   phone on the application.

**Expected** Step 1 → 201 with `student_id`, `admission_no` and
`status: "enrolled"`. The admission number comes from the same gapless allocator
(`mod_admissions.go:546`). One transaction writes: `students` (status `active`,
`admission_date` = today), `enrollments` (status `active`, resolved year), a
`guardians` row and a `student_guardians` link marked primary, and flips the
application to `accepted` with `student_id` set (`mod_admissions.go:546-612`).
Step 4 must succeed: the guardian insert is an upsert on
`(institution_id, phone, full_name)` (`mod_admissions.go:589-596`), so a sibling
reuses the parent rather than colliding.

**Negative** Enrol an application at status `waitlisted` → 400 "only an offered
application can be enrolled" (`mod_admissions.go:542`, surfaced at `:616`).
Enrol with `section_id` omitted or not a uuid → 400 (`mod_admissions.go:512`).
A user holding `admissions.write` but not `students.write` → 403; the enrol
route is the one step in the funnel gated on students, not admissions
(`api.go:404`). Note that **no endpoint exists for the family to accept an
offer** — `applications.status` goes from `offered` straight to `accepted`
inside this handler, so "acceptance" is an act of the school, not of the parent.

---

### AF-12 — The handoff is idempotent under a double-submit

| | |
|---|---|
| **Roles** | Registrar |
| **Features** | `admissions.admissions.enrollment_handoff` |
| **Endpoints** | `POST /admissions/workflow/applications/{id}/enrol` (`api.go:404` → `mod_admissions.go:499`) |

**Setup** AF-11 step 1 completed.

**Steps**
1. Registrar posts the same enrol request a second time (the clerk double-clicks,
   or the network retries).
2. Registrar counts students with that admission number and enrolments for that
   student.

**Expected** 201 again, returning the **same** `student_id` and **no new**
admission number — the handler selects `FOR UPDATE`, sees `student_id` already
set on the application, and returns early (`mod_admissions.go:531-540`). Exactly
one `students` row and one `enrollments` row exist. Note the response's
`admission_no` is empty on the second call; confirm the screen does not print a
blank number on a receipt or ID card.

**Negative** Post the two requests concurrently from two terminals: the
`FOR UPDATE` on `applications` serialises them, so one creates and the other
returns the same id. Two student rows is a failure.

---

### AF-13 — KNOWN BROKEN: the handoff leaves no roll number, no fee assignment and no invoice

| | |
|---|---|
| **Roles** | Registrar, then Finance |
| **Features** | `admissions.admissions.enrollment_handoff`, `finance.fee_structure.demand_invoice_generation` |
| **Endpoints** | `POST /admissions/workflow/applications/{id}/enrol` (`api.go:404` → `mod_admissions.go:499`); `GET /fees/students/{id}/ledger` (`api.go:308` → `fees.go:68`) |

**Setup** AF-11, plus the fee structure from AF-01.

**Steps**
1. Registrar posts the enrol request including `"fee_structure_id": "<AF-01>"`
   and `"academic_year_id": "<2026-27>"`.
2. Finance opens the new student's ledger.
3. Registrar reads the enrolment's `roll_no`.

**Expected — what a correct system would do** The named structure is assigned,
a first invoice is raised, and a roll number is allocated by a rule.

**Expected today, and the assertions that must fail**
- `enrolRequest.FeeStructureID` is declared (`mod_admissions.go:490`) and
  **read by nothing** in the handler body — the field is accepted and silently
  discarded. Assert that no `fee_structures` link, no `invoices` row and no
  `fee_structure_items` copy exists for the student.
- The ledger returns `charged_paise: 0`, `paid_paise: 0`, `balance_paise: 0`,
  empty `dues`. The doc comment above the handler
  (`mod_admissions.go:495-499`) promises "the student, the enrolment and the
  first invoice in one transaction"; the invoice half is absent.
- `enrollments.roll_no` is NULL. The INSERT (`mod_admissions.go:572-577`) does
  not list the column. The only writers anywhere are the manual form field
  (`students_write.go:210`) and the CSV importer (`students_write.go:464`).

**Negative** Omit `academic_year_id`: the handler falls back to
`ORDER BY is_current DESC, starts_on DESC LIMIT 1` (`mod_admissions.go:562-568`).
With two years alive (AF-08), confirm which year the child lands in — a November
admission for next year silently enrols into the *current* year unless the
caller passes the id, and the screen (`Applications.tsx:107`) never does.

**Known gap** `02_onboarding_daily.md` §"Student onboarding", P0, and §2 (roll
numbers), P1.

---

### AF-14 — KNOWN BROKEN: verified documents stay attached to the closed application

| | |
|---|---|
| **Roles** | Admissions counsellor (verifies), Registrar (enrols), Institution Admin (later asked for the file) |
| **Features** | `admissions.applications.applicant_documents`, `admissions.admissions.transfer_certificate_intake`, `admissions.admissions.aadhaar_apaar_capture_at_admission` |
| **Endpoints** | `POST /admissions/applications/patch` (`api.go:334` → `admissions_funnel.go:347`, APAAR/Aadhaar at `:369-372`); `POST /admissions/workflow/applications/{id}/enrol` (`api.go:404`); `GET /students/{id}/profile` (`api.go:85`) |

**Setup** AF-11, with the applicant's birth certificate and previous-school TC
uploaded and marked verified against the application, and
`apaar_id` / `aadhaar_last4` patched onto the application.

**Steps**
1. Registrar enrols the applicant.
2. Institution Admin opens the student profile and looks for the documents.

**Expected today** The `student_documents` table is empty for this child.
`grep -rn "INSERT INTO student_documents" internal/` returns nothing — no code
path moves a verified document from the application to the student. The APAAR id
patched at `admissions_funnel.go:371` likewise stays on `applications`; the
student's own `apaar_id` is set only by `POST /compliance/apaar`
(`api.go:496`). Assert both, and assert that the TC snapshot in AF-36 will
therefore read `apaar_id: null` unless someone re-keys it.

**Known gap** `02_onboarding_daily.md`, "Document verification", P1.

---

### AF-15 — KNOWN BROKEN: the guardian created at handoff can never log in

| | |
|---|---|
| **Roles** | Registrar, Super Admin, Parent |
| **Features** | `super_admin.access_security.user_directory`, `parent.fees.*`, `institution_admin.communication.circulars_announcements` |
| **Endpoints** | `POST /admissions/workflow/applications/{id}/enrol` (`api.go:404` → guardian insert `mod_admissions.go:589`); `POST /admin/users` (`internal/api/users.go:119`); `GET /portal/students` (`api.go:268` → `listMyStudents`); `GET /portal/fees` (`api.go:276` → `portal_family.go:83`); `POST /communication/circulars` (`api.go:481`) |
| **Screen** | `web/src/features/portal/Fees.tsx:70`, `web/src/features/super_admin/Users.tsx` |

**Setup** AF-11 in a **real** (non-demo) tenant.

**Steps**
1. Registrar enrols the applicant; a `guardians` row is created.
2. Super Admin creates a user account for the parent with a parent role.
3. Super Admin attempts to link that user to the guardian record.
4. Parent signs in and opens `GET /portal/students`, then `GET /portal/fees`.
5. Institution Admin publishes a circular to guardians and reads the reported
   reach.

**Expected today** Step 3 has **no endpoint**. `createUser`
(`users.go:119-215`) has no guardian concept, and `guardians.user_id` is written
by exactly one file in the repository, `cmd/migrate/demo.go:261`. Step 4
therefore returns an empty child list and the fee screen has nothing to show.
Step 5 reports a blast radius of zero: recipient resolution requires
`g.user_id IS NOT NULL` (`mod_ops.go:54`, `:83`, `:103`).

**The one thing that still works, and must be asserted separately** The newer
messaging path resolves guardians by `email`/`phone` and tolerates a NULL
`user_id` (`messaging.go:1665-1671`). So the fee reminder in AF-38 *does* reach
the family by SMS — while linking them to an app they cannot enter. Assert both
halves; they are the same bug seen from two ends.

**Negative** Two guardians sharing one handset cannot both hold accounts:
`users_institution_phone` is unique (`migrations/00001_baseline.sql:2226`).
The messaging code documents the collapse honestly at
`message_rules.go:819-830`.

**Known gap** `00_TIMELINE.md` finding 1; `02_onboarding_daily.md` §1, P0.
**Every test below whose final step is "the parent sees it" is blocked by this
and is executable only against a demo-seeded tenant or by direct SQL.**

---

### AF-16 — KNOWN BROKEN: transport is allocated, the fare is computed, and nothing bills it

| | |
|---|---|
| **Roles** | Institution Admin (transport office), Finance, Parent |
| **Features** | `institution_admin.transport.student_allocation`, `.route_distance_fee_slabs`, `finance.fee_structure.demand_invoice_generation`, `parent.my_childs_bus.transport_snapshot` |
| **Endpoints** | `POST /ops/transport/allocations` (`api.go:580` → `transport_office.go:209`); `GET /ops/transport/allocations` (`api.go:579`); `POST /fees/invoices/generate` (`api.go:315` → `fees.go:575`); `GET /fees/students/{id}/ledger` (`api.go:308`) |
| **Screen** | `web/src/features/operations/TransportOffice.tsx` |

**Setup** AF-11's student; a route with a stop carrying `fare_paise` =
1200000 (₹12,000); the AF-01 fee structure; a second student in the same class
who does **not** take the bus.

**Steps**
1. Transport office posts an allocation for the bus child.
2. Transport office re-allocates the same child to a different stop on the same
   route a month later.
3. Finance runs demand generation for the class.
4. Finance opens both children's ledgers.

**Expected** Step 1 → 201 `{"fare_paise": 1200000}`. Step 2 closes the previous
allocation with `valid_to = current_date - 1` rather than deleting it
(`transport_office.go:246-252`) — assert the old row survives, because the fee
already raised against it has to stay explicable.

**Expected today, and the assertion that must fail** After step 3 the two
ledgers are **identical**. `raiseInvoices`/`generateInvoices` copies lines from
`fee_structure_items` only (`fees.go:677`); there is no per-student component of
any kind. `fare_paise` is returned to the screen at `transport_office.go:270`
and discarded. The catalogue promises "auto-apply them to the student's fee
structure" (`internal/catalog/catalog_gen.go:465`). The test passes when the bus
child's invoice is ₹12,000 higher than the walker's.

**Negative** Post an allocation whose `pickup_stop_id` is on a different route →
400 "that stop is not on that route" (`transport_office.go:263`, checked at
`:235`). Note the allocation's `academic_year_id` is resolved as
`SELECT id FROM academic_years WHERE is_current LIMIT 1`
(`transport_office.go:257`) with no override — allocating next year's bus in
March writes it against this year. A user with `operations.transport.read` only
→ 403 (`api.go:580`). The parent cannot see the route at all:
`parent.my_childs_bus.transport_snapshot` is `deferred`.

**Known gap** `00_TIMELINE.md` JUN; `02_onboarding_daily.md` §3, P0 for finance.

---

## The money

### AF-17 — Demand generation raises one invoice per active enrolment, and the arithmetic holds

| | |
|---|---|
| **Roles** | Finance |
| **Features** | `finance.fee_structure.demand_invoice_generation` |
| **Endpoints** | `POST /fees/invoices/generate` (`api.go:315` → `fees.go:575`); `GET /finance/invoices` (`api.go:299`); `GET /fees/students/{id}/ledger` (`api.go:308` → `fees.go:68`) |
| **Screen** | `web/src/features/finance/DemandGeneration.tsx` |

**Setup** AF-01's structure (Tuition ₹3,00,000 + Development ₹50,000, instalment
1) and three active Class 1 enrolments in 2026-27. One further student enrolled
in Class 2. One Class 1 student with enrolment status `transferred`.

**Steps**
1. Finance posts `{"fee_structure_id": …, "instalment_no": 1, "due_on": "<+14d>"}`.
2. Finance reads one student's ledger.

**Expected** 201 `{"created": 3}` — the Class 2 child is excluded by the
structure's `class_id` filter and the transferred child by
`e.status = 'active'` (`fees.go:613-617`). Each invoice: `gross_paise`
**35000000**, `discount_paise` **0**, `fine_paise` **0**, and the generated
column `net_paise` = gross − discount + fine = **35000000**
(`migrations/00001_baseline.sql:810`). The header is rolled up from the lines,
never written directly (`fees.go:686-692`). `invoice_no` values are consecutive
from the gapless allocator (`fees.go:641`). The ledger shows
`charged_paise: 35000000`, `paid_paise: 0`, `balance_paise: 35000000`, one due
row with `balance_paise: 35000000` and `days_overdue: 0`.

**Negative** A `fee_structure_id` that is inactive or nonexistent → 400 "no
active fee structure with that id" (`fees.go:698`). `due_on: "14/04/2026"` →
400 "due_on must be YYYY-MM-DD" (`fees.go:593`). A user with
`finance.invoices.read` but not `.write` → 403 (`api.go:315`).
`instalment_no: 0` is coerced to 1 (`fees.go:588`) — assert it does not create a
zeroth instalment.

---

### AF-18 — Demand generation is safe to re-run

| | |
|---|---|
| **Roles** | Finance |
| **Features** | `finance.fee_structure.demand_invoice_generation` |
| **Endpoints** | `POST /fees/invoices/generate` (`api.go:315` → `fees.go:575`, skip clause `fees.go:618-622`) |

**Setup** AF-17 completed.

**Steps**
1. Finance posts the identical request again (the browser was refreshed).
2. Finance posts it with `instalment_no: 2`.
3. Finance counts invoices per student.

**Expected** Step 1 → 201 `{"created": 0}`; the `NOT EXISTS` on
`(student_id, academic_year_id, instalment_no)` (`fees.go:618-622`) skips every
student. Step 2 → `{"created": 3}`. Step 3: exactly two invoices per student,
total charged **70000000** paise. No student is billed twice for instalment 1.

**Negative** Note that `skipped` is declared and never incremented
(`fees.go:598`, returned at `fees.go:706`) — the response always reports
`"skipped": 0` even when it skipped three. Log this; a cashier reading
`created: 0, skipped: 0` cannot tell "already done" from "nobody matched".

---

### AF-19 — Payment in full at the counter: receipt, allocation, ledger

| | |
|---|---|
| **Roles** | Parent (pays), Finance cashier (records) |
| **Features** | `finance.collections.collect_payment`, `finance.collections.receipts`, `finance.student_dues.student_ledger` |
| **Endpoints** | `POST /fees/payments` (`api.go:309` → `fees.go:233` → `fees.Collect`, `internal/fees/fees.go:290`); `GET /fees/receipts/{id}` (`api.go:310` → `fees.go:338`); `GET /fees/students/{id}/ledger` (`api.go:308`) |
| **Screen** | `web/src/features/finance/FeeCounter.tsx:78` |

**Setup** AF-17: one invoice, `net_paise` 35000000, unpaid.

**Steps**
1. Cashier posts `{"student_id": …, "amount_paise": 35000000, "mode": "cash"}`.
2. Cashier opens the returned `receipt_url`.
3. Cashier reloads the ledger.

**Expected** Step 1 → 201 with a `receipt_no`, `amount_paise: 35000000`,
`allocated` naming the one invoice for the full amount, `unallocated_paise: 0`,
`cleared: true`. Step 2 returns `amount_words` = "Three Lakh Fifty Thousand
Rupees Only" (`internal/fees/words.go:14`) — the conversion happens at the edge,
and the stored value stays paise. `financial_year` reads "2026-27"
(`fees.FinancialYear`, `internal/fees/fees.go:189`). Step 3: `paid_paise`
35000000, `balance_paise` 0, the invoice's status flipped to `paid` by the
`sync_invoice_paid` trigger, not by handler code (`internal/fees/fees.go:405-407`).

**Negative** `amount_paise: 0` or negative → 400 (`fees.go:246`). `mode: "gpay"`
→ 400 "unsupported payment mode" (`fees.go:250`, vocabulary `fees.go:226`).
`mode: "cheque"` with no `reference_no` → 400 (`fees.go:271`). A cashier holding
`finance.payments.read` but not `.write` → 403 (`api.go:309`). Collecting
against a `student_id` belonging to another institution: the tenant scope makes
the student lookup return no rows → 404 (`fees.go:296`, `:306`).

---

### AF-20 — A part payment allocates oldest first

| | |
|---|---|
| **Roles** | Finance cashier |
| **Features** | `finance.collections.partial_advance_payments`, `finance.student_dues.student_ledger` |
| **Endpoints** | `POST /fees/payments` (`api.go:309` → `internal/fees/fees.go:358` `allocate`, ordering from `Outstanding`, `internal/fees/fees.go:215` / `:223`) |

**Setup** One student with three unpaid invoices in this order:
INV-1 due 2026-04-15 `net_paise` 10000000 (₹1,00,000);
INV-2 due 2026-07-15 `net_paise` 10000000;
INV-3 due 2026-10-15 `net_paise` 10000000.
Total owed **30000000**.

**Steps**
1. Cashier collects `amount_paise: 15000000` (₹1,50,000) in cash, with no
   `invoice_ids`.
2. Cashier reads the ledger.
3. Cashier collects a further `amount_paise: 5000000` naming **only INV-3** in
   `invoice_ids`.

**Expected** Step 1 allocates INV-1 **10000000** in full, then INV-2
**5000000**, and INV-3 nothing. `unallocated_paise: 0`. The ordering is
`COALESCE(due_on, issued_on), invoice_no` (`internal/fees/fees.go:223`), so an
invoice with a NULL due date sorts by its issue date, not last. Step 2:
`paid_paise` 15000000, `balance_paise` 15000000; INV-1 status `paid`, INV-2
`partial` with `balance_paise` 5000000, INV-3 `unpaid`. Step 3 allocates
5000000 to INV-3 only, leaving INV-2 still owing 5000000 — the caller's explicit
selection overrides oldest-first (`internal/fees/fees.go:365-380`).

**Negative** Collect naming an `invoice_ids` array of invoices that are all
already settled → 400 "none of the selected invoices are outstanding for this
student" (`fees.go:311`, `ErrInvoiceNotFound` raised at
`internal/fees/fees.go:376`). Name another child's invoice: `Outstanding` is
keyed on this student, so the filter yields nothing → same 400, and **no
cross-child allocation is possible**. Assert this explicitly; it is the
wrong-child case.

---

### AF-21 — Paying twice does not double-credit, and an overpayment stays unallocated

| | |
|---|---|
| **Roles** | Finance cashier |
| **Features** | `finance.collections.collect_payment`, `finance.collections.partial_advance_payments` |
| **Endpoints** | `POST /fees/payments` (`api.go:309` → `internal/fees/fees.go:290`, `:358`) |

**Setup** AF-19 completed: one invoice of 35000000, fully paid, status `paid`.

**Steps**
1. Cashier posts the identical collect request again (double-click, or the
   parent pays twice).
2. Cashier reads the ledger.
3. Cashier posts a third payment of 100 paise.

**Expected** Step 1 → 201 with a **new** receipt number and a **new** payment
row of 35000000, but `allocated: []` and `unallocated_paise: 35000000` — the
invoice is settled, so `Outstanding` returns nothing to allocate against
(`internal/fees/fees.go:215`, loop at `:387-407`). Step 2 is the arithmetic that
matters: `charged_paise` 35000000, `paid_paise` **70000000**, `balance_paise`
**−35000000**. The invoice's `paid_paise` remains 35000000 — it is **not**
double-credited, because only allocation rows drive it. The school now holds
₹3,50,000 of unallocated advance and the ledger shows it as a negative balance.

**Assert precisely** the invoice was not double-credited (the important
guarantee) **and** that nothing warns the cashier they have taken a duplicate
payment (the defect to log). There is no idempotency key on `POST /fees/payments`
and no duplicate-window check.

**Negative** Step 3's 100 paise likewise lands wholly unallocated. Confirm the
`payments_check` constraint tolerates `allocated_paise < amount_paise`
(documented at `internal/fees/fees.go:354-357`) rather than rejecting the row.

---

### AF-22 — The receipt series is gapless within a financial year, resets on 1 April, and honours the payment date

| | |
|---|---|
| **Roles** | Finance cashier, Finance controller (audit) |
| **Features** | `finance.collections.gst_compliant_receipt_numbering`, `finance.collections.receipts` |
| **Endpoints** | `POST /fees/payments` (`api.go:309` → `NextNumberOn`, `internal/fees/fees.go:77`); `GET /finance/fee-engine/receipt-series` (`fee_engine.go:74` → `fee_engine.go:1406`, gap arithmetic `:1436-1443`); `PUT /finance/fee-engine/receipt-series/{kind}` (`fee_engine.go:75`) |
| **Screen** | `web/src/features/finance/ReceiptSeries.tsx` |

**Setup** A tenant whose receipt scheme has `reset_yearly: true` and
`current_fy: "2026-27"`, `next_value: 1`.

**Steps**
1. Cashier takes five payments dated in June 2026.
2. Controller reads the receipt series.
3. Cashier attempts a payment that fails mid-transaction (post with a
   `student_id` from another tenant so the transaction rolls back after the
   number would have been drawn).
4. Cashier takes a sixth payment.
5. Cashier records a payment with `paid_on: "2027-03-31"`, then one with
   `paid_on: "2027-04-01"`.
6. Cashier records a payment on 2027-04-02 back-dated to `paid_on: "2027-03-31"`.
7. Controller re-reads the series.

**Expected**
- Steps 1–2: receipts 1…5, rendered `RCPT/2026-27/00001`…`00005`
  (`renderNumber`, `internal/fees/fees.go:154`). The series report shows
  `first_seq: 1`, `last_seq: 5`, `issued: 5`, **`gaps: 0`** — the report computes
  `max − min + 1 − count` (`fee_engine.go:1439`).
- Steps 3–4: the sixth successful payment is **00006**, not 00007. The number is
  drawn under `SELECT … FOR UPDATE` inside the caller's transaction
  (`internal/fees/fees.go:105-113`), so a rollback returns the number. `gaps`
  stays 0. A sequence would have leaked one; assert it did not.
- Step 5: 2027-03-31 continues the 2026-27 series; 2027-04-01 restarts at
  **00001** under FY `2027-28` (`internal/fees/fees.go:120-129`).
- Step 6: the back-dated receipt is numbered in the **closing** year's series,
  because `Collect` passes `req.PaidOn` to `NextNumberOn`
  (`internal/fees/fees.go:309`), not the wall clock.

**Negative** Run steps 1's five payments concurrently from two terminals: the
row lock serialises them and no number is issued twice. Change the format via
`PUT /finance/fee-engine/receipt-series/receipt` mid-year and confirm previously
issued numbers are untouched (they are stored on `payments.receipt_no`), then
confirm the series report still reads gapless — `receipt_seq` is stored apart
from the rendered string precisely so the audit does not parse a format the
school may change (`internal/fees/fees.go:263-268`). A user without
`finance.fees.write` attempting the PUT → 403 (`fee_engine.go:75`).

---

### AF-23 — Post-dated cheque: held, then cleared, then dishonoured

| | |
|---|---|
| **Roles** | Parent, Finance cashier, Finance controller |
| **Features** | `finance.collections.collect_payment`, `finance.student_dues.student_ledger` |
| **Endpoints** | `POST /fees/payments` (`api.go:309`); `GET /fees/pdc` (`api.go:313` → `fees.go:484`); `POST /fees/payments/{id}/clear` (`api.go:311` → `fees.go:430` → `internal/fees/fees.go:416`); `POST /fees/payments/{id}/bounce` (`api.go:312` → `fees.go:448` → `internal/fees/fees.go:440`) |
| **Screen** | `web/src/features/finance/PDCRegister.tsx` |

**Setup** One unpaid invoice of 10000000 paise.

**Steps**
1. Cashier collects `mode: "cheque"`, `amount_paise: 10000000`,
   `reference_no: "112233"`, `cheque_date` one month ahead.
2. Cashier reads the ledger and the PDC register.
3. Controller clears the cheque.
4. On a second student, repeat step 1, then bounce the cheque with
   `fine_paise: 50000` (₹500).

**Expected** Step 1 → 201 with `cleared: false` and `allocated: []`; the payment
is `pending` and deliberately unallocated, because the money is not the school's
yet (`internal/fees/fees.go:299-304`). Step 2: the ledger shows
`pending_paise: 10000000` **separately from** `paid_paise: 0`
(`fees.go:112-120`) — promised money must not inflate collection. `balance_paise`
is still 10000000. The PDC register lists the cheque with `due_today: false`.
Step 3: status `success`, the allocation now exists, `paid_paise` 10000000.
Step 4: the invoice reopens and the ₹500 penalty is levied on the student's
**oldest** open invoice (`internal/fees/fees.go:464`); assert the fine landed on
the oldest, not the one the cheque was against, when the two differ.

**Negative** Clear a payment that is already `success` → 400 from the fees
package surfaced at `fees.go:441`. Bounce with no body: `fine_paise` defaults to
0 and the invoice still reopens (`fees.go:455-459`). A user with
`finance.payments.read` clearing a cheque → 403 (`api.go:311`).

---

### AF-24 — The defaulter ageing buckets are arithmetically right

| | |
|---|---|
| **Roles** | Finance |
| **Features** | `finance.student_dues.defaulters_reminders`, `finance.student_dues.student_ledger` |
| **Endpoints** | `GET /fees/defaulters` (`api.go:314` → `fees.go:521`) |
| **Screen** | `web/src/features/finance/Defaulters.tsx` |

**Setup** Four students, each with one unpaid invoice of 10000000 paise, due
respectively 20, 45, 75 and 120 days ago. A fifth student with an invoice due 10
days in the **future**. A sixth whose invoice is fully paid.

**Steps**
1. Finance reads the defaulters list.

**Expected** Four rows only. Buckets: `0-30`, `31-60`, `61-90`, `90+`
(`fees.go:528-534`) — note the boundaries are strict `>`, so exactly 30 days
lands in `0-30` and exactly 31 in `31-60`; test the boundary explicitly at 30,
31, 60, 61, 90, 91. `balance_paise` is `sum(net_paise − paid_paise)`
(`fees.go:528`) and the `HAVING > 0` (`fees.go:551`) drops the paid student.
The future-dated invoice is excluded by
`due_on < CURRENT_DATE` (`fees.go:549`). Each row carries the **primary**
guardian's name and phone (`fees.go:543-548`) — the only useful next action from
this screen.

**Negative** A student with two overdue invoices appears once with the sum, and
`oldest_due` / `days_overdue` come from `min(due_on)`. A student with a NULL
`due_on` is excluded entirely (`fees.go:549`) — assert this, because an invoice
with no due date can never become a defaulter. The list is capped at 500
(`fees.go:553`); a school with 900 defaulters silently sees 500.

---

### AF-25 — A late fine is previewed, applied once, and waived

| | |
|---|---|
| **Roles** | Finance (policy), Finance clerk (levy), Finance controller (waiver) |
| **Features** | `finance.fee_structure.fee_structure_versioning` (fine rules), `finance.student_dues.defaulters_reminders` |
| **Endpoints** | `GET /finance/fee-engine/fine-rules` + `POST` (`fee_engine.go:62`, `:63`); `GET /finance/fee-engine/fines/preview` (`fee_engine.go:68`); `POST /finance/fee-engine/fines/apply` (`fee_engine.go:69` → `fee_engine.go:1167`); `GET /finance/fee-engine/fines/charges` (`fee_engine.go:70`); `POST /finance/fee-engine/fines/charges/{id}/waive` (`fee_engine.go:71`) |
| **Screen** | `web/src/features/finance/LateFineRules.tsx` |

**Setup** AF-24's 45-day-overdue invoice of 10000000 paise. A fine rule of, say,
₹50 per day with a 10-day grace and a cap.

**Steps**
1. Finance saves the rule.
2. Clerk previews fines for that invoice at a stated `as_of`.
3. Clerk applies fines naming that invoice id.
4. Clerk applies the identical request a second time.
5. Controller waives the charge.

**Expected** The preview computes and shows its working, and **writes nothing**
(`fee_engine.go:68` comment). Step 3 writes a `fee_fine_charges` row whose
`working` records the derivation, and the invoice's `fine_paise` rises, so
`net_paise` = gross − discount + fine rises by the same amount
(`migrations/00001_baseline.sql:810`) — check that the parent's balance moved by
exactly the fine, not by a rounded rupee figure. Step 4 must apply a **delta**,
not a second full charge: the handler skips rows where `DeltaPaise <= 0`
(`fee_engine.go:1210`) — assert the second run reports `applied: 0`,
`skipped: 1`. Step 5 reverses it and the balance returns.

**Negative** `POST /fines/apply` with an empty `invoice_ids` → 400 "name the
invoices to fine — applying to everything at once is not offered"
(`fee_engine.go:1174`). Configuring a rule needs `finance.fees.write`; levying
needs `finance.invoices.write` (`fee_engine.go:46-51`) — assert the clerk who
runs the sweep cannot edit the policy, and vice versa.

---

### AF-26 — Wrong role and wrong child at the counter

| | |
|---|---|
| **Roles** | Faculty, Admissions, Parent, Finance |
| **Features** | `finance.student_dues.student_ledger`, `parent.fees.digital_fee_receipt_pdf_download` |
| **Endpoints** | `GET /fees/students/{id}/ledger` (`api.go:308` → `fees.go:68`, scope at `fees.go:83`); `POST /fees/payments` (`api.go:309`); `GET /portal/receipts` (`portal_requests.go:85` → `portal_requests.go:1171`) |

**Setup** Two families, each with one child and an outstanding invoice. A
demo-seeded parent account linked to family A (see AF-15 — in a real tenant this
account cannot exist).

**Steps**
1. A teacher with no finance grant opens family A's ledger.
2. Parent A opens their own child's ledger.
3. Parent A opens **family B's** child's ledger by substituting the uuid.
4. Parent A posts to `/fees/payments` for their own child.
5. An admissions user posts a payment.

**Expected** Step 2 succeeds — the ledger route is deliberately outside the
finance permission and narrowed by scope instead (`api.go:305-308`, resolver at
`fees.go:83`). Step 3 → **404**, not 403: the scope predicate makes the row
invisible rather than forbidden, which is the correct shape here. Step 4 → 403;
`POST /fees/payments` requires `finance.payments.write` (`api.go:309`) and no
parent role holds it. Step 5 → 403 likewise. Step 1: a teacher holding
`students.read` but no finance grant reaching a ledger by student id must be
narrowed by the same resolver — assert they see only children they teach, or
404.

**Negative** `GET /portal/receipts` as parent A returns A's receipts only.

---

## Concessions

### AF-27 — KNOWN BROKEN: a concession cannot be applied for

| | |
|---|---|
| **Roles** | Parent / Admissions (would apply), Finance (approves) |
| **Features** | `finance.concessions_refunds.discounts_scholarships`, `finance.concessions_refunds.multi_level_concession_approvals` |
| **Endpoints** | `GET /fees/concessions` (`api.go:316` → `fees.go:735`); `GET /workflow/approvals` (`api.go:154` → `mod_workflow.go:345`, concession block `:474-500`); `POST /workflow/concessions/{id}/decide` (`api.go:161` → `mod_workflow.go:519`) |
| **Screen** | `web/src/features/finance/Concessions.tsx` |

**Setup** A tenant with fee heads and a student.

**Steps**
1. Search the API for any route that creates a `fee_concessions` row.
2. Insert one directly by SQL (`student_id`, `academic_year_id`, `kind:
   'sibling'`, `percent: 25.00`, `reason`), leaving `approved_by` NULL.
3. Finance reads `/fees/concessions` and `/workflow/approvals`.
4. Finance approves it.
5. Finance rejects a second one.

**Expected — the assertion that must fail** Step 1 finds **nothing**.
`grep -rn "INSERT INTO fee_concessions" internal/ cmd/` returns no production
writer; the only statements against the table are one UPDATE for approval
(`mod_workflow.go:544`), one DELETE for rejection (`mod_workflow.go:534`) and
reads. The "applied for" half of "applied for → approved → reflected in what the
family owes" **does not exist as an endpoint**. The test is executable from
step 2 onward only.

**Expected from step 3** The concession appears with status derived, not stored:
`pending` while `approved_by IS NULL` (`fees.go:742`). It appears in the
approvals queue only for a caller holding `finance.fees.write`
(`mod_workflow.go:474`). Step 4 → 200, `approved_by` and `approved_at` set.
Step 5 **deletes the row** (`mod_workflow.go:534`) — a rejected concession leaves
no record that it was ever asked for. Log this: an audit cannot see refusals.

**Negative** Approve the same concession twice: the second → 404 "no pending
concession with that id", because the UPDATE is guarded by
`approved_at IS NULL` (`mod_workflow.go:545`). This is the double-submit case
and it is handled correctly. A user without `finance.fees.write` deciding → 403
(`api.go:161`).

**Known gap** Not previously named in the gap analysis; found here. The catalogue
lists `discounts_scholarships` as **built**, and the read/approve/report halves
are — the create half is not.

---

### AF-28 — An approved concession reduces what is owed, not what was billed

| | |
|---|---|
| **Roles** | Finance |
| **Features** | `finance.concessions_refunds.discounts_scholarships`, `finance.fee_structure.demand_invoice_generation` |
| **Endpoints** | `POST /fees/invoices/generate` (`api.go:315` → `fees.go:575`, concession clause `fees.go:661-679`); `GET /fees/students/{id}/ledger` (`api.go:308`) |

**Setup** AF-01's structure: Tuition 30000000, Development 5000000. Student S
with an **approved** concession of 25% on the **Tuition head only**. Student T
with an approved flat concession of 1000000 paise (₹10,000) and no fee head
named. Student U with a 25% concession that is **not** approved. All three
enrolled in the same class and year.

**Steps**
1. Finance generates the demand for instalment 1.
2. Finance reads each invoice's lines and header, and each ledger.

**Expected — the arithmetic**
- **S**: Tuition line `amount_paise` **30000000**, `discount_paise`
  **7500000** (25% of 30000000, `round`ed — `fees.go:669`); Development line
  `amount_paise` 5000000, `discount_paise` **0**, because the concession names a
  head and the clause matches `fc.fee_head_id IS NULL OR = fsi.fee_head_id`
  (`fees.go:674`). Header: `gross_paise` **35000000**, `discount_paise`
  **7500000**, `net_paise` **27500000**. **What was billed is unchanged; what is
  owed fell.** This is the assertion the test exists for.
- **T**: the head-less concession applies to **every** line at its flat amount —
  Tuition discount 1000000 **and** Development discount 1000000, total
  `discount_paise` **2000000**, i.e. ₹20,000 given away against a ₹10,000
  sanction. Assert this: the `LEAST(fsi.amount_paise, …)` cap
  (`fees.go:665`) bounds each line, not the invoice, so a flat concession with no
  head is multiplied by the number of heads. **This is a money defect; record the
  exact figures.**
- **U**: no discount at all. The clause requires `fc.approved_at IS NOT NULL`
  (`fees.go:673`) — an unapproved concession must not reach a bill.

**Negative** Give S both a 25% and a flat ₹5,000 concession on Tuition: the
`COALESCE(max(fc.amount_paise), max(round(… percent …)))` (`fees.go:668-670`)
takes the **amount** and ignores the percentage entirely, even when the
percentage is larger. Assert the resulting discount is 500000, not 7500000, and
log it. Give S a flat concession larger than the Tuition line: `LEAST` caps it
at the line amount, so `discount_paise` never exceeds `amount_paise` and
`net_paise` cannot go negative — assert this holds.

**Cross-reference** `getFilingVariance` states the same principle from the
regulator's side: its charged figure is `invoice_lines.amount_paise`, "before
concessions, because a concession is the school remitting an approved fee and
not a lower fee" (`admin_ops.go:4356-4359`). The two must agree.

---

### AF-29 — "Multi-level concession approval" is one level

| | |
|---|---|
| **Roles** | Finance clerk, Finance head, Principal |
| **Features** | `finance.concessions_refunds.multi_level_concession_approvals` |
| **Endpoints** | `POST /workflow/concessions/{id}/decide` (`api.go:161` → `mod_workflow.go:519`) |

**Setup** AF-27's seeded pending concession, of a large amount.

**Steps**
1. A user holding `finance.fees.write` approves it.

**Expected today** One call, one approval, done. `fee_concessions` carries a
single `approved_by`/`approved_at` pair
(`migrations/00001_baseline.sql:546-547`); a grep for `concession_approval` or
`approval_level` across `migrations/` returns nothing. There is no ladder, no
value band, and no second signature — unlike purchasing, which has a real
value-banded ladder (`purchase_approval_thresholds`,
`POST /admin-ops/purchasing/requisitions/{id}/decide`, `admin_ops.go:178`).
The test passes only when a concession above a configured value requires a
second, higher approver.

**Negative** Confirm the same clerk who would have raised the concession (had a
create endpoint existed — AF-27) also holds the permission to approve it: both
are `finance.fees.write` (`api.go:161`). There is no separation of duty here.

---

## What was approved versus what is charged

### AF-30 — KNOWN BROKEN: a fee version activates with no filing and no approval

| | |
|---|---|
| **Roles** | Finance (drafts), Institution Admin (files), Finance (activates) |
| **Features** | `finance.fee_structure.fee_structure_versioning`, `institution_admin.fees.fee_regulatory_committee_filing` |
| **Endpoints** | `POST /finance/fee-engine/versions` (`fee_engine.go:56`); `PUT /finance/fee-engine/versions/{id}/items` (`fee_engine.go:57`); `POST /finance/fee-engine/versions/{id}/activate` (`fee_engine.go:58` → `fee_engine.go:531`); `POST /admin-ops/fee-filings` (`admin_ops.go:220`); `POST /admin-ops/fee-filings/{id}/submit` (`admin_ops.go:221`); `POST /admin-ops/fee-filings/{id}/decide` (`admin_ops.go:222`) |
| **Screens** | `web/src/features/finance/FeeStructureVersions.tsx`, `web/src/features/operations/FeeFiling.tsx` |

**Setup** AF-01's fee structure.

**Steps**
1. Finance creates version 2 as a draft and sets one item on it.
2. Finance activates version 2 **without creating any filing at all**.
3. Separately, Institution Admin creates a filing, submits it, and has it
   decided `approved_with_modification` with `approved_paise` lower than
   `proposed_paise` on one line.
4. Finance activates a version 3 whose amounts match the **proposed**, not the
   approved, figures.

**Expected — what a correct system would do** Step 2 refuses: no filing, no
activation. Step 4 refuses, or at least warns, because the version contradicts
the committee's decision.

**Expected today** Both activations return **200**. `activateStructureVersion`
(`fee_engine.go:531`) checks exactly three things: that the version is a draft
(`:551-556`), that it has at least one line (`:558-568`), and that the outgoing
active version is superseded cleanly (`:572-583`). It never queries
`fee_regulatory_filings`. There is no internal approval state either:
`fee_structure_versions.status` is only `draft | active | superseded`
(`migrations/00045_fee_engine.sql:73`), so a trust-board resolution has nowhere
to live. Assert both activations succeed and record it as the failure.

**Negative** Activate a draft with zero items → refusal "this revision has no
fee lines — it would bill nothing" (`fee_engine.go:567`). Activate a version
already active → refusal (`fee_engine.go:552`). Activating requires
`finance.fees.write` (`fee_engine.go:46`, `:58`).

**Known gap** `00_TIMELINE.md` finding 4; `01_pre_year.md` §1, P0.

---

### AF-31 — KNOWN BROKEN: no invoice ever names the version it was raised under

| | |
|---|---|
| **Roles** | Finance |
| **Features** | `finance.fee_structure.fee_structure_versioning`, `finance.fee_structure.demand_invoice_generation` |
| **Endpoints** | `POST /fees/invoices/generate` (`api.go:315` → `fees.go:575`); `GET /finance/fee-engine/structures` (`fee_engine.go:54` → invoice count at `fee_engine.go:129-133`); `GET /finance/fee-engine/structures/{id}/versions` (`fee_engine.go:55` → invoice count at `fee_engine.go:199-201`) |

**Setup** AF-30 with version 2 active, and AF-17's three invoices raised after
the activation.

**Steps**
1. Finance reads `/finance/fee-engine/structures`.
2. Finance reads that structure's versions.
3. Read `invoices.fee_structure_version_id` directly for the three invoices.

**Expected today** Steps 1 and 2 report `invoices_raised: 0` against every
version, even though three invoices were raised while version 2 was active.
Step 3 shows NULL on all three. The demand generator reads the **unversioned**
`fee_structure_items` (`fees.go:677`) and never populates the column; the only
production writer of `fee_structure_version_id` anywhere is the fine engine
writing it onto `fee_fine_charges` (`fee_engine.go:1221`). The `ON DELETE
RESTRICT` that guarantees "an invoice can always name the version it was raised
under" (`fee_engine.go:526-529`) therefore protects a column that is NULL on
every invoice the product produces. The test passes when
`invoices_raised` equals 3.

**Negative** The ad-hoc invoice path in `collections.go` does not set it either.
Confirm that deleting an active version is refused with
`invoices_fee_structure_version_id_fkey` handling (`fee_engine.go:1670`) — the
error path exists and can never fire.

---

### AF-32 — The filing variance report is the only reconciliation, and it enforces nothing

| | |
|---|---|
| **Roles** | Institution Admin, Finance, Principal |
| **Features** | `institution_admin.fees.fee_regulatory_committee_filing` |
| **Endpoints** | `GET /admin-ops/fee-filings/{id}/variance` (`admin_ops.go:224` → `admin_ops.go:4225`); `POST /fees/invoices/generate` (`api.go:315`) |
| **Screen** | `web/src/features/operations/FeeFiling.tsx` |

**Setup** AF-30 step 3's decided filing for 2026-27, naming Class 1, head
Tuition, instalment 1, `approved_paise` 25000000 (₹2,50,000). AF-17's invoices,
which charged 30000000 for the same head. The Development head was never filed.

**Steps**
1. Institution Admin opens the variance report for the filing.

**Expected** The report is real and computes the comparison the committee asks
for, joining charged to approved on `(class, fee_head, instalment)` — **not** on
`fee_structure_version_id`, which is why it works at all despite AF-31
(`admin_ops.go:4265-4300`). For Tuition: `verdict: "over_approved"`,
`variance_paise` **5000000**, `exposure_paise` = variance × students = 5000000 ×
3 = **15000000**. For Development: `verdict: "not_filed"`, `exposure_paise` =
charged × students = 5000000 × 3 = **15000000**. `over_approved: 1`,
`never_filed: 1`, `exposure_paise` **30000000**, and a summary sentence naming
₹3,00,000 of exposure (`admin_ops.go:4315-4345`).

**Expected — the failure to record** Nothing acts on this. Finance can re-run
demand generation for the same over-approved amount immediately afterwards and
no endpoint refuses. Assert that step 1's report and a subsequent successful
`POST /fees/invoices/generate` coexist. The question "did we charge what was
sanctioned" is *answerable* through this one report and *unenforced* everywhere
else.

**Negative** A filing with no `academic_year_id` → refusal "this filing names no
academic year, so there is nothing to compare it against" (`admin_ops.go:4256`).
A filing still at `draft` or `submitted` → the summary says so rather than
implying compliance (`admin_ops.go:4340`). Cancelled invoices are excluded from
"charged" (`admin_ops.go:4281`) — assert a cancelled bill does not create
phantom exposure.

**Known gap** `01_pre_year.md` §1, P0 — with the correction that the variance
report itself is present and good; what is missing is any gate that consumes it.

---

## Mid-year

### AF-33 — A child joins in September

| | |
|---|---|
| **Roles** | Registrar, Finance |
| **Features** | `institution_admin.students.student_admission`, `finance.fee_structure.demand_invoice_generation` |
| **Endpoints** | `POST /students` (`api.go:86` → `students_write.go:254`, section-capacity check `students_write.go:186-201`, guardian `:222-247`, roll no `:204-217`); `POST /fees/invoices/generate` (`api.go:315`); `POST /ops/transport/allocations` (`api.go:580`) |

**Setup** AF-17: three Class 1 students already invoiced for instalments 1 and
2. Section 1-A capacity 40, currently 40 filled.

**Steps**
1. Registrar posts a new student with `section_id` = 1-A, `roll_no: 41`,
   guardian name and phone.
2. Registrar retries against section 1-B (capacity 40, 30 filled).
3. Registrar retries 1-A with `allow_overflow: true`.
4. Finance runs demand generation for instalment 2.
5. Finance reads the new child's ledger.

**Expected** Step 1 → **409** `no_seats` with "1-A is full at 40 of 40. Choose
another section, or re-send with allow_overflow to admit anyway."
(`students_write.go:282-286`). Note this check *is* section-scoped and therefore
year-correct, unlike AF-08's class-level matrix — the two doors into the same
room disagree, and that is worth logging. Step 2 → 201 with an admission number
and `roll_no` 41 persisted (`students_write.go:210`) — **this path allocates a
roll number where the admissions handoff does not** (AF-13). Step 3 → 201,
overriding deliberately rather than silently. Step 4 raises **one** invoice for
the new child for instalment 2, and skips the three already billed
(`fees.go:618-622`). Step 5: the September joiner is billed instalment 2 and
**not** instalment 1 — assert the arrears for the part of the year before they
joined are simply absent. There is no pro-rating and no opening balance.

**Negative** Post the same student twice: the enrolment upsert is
`ON CONFLICT (student_id, academic_year_id) DO UPDATE`
(`students_write.go:213-217`), so a second post moves the section rather than
creating a second enrolment — assert exactly one active enrolment. A duplicate
APAAR id → 409 `apaar_already_used` (`students_write.go:289`). A user with
`students.read` only → 403 (`api.go:86`). Guardian reuse: post a sibling with
the same parent phone and name and confirm one guardian, two `student_guardians`
links (`students_write.go:229-247`) — and, per AF-15, still no login.

---

### AF-34 — A child leaves in November: the transfer certificate

| | |
|---|---|
| **Roles** | Parent (requests), Registrar (issues), Finance (dues) |
| **Features** | `institution_admin.students.transfer_certificate`, `admissions.admissions.transfer_certificate_intake` |
| **Endpoints** | `POST /lifecycle/certificates` (`api.go:474` → `mod_academics.go:811`); `GET /lifecycle/certificates` (`api.go:472` → `mod_academics.go:927`); `GET /fees/students/{id}/ledger` (`api.go:308`) |
| **Screen** | `web/src/features/lifecycle/Certificates.tsx` |

**Setup** AF-33's student, now with **one unpaid invoice of 10000000 paise**
outstanding, and attendance marked across the term.

**Steps**
1. Registrar issues a TC: `{"student_id": …, "type_code": "TC", "reason": "Family relocating"}`.
2. Registrar reads the certificate register.
3. Registrar reads the student and their enrolment.
4. Registrar issues a bonafide certificate for a second, current student.

**Expected** 201 with a `serial_no` from the gapless allocator
(`mod_academics.go:843`). The snapshot is frozen at issue and includes
`attendance_percent` and `dues_paise` computed inline
(`mod_academics.go:859-866`) — assert `dues_paise` reads **10000000**, so the
TC records that the family left owing. The student's status becomes
`transferred` with `exit_date` today, and the active enrolment is closed
(`mod_academics.go:884-892`). Step 2 lists it. Step 4 issues a BONAFIDE and does
**not** close that student's enrolment — the status change is guarded on
`type_code == "TC"` (`mod_academics.go:884`).

**Expected — the gaps to record**
- **There is no dues gate.** The TC is issued with ₹1,00,000 outstanding and
  nothing objects. Staff exits have a clearance gate enforced in the database;
  student exits do not.
- The snapshot carries 8 fields against roughly 20 a TC is prescribed to have,
  and `apaar_id` will be NULL unless AF-14's gap was worked around by hand.

**Negative** Issue a second TC for the same student: a second `issued_certificates`
row and a second serial are created with no objection — assert the duplicate and
log it. `type_code` for a type that does not exist creates the type on first use
(`mod_academics.go:829-841`); confirm this is intended rather than a typo
becoming a certificate class. A user with `students.read` only → 403
(`api.go:474`).

**Known gap** `00_TIMELINE.md` MAR: "TC carries 8 of ~20 prescribed fields, and
no dues gate."

---

### AF-35 — KNOWN BROKEN: the exit settlement cannot complete, because a refund cannot be recorded

| | |
|---|---|
| **Roles** | Finance, Parent |
| **Features** | `finance.concessions_refunds.refunds` |
| **Endpoints** | `GET /fees/refunds` (`api.go:317` → `fees.go:774`); `GET /fees/students/{id}/ledger` (`api.go:308` → refund leg `fees.go:187-192`) |
| **Screen** | `web/src/features/finance/Concessions.tsx` (`'/api/v1/fees/refunds'`) |

**Setup** AF-21's student, holding **35000000 paise of unallocated advance**
after a duplicate payment, now leaving on a TC.

**Steps**
1. Finance searches for any endpoint that creates or approves a refund.
2. Finance opens `/fees/refunds` and the student's ledger.
3. Insert a `refunds` row by SQL and re-read both.

**Expected — the assertion that must fail** Step 1 finds nothing.
`grep -rn "INSERT INTO refunds\|UPDATE refunds" internal/ cmd/` returns **no
rows**: the table has readers and zero writers. It carries a full status
vocabulary — `pending | approved | processed | rejected` — and `requested_by`,
`approved_by`, `processed_on`
(`migrations/00001_baseline.sql:1133-1147`), all unreachable. The
`finance.refunds.write` permission exists (`internal/rbac/rbac.go:45`) and gates
grant certificates and POS returns, never a fee refund. Step 2 returns an empty
list. Step 3 proves the read half works: the refund appears as a **debit** leg in
the chronological ledger (`fees.go:187-192`), so the display is ready and the
write is absent.

**Expected — the consequence to state plainly** The exit journey of AF-34 cannot
be completed inside the product. A leaving family owed ₹3,50,000 is refunded by
cheque outside the system, and the ledger never balances.

**Known gap** `00_TIMELINE.md` AUG: "refunds table is read-only. Exit settlement
cannot happen."

---

## Oversight

### AF-36 — The principal reads collection against outstanding

| | |
|---|---|
| **Roles** | Principal |
| **Features** | `principal.dashboard.*`, `finance.student_dues.student_ledger` |
| **Endpoints** | `GET /principal/dashboard` (`api.go:236` → `role_principal.go:40`) |

**Setup** A tenant with known figures: total invoiced 105000000 paise across
three students; 35000000 collected as `success` within the range; 10000000 held
as a `pending` cheque; one student overdue.

**Steps**
1. Principal reads the dashboard with a date range covering the collection.
2. Principal reads it with a range that excludes the collection date.

**Expected** `collected_paise` **35000000** in step 1 and **0** in step 2 — it is
a flow and takes the range (`role_principal.go:69-71`). The pending cheque is
**excluded** from collection (`status = 'success'` only), which must match the
ledger's treatment in AF-23. `outstanding_paise` is
`sum(net_paise − paid_paise)` over unpaid/partial/overdue
(`role_principal.go:72-73`) and is **identical in both steps** — it is a level,
and the response's `as_of` array names it as such (`role_principal.go:53-54`).
`defaulters` counts distinct students with an overdue due date
(`role_principal.go:74-76`) and must equal the row count from AF-24.

**Negative** A user without `reports.read` → 403 (`api.go:235`). Assert that
`outstanding_paise` does **not** shrink when the range narrows; "outstanding
between June and August" is not a smaller number, it is a meaningless one, and
the handler is explicitly built to refuse that reading.

---

### AF-37 — KNOWN BROKEN: intake cannot be judged against a target

| | |
|---|---|
| **Roles** | Principal, Admissions head |
| **Features** | `admissions.home.admissions_kpis`, `admissions.reports.admission_conversion_reports`, `super_admin.dashboard.central_admission_funnel_kpi` |
| **Endpoints** | `GET /admissions/dashboard` (`api.go:324` → `role_backoffice.go:162`); `GET /admissions/workflow/funnel` (`api.go:398` → `mod_admissions.go:640`); `GET /principal/dashboard` (`api.go:236`) |
| **Screen** | `web/src/features/admissions/Funnel.tsx`, `Dashboard.tsx` |

**Setup** The full funnel from AF-02 to AF-11: say 20 enquiries, 12
applications, 9 assessed, 6 offered, 4 enrolled.

**Steps**
1. Admissions head reads the dashboard and the funnel.
2. Principal looks for "60 seats intended in Class 1, 4 filled, 56 to go".

**Expected** Step 1's funnel returns five stages with counts
20 / 12 / 9 / 6 / 4 (`mod_admissions.go:642-650`) and the dashboard adds
`follow_ups` — enquiries whose `next_follow_up` has fallen due and which are not
yet applied or lost (`role_backoffice.go:174-176`). Both are correct **actuals**.

**Expected — the gap** Step 2 is impossible. No intake target or enrolment
projection column exists anywhere in the admissions schema; `sections.capacity`
is an operational cap, not a plan. `open_applications` on the principal's
dashboard (`role_principal.go:78-79`) is a level with no denominator. In
December, when a shortfall could still be acted on, the product can say what
happened and not whether it is enough.

**Also note** every count in `getAdmissionsFunnel` and `getAdmissionsDashboard`
is unfiltered by academic year or admission session. With next year's campaign
running alongside this year's teaching, the two intakes are summed into one
number.

**Known gap** `01_pre_year.md` §4, P1 ("everything is an actual; nothing is a
target"), plus the year-blindness of `00_TIMELINE.md` finding 2.

---

### AF-38 — The overdue reminder reaches a family that cannot log in

| | |
|---|---|
| **Roles** | Finance (policy), the scheduler, Parent |
| **Features** | `finance.student_dues.automated_fee_reminders`, `finance.student_dues.defaulters_reminders`, `parent.messages.communication` |
| **Endpoints** | `GET /admin/messaging/plans` + `POST` (`api.go:625` → `message_rules.go:971`, `:972`); `POST /admin/messaging/plans/{id}/preview` (`message_rules.go:974` → `:1386`); `POST /admin/messaging/plans/{id}/run` (`message_rules.go:975` → `:1427`); `POST /jobs` with `type: fee_reminder_fanout` (`api.go:147` → `jobs.go:78-81`); subjects at `message_rules.go:262`; guardian resolution at `messaging.go:1665` |
| **Screen** | `web/src/features/portal/Reminders.tsx` (parent side — see AF-15) |

**Setup** AF-24's four overdue students. A fee-reminder plan with
`first_after_days: 7`, `repeat_days: 7`, `max_attempts: 3`, audience
`guardians`, channel SMS.

**Steps**
1. Finance previews the plan.
2. Finance runs it.
3. Finance runs it again immediately.
4. One family pays in full; the scheduler's next sweep runs.
5. The parent opens the app to see the reminder.

**Expected** Step 1 lists one subject per overdue invoice, each carrying
`chase_no` derived from days overdue against the plan
(`chaseNumber`, `message_rules.go:345`), an `amount_due` rendered as
`"₹1,00,000.00"` from paise at the edge (`message_rules.go:326`), and the
90-day-overdue student **absent** if the cap of 3 attempts is exhausted
(`message_rules.go:305-311`). Draft, cancelled and paid invoices are excluded
(`message_rules.go:271-275`). Step 3 sends **nothing new**: the occurrence key is
`invoice_id#attempt` (`message_rules.go:315`), so the run is idempotent — this is
the double-submit case and it is handled correctly. Step 4: `cancelSettled`
(`message_rules.go:466`, called at `:569`) **withdraws** a queued message whose
reason has stopped being true, so a parent who paid yesterday is not chased
today.

**Expected — the parent half** Step 5 fails. The SMS is delivered, because
`audienceFor` reads `g.email, g.phone` and tolerates a NULL `user_id`
(`messaging.go:1665-1671`) — this is the one path that survives the login gap.
The parent then follows it to an app they cannot enter (AF-15). Assert the
message was sent **and** that `GET /portal/fees` is unreachable for that family.

**Negative** Running the plan needs `messages.send`; editing it needs
`settings.write` (`message_rules.go:967-969`) — the clerk who runs the sweep
cannot change the policy. Two guardians of one child with no portal login
collapse into a single send keyed on the child; the code documents this at
`message_rules.go:819-830`. Assert the family is not texted twice.

---

## Chains that could not be tested, because the endpoint does not exist

1. **A parent accepting an offer.** `applications.status` moves `offered` →
   `accepted` only inside `enrolApplicant` (`mod_admissions.go:604`). There is no
   applicant-facing acceptance, no acceptance deadline, and no lapse.
2. **Quoting an applicant the fee schedule before they accept.** `applications`
   carries only `form_fee_paise`/`form_fee_receipt`
   (`migrations/00026_admissions_funnel.sql:71`). An offer cannot carry the fee
   the family is deciding against, and there is no link from an offer to a fee
   structure.
3. **Applying for a concession.** No writer for `fee_concessions` exists
   (AF-27). Only approve, reject-by-delete and read.
4. **Recording, approving or paying a refund.** No writer for `refunds` exists
   (AF-35). Exit settlement is untestable end to end.
5. **Linking a guardian to a user account.** No endpoint sets
   `guardians.user_id` (AF-15). Every parent-facing acceptance criterion in this
   document is executable only against a demo-seeded tenant.
6. **Allocating or renumbering roll numbers.** No rule-based allocation at
   handoff or promotion, and no renumber action for a mid-year join (AF-13,
   AF-33).
7. **Carrying verified application documents to the student.** No
   `INSERT INTO student_documents` anywhere in `internal/` (AF-14).
8. **Billing a per-student charge of any kind** — transport fare, hostel, a
   one-off. The demand generator has no per-student component (AF-16).
9. **Reserving seats per quota.** Eight quota values on the application, one
   derived RTE figure in the matrix, no quota seat table (AF-10).
10. **Setting an intake target or an enrolment projection**, so no
    intake-against-target test can be written at all (AF-37).
11. **Carrying arrears across a year boundary.** No brought-forward, opening
    balance or arrears concept exists in the fee engine, so "a defaulter starts
    April owing nothing" cannot be tested as a pass — only observed.
12. **Closing a month or an academic year against edits.** `academic_years` has
    no status column, so no test can assert that last March is final.
