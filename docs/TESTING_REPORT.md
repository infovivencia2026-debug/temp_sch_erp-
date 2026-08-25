# Testing report

One file for what has been tested, how, and what is still wrong. Append to it;
do not start a second one.

Re-run the probe before editing this file — a report is worth what its last run
is worth, and the cross-role flows document went stale exactly this way.

```sh
cd web && UI_PROBE_PASSWORD='…' node ../scripts/ui_probe.mjs
```

---

## How the app is exercised

A real browser, signed in as each role, walking every path the app's own
navigation offers. `scripts/ui_probe.mjs`.

It reports rather than asserts. Nothing here fails a build; a number moving is a
question, not a verdict.

**Getting in.** Passwords are bcrypt over an HMAC with a server-side pepper, so
they cannot be read back out of the database — not by anyone, including whoever
set them. The supported path is the app's own operator command, which re-seeds
the ten demo logins with a password you choose:

```sh
/opt/temperp/migrate demo-users -password '…'
```

That changes the password for **all ten demo accounts**, so anyone using the
demo with an older one is locked out until it is run again.

**Why a browser and not more reading.** Every UI defect here up to 22 Aug was
found by a person describing a screenshot and me inferring a cause from the
code. That loop was wrong about as often as it was right: three "fixes" that day
addressed CSS rules which were correct, shipped, and being applied to elements
that were not on the page. A browser settles those questions in one run.

---

## Last run — 24 Aug 2026, against the live host

| | |
|---|---|
| Screens visited | **36** across 7 roles |
| Console errors | **0** |
| Failed network calls | **0** |
| Timeouts | **0** |
| Screens showing an empty state | 2 |
| Screens rendering under 400 characters | 6 |

Coverage by role: institution_admin 9, faculty 6, hr 5, parent 7, student 6,
admissions 2, finance 1.

**Coverage is uneven and that is a limitation of the probe, not a finding.** It
follows `<a href>` links, and the Bento dock renders most navigation as buttons,
so roles that live in the dock are under-walked. Finance shows one screen; it
has far more than one. Widening this is the next improvement to the probe.

---

## Audit of built screens — 24 Aug

Six agents read **84 screens** and proposed **109 enhancements to features that
already exist**. No new features, no new endpoints; the constraint was the point.

By kind: confirmation 23, feedback 18, validation 15, error 15, formatting 11,
filtering 7, empty-state 5, loading 4, accessibility 3, keyboard 3, copy 2,
navigation 2, bulk-action 1. By effort: 87 small, 21 medium, 1 large.

The filter stage of that workflow died on API 529s, so the list is unfiltered —
treat each item as a claim to check, not a verdict. Three claims were already
wrong when checked by hand: the Student 360 tab lag does not reproduce (the
indicator and the body read the same search param), Class setup opening on
"Classes" is deliberate and commented, and the "200 of 0 periods" case is
already special-cased.

### Fixed from that audit

| What | Where |
|---|---|
| A teacher's day was hardcoded fiction — "Math (10th Grade)", "Room 304", a roll of Alex/Ben/Chloe — at two menu entries | `faculty/TodaysClasses.tsx`, rewritten against `/timetable/entries?teacher_id=me` |
| Marking a cheque bounced reversed an applied payment on one click | `finance/Payments.tsx` |
| Approving a petty cash voucher paid out cash on one click | `finance/PettyCash.tsx` |
| Rejecting a concession, with no un-reject on the API | `finance/Concessions.tsx` |
| Raising invoices for a whole selection, with no bulk withdrawal | `finance/DemandGeneration.tsx` |
| The fee counter's Collect button went dead with no reason given | `finance/FeeCounter.tsx` |

### Still to do from that audit

~100 items, the bulk of them small. The clusters worth taking next, in order:

1. **Mutations whose error path is swallowed** — a save fails and the screen says
   nothing. Concentrated in admissions.
2. **Successful mutations with no confirmation** — the row changes and nothing
   says it worked.
3. **Search text in a react-query key**, so the whole page falls back to a
   full-page `<Loading />` on every keystroke.
4. **Sub-lists silently truncated with `slice()`** — no "and 12 more".
5. **Raw ISO dates in the ledger screens** where the rest of the product uses
   "16 Aug 2026".

---

## Open defects

Ranked by what a school notices first.

### 1. A raw event key is shown to parents
`/parent/home/real_time_push_notifications` renders `leave_decided` — the
notification's internal *kind* — where a sentence belongs. The title and body
the server sends are proper prose; something is rendering the kind instead.

### 2. Attendance reads as empty for a parent and a student
`/parent/attendance/attendance` and `/student/attendance/attendance` render
~350 characters and **zero controls** — a name and little else. Whether that is
an empty state or a broken query needs checking against a child who has
attendance recorded.

### 3. Still open from the 22 Aug sweeps
- The sidebar layout switch blanks the page for ~2s, then silently reverts; the
  second attempt works. A race, not polish.
- "Reset appearance" is unguarded and incomplete: no confirmation, and it does
  not reset dock sizes, widget layout or per-card colours.
- ~131 catalogue tiles open a screen built for something else. The registry maps
  204 catalogue entries onto 73 screens.
- Five features asked to be removed on 19 Aug are still catalogued: two AI exam
  features, two DigiLocker integrations, one biometric app lock.

---

## Fixed and verified

| What | Verified how |
|---|---|
| Marks could exceed their paper's maximum | 501 impossible marks cleared; highest is now 100.0%; API validation, a DB trigger and a `marks_over_paper_maximum` view all in place |
| Unrounded percentages ("87.66325536062378%") | probe checks every screen for `\d+\.\d{4,}%` — 0 found |
| The settings menu did nothing | dismiss handler now tests the portaled menu as well as its trigger |
| Cards clipped or overflowing the board | 0 clipped cells measured; board bottom 793px inside a 900px viewport |
| A teacher's screen showed invented data | probed live: 608 chars, "5 lessons on your timetable today", no fiction strings |
| HR's "Mark attendance" landed on "That screen has moved" | the feature was renamed to `staff_register`; all 19 `/go/` links now resolve against the catalogue |
| Demo accounts were all named "Demo institution_admin" | the seeder's upsert refreshed the password but never the name |
| `/go/` dead end offered no way onward | now names search and the reader's own home screen |

---

## Measured layout — 1600×900

| | measured |
|---|---|
| Board | 1565 × 772 |
| Columns | 5 at **308px** |
| Rows | 3 at **253px** |
| A 1×1 cell | **308 × 253** = **1.22 : 1** |
| A 2×2 cell | 622 × 513 |
| Clipped cells | 0 |

**A 1×1 is not square, and cannot be at this column count.** Three rows of 308px
plus gaps need 936px of board height and there are 772. Six columns would give
256 × 253 — square within 3px, three rows, no scrolling. That is a one-line
change to `BOARD_COLS`; it is not made here because it is a design decision.

---

## Corrections

Recorded because a wrong finding costs more than a missing one.

- **"The attendance register has no section picker."** It has one. The probe
  counted `<select>` elements and the picker is a custom combobox. The probe now
  counts `[role=combobox]` too.
- **"Cells are overflowing."** Twice this was the board running past the
  viewport, and once it was rows collapsing onto their contents. Three different
  causes reported under one word; measurement separated them.

---

## Run — 25 Aug 2026, parent, endpoint probe against the live host

A different method from the runs above, and worth saying so: not a browser walk
but a signed-in session calling, in order, every parameterless `GET` the
catalogue lists against this role's features. It answers "does the data behind
each screen come back" and says nothing about what the screen does with it. The
browser walks above remain the better instrument for the second question.

| | |
|---|---|
| Features in the catalogue | **10** |
| Endpoints probed | 9 |
| Answered 200 | **7** |
| Answered 403 | 2 |
| Failed / timed out | **0** |
| Slowest | 149ms (`/communication/circulars`) |

### The two 403s are catalogue metadata, not a broken screen

`/academics/sections` and `/academics/subjects` are listed against "Homework &
academics" and refuse a parent for want of `academics.read`. The screen does not
call them — the endpoint column is inherited from the shared staff screen the
feature is registered to. The same two appear on the Student's row for the same
reason.

Recorded so the next reader does not spend a morning granting a parent
`academics.read` to fix a screen that was never broken. **A feature's Endpoints
column in FEATURES.csv is what the screen file could reach, not what this role's
path through it actually calls.**

The equivalent probe against Institution Admin — 46 endpoints — returned 44×200
and 2×400, both of the 400s correct (`/hpc/card` and `/hpc/hall-ticket` require
a `student_id`). No role-scoped failure anywhere in that set.

### The report-card total: root cause, and a correction

The 25 Aug parent run recorded "the total is English alone… it is dropping rows
by some other rule". **That diagnosis is wrong, and the real one is worse.**

Read from the API and then from the database for the same child:

```
/portal/results  ->  card 17 / 400  ·  4.25%  ·  D2  ·  published
                     subjects: English 17/20 (A2), Social Studies 18/20
report_cards     ->  total_marks 17.00, created 2026-08-17 09:50
marks            ->  2 rows, summing 35.00
```

The card is not computing anything at request time. It is a **stored snapshot**
written by the generate-and-publish step in `mod_academics.go`, and it was
written on 17 August when English was the only subject with marks entered.
Social Studies was marked afterwards. Nothing recomputed the card and nothing
flagged it as behind.

So there is no rule dropping rows. There is a published number that was true
once. The subject list underneath it *is* read live, which is exactly why the
two disagree on screen — and why it looks like a summing bug.

Two separate defects sit behind the one symptom:

1. **A published card has no invalidation.** Marks entered after publication do
   not regenerate it, do not mark it stale, and do not warn the person entering
   them that a published card now contradicts their entry. The upsert in
   `mod_academics.go` means regenerating is cheap and correct — nothing calls it.
2. **The denominator is the whole exam; the numerator is whatever was entered.**
   `max_marks` sums every subject in the exam (400) while `total_marks` sums the
   marks that exist (17, via `LEFT JOIN marks`). A child with two papers marked
   out of an eleven-paper exam is published at 4.25% and graded D2. Regenerating
   this card today would produce 35/400 — 8.75%, still a D2, still wrong for the
   same reason.

The second is the one to fix first, and it is a product decision before it is a
code change: either a card refuses to publish while any subject is unmarked, or
it is scored against the papers actually marked and says how many that was. It
must not do what it does now, which is publish a real-looking failing grade to a
child and their parent.

### Not re-checked this run

The browser-only findings from the 25 Aug parent walk — "Language" opening
Appearance, "Absent 1 days", the "Good morning, Demo" greeting, the four
identical Meera Menon chips — are untouched by an endpoint probe and remain
open as recorded.

---

## Run — 25 Aug 2026, parent, real browser, catalogue-driven

`scripts/ui_probe.mjs` follows `<a href>` and the parent shell is a tab strip
and a launcher of BUTTONS, which is why the 24 Aug run reached 7 parent screens
and said so itself. This run takes the route list from `/api/v1/catalog` — the
same catalogue the SPA builds its own navigation from — and visits every one in
a real Chromium, hooking `console`, every response, and measuring `<main>`.

| | |
|---|---|
| Routes in this role's catalogue | **31** |
| Visited | **31** |
| Timeouts | **0** |
| Failed network calls | **1** |
| Console errors | **1** (the same one) |
| Unrounded percentages / `undefined` / `NaN` / raw snake_case | **0** |

### A correction to this report's own method

**17 of 31 parent screens render under 400 characters, and that number means
almost nothing here.** Two were opened and read in full:

`/parent/attendance/attendance` measures 300 characters and contains 96%
overall, 25 days marked, 24 present, 1 absent, and a month-by-month history
back to July. It is a complete screen. `innerText` on this shell is compact —
figures are short, labels are short, and a card that reads as substantial to a
person is 40 characters to a probe.

The earlier runs used the same threshold and drew conclusions from it. Where
those conclusions were checked by opening the screen they held; where they were
not, they are worth re-checking before anybody acts on them. **A character count
is a prompt to look, not a finding.**

### Found this run

1. **A parent is offered a control they cannot use, on Report an absence.**
   `/parent/attendance/child_absence_reporting_button` fires
   `GET /api/v1/setup/options?kind=absence_reason` on every load and gets **403,
   missing permission: institution.read**, with a console error to match.

   The screen is *not* broken, and it is worth being exact about why: the
   `Select` in `components/ui.tsx` catches that failure on purpose — "the
   built-in list still works" — so the parent still sees the standard reasons
   and can still report the absence. What survives the catch is the **"Add a
   reason"** affordance, which `canAdd` offers as soon as they type something
   the list does not contain, and which posts to the same endpoint that just
   refused them.

   So: a noisy 403 on every load, plus a button that is visible only to roles
   that cannot press it. The fix is one condition — don't offer custom options
   to a caller whose fetch was refused — not a permission grant. **A parent
   must not hold `institution.read`.**

2. **Raw ISO dates on `/parent/messages/communication`** — `2026-08-16`, where
   the rest of the product writes "16 Aug 2026". This is cluster 5 of the 24 Aug
   audit, now with a confirmed screen against it.

3. **"Absent 1 days" confirmed** on `/parent/attendance/attendance`, live.
   Already logged; now reproduced by machine rather than by eye.

4. **The four identical children are still there**, and they are the first thing
   the shell renders: the breadcrumb reads "Meera Menon / Meera Menon" and the
   switcher below it is "Meera · Meera · Meera · Meera". Seed data, already
   logged twice from two roles.

5. **The report card reads 17 / 400 · 4.3% · D2 · Rank 1** with English 17/20
   and Social Studies 18/20 beneath it — reproduced exactly. Root cause is in
   the endpoint-probe section above: the card is a stored snapshot from 17
   August, not a live sum, and the percentage divides what was entered by the
   whole exam.

### What this run did not cover

Nothing was clicked. Every screen was visited by URL and measured as it first
settled, so anything behind a button — the absence form's submit, the meeting
booking flow, the child switcher's effect on a second child — is unprobed. The
hand-run on 25 Aug remains the only pass that exercised interaction.

---

## Run — 25 Aug 2026, HR & Payroll, against the live host

Catalogue-driven browser walk: the route list comes from `/api/v1/catalog` —
what the SPA builds its own navigation from — and every route is visited in
Chromium with `console` and every response hooked.

| | |
|---|---|
| Routes in this role's catalogue | **19** |
| Visited | **19** |
| Failed network calls | **0** |
| Console errors | **0** |
| Timeouts | **0** |
| Unrounded percentages / `undefined` / `NaN` | **0** |
| Screens rendering under 400 characters | 6 |

The cleanest role walked so far: nothing failed and nothing threw. Two findings,
and both are about the seed rather than the code — but one of them contradicts
this file.

### 1. "Fixed and verified" is half true: the rename never reached the person

This report records, under **Fixed and verified**, that demo accounts were all
named "Demo institution_admin" and that the seeder's upsert has been corrected.
The correction reached `users`. It never reached `employees`:

```
employee_code      employee record   login name
ADMISSIONS-DEMO    Demo admissions   Demo Admissions & Front Office
FACULTY-DEMO       Demo faculty      Demo Faculty / Teacher
FINANCE-DEMO       Demo finance      Demo Accounts & Finance
HOD-DEMO           Demo hod          Demo HOD / Department Head
```

The login carries the role's NAME; the staff record still carries its KEY. So
HR's own Staff records table lists "Demo institution_admin", "Demo hr", "Demo
finance" — a raw role key in the Name column of the staff directory — on five
screens across this role.

This also answers the open question left by the parent run: *"the greeting reads
Good morning, Demo — check it reached the parent's person record, not just the
login."* It did not. Same bug, seen from the other end.

**The entry in Fixed and verified should be narrowed to "the login name", not
left standing as done.** A fix recorded as complete is worse than one recorded
as partial: nobody looks at it again.

### 2. Every demo employee exists twice

```
employees                28 rows
distinct employee_code   22
duplicated               ADMISSIONS-DEMO, FACULTY-DEMO, HOD-DEMO,
                         FINANCE-DEMO, HR-DEMO, INSTITUTION_ADMIN-DEMO  (2 each)
```

Six demo people, two employee rows each, sharing an employee code. This is the
same class as the four Meera Menons found from the admin and parent runs: a
seeder that upserts on one key and inserts on another, run more than once.

`employee_code` has no unique constraint to have prevented it. Whether it
should is a product question — a school that reuses codes across years may want
that — but the demo tenant now has a staff directory in which six of
twenty-two people are listed twice.

### 3. Raw ISO date

`/hr/onboarding_exit/staff_joinings_exits` renders `2026-08-19` where the rest
of the product writes "19 Aug 2026". Cluster 5 of the 24 Aug audit, second
confirmed screen after `/parent/messages/communication`.

### The six thin screens

All honest: two are the biometric features blocked on hardware and deferred in
`DEFERRED.md` (they say so), and My pay, Payroll, Statutory returns and Staff
welfare are "choose a month first" states with their pickers present. Nothing
here is an empty query. Per the parent run's correction, the character count was
a prompt to look rather than a finding — and looking is what settled it.

---

## Re-check — 25 Aug 2026, HR, two numbers from the run above

Two claims from the HR run were checked against the API and the database
directly. **One does not reproduce, and one of my own from the same day was
wrong.** Both are recorded here rather than quietly edited above, because the
point of this file is that a wrong finding costs more than a missing one.

### "11 staff have no documents against a staff of 9" — does not reproduce

`GET /api/v1/hr/dashboard`, signed in as HR, right now:

```
headcount                                        9
attention: staff have no documents on file       9
attention: staff cannot sign in yet              2
```

Nine of nine, not eleven of nine. The query behind it is
`count(*) FROM employees WHERE status='active' AND NOT EXISTS (…employee_documents…)`,
which cannot exceed the headcount it is shown against — they select from the
same table with the same predicate, one with an extra `NOT EXISTS`.

Scoped SQL against Vivencia agrees: 9 active, 9 without documents, 2 without a
login. So either the number moved between the two runs or it was misread. **Not
a defect; not carried forward.** Worth saying plainly, because "11 > 9" reads
like a join double-counting and somebody would have gone looking for one.

### "Every demo employee exists twice" — my own finding, and it was wrong

Earlier today I recorded 28 employee rows against 22 distinct codes and called
it a seeder that inserts where it should upsert. That count was taken as the
postgres superuser, **which bypasses row-level security**, so it counted every
school on the installation at once:

```
FACULTY-DEMO            Demo School                     active
FACULTY-DEMO            Vivencia High School, Kompally  active
HR-DEMO                 Demo School                     active
HR-DEMO                 Vivencia High School, Kompally  active
INSTITUTION_ADMIN-DEMO  Demo School                     active
INSTITUTION_ADMIN-DEMO  Vivencia High School, Kompally  active
```

They are not duplicates. They are one demo employee per role in each of two
tenants, which is exactly what `demo-users` is meant to produce, and RLS keeps
them apart — Vivencia's own count is 9 active with 9 distinct codes.

The lesson is procedural and worth more than the finding was: **a psql session
as the superuser is not what the app sees.** Every count in this file taken that
way has to name the tenant it was scoped to, or it is measuring a different
product. The Grade 6 enrolment gap and the leave-type rows were both read the
same way and should be re-checked scoped before anybody acts on them.

### Still standing from the HR run

The seeder rename reaching `users` but not `employees` — "Demo finance" in the
staff record against "Demo Accounts & Finance" on the login — holds. Both rows
were read scoped to Vivencia, and the raw role key is in the Name column of the
staff directory on five screens.

---

## Re-check — 25 Aug 2026, finance: the two dashboards do not disagree

The finance run records that "the two dashboards disagree about the same money…
different queries under the same words". Both endpoints were called within the
same minute and the numbers reconcile exactly. **The diagnosis is wrong, and the
real one is a smaller bug that is easier to fix and worth fixing.**

`GET /api/v1/principal/dashboard` carries **four** money figures, not two:

```
                collected      outstanding
range           45,04,625        6,66,625
year            44,97,125        6,32,875
billed          51,30,000
```

`GET /api/v1/finance/dashboard` carries the range pair, and only that pair:

```
month_paise       45,04,625
outstanding_paise  6,66,625
range             this_month · 2026-08-01 → 2026-08-25
```

**Finance's numbers are identical to the principal endpoint's RANGE numbers.**
The principal's screen is rendering the `_year_` variants; finance's screen is
rendering the range. Same server, same data, two different periods, each screen
labelling its own simply "collected" and "owed".

So nobody's query is wrong. What is wrong is that two screens print a period
figure without naming the period, and a principal and an accountant comparing
notes will each conclude the other's system is broken. **The fix is a label, not
a reconciliation** — and that is a much cheaper thing to ship than the hunt for
two disagreeing queries this entry would otherwise have sent somebody on.

### One real gap underneath it

Finance's banner "**NO BILLED TOTAL IS RECORDED**" is accurate for the endpoint
it reads: `/finance/dashboard` has no billed field at all. But the principal's
endpoint does — `billed_paise` 51,30,000, over 114 invoices — computed from the
same invoices in the same tenant.

So the billed total is not missing from the product. It is missing from the
finance response, and the accountant is told it does not exist while the
principal is shown it on the next screen. Either `/finance/dashboard` should
carry it, or the banner should stop asserting something the database can
answer.

`FinanceDashboard.tsx` was written against that absence — its header comment
reasons at length that there is no billed total anywhere in this product's
finance data, and therefore no "% collected" may be drawn. That reasoning was
true of its own endpoint and false of the product.

### Also confirmed this run

- `GET /api/v1/payroll/payslips?month=8&year=2026` **403** on Approve & pay
  salaries, reproduced. The HR run already narrowed it correctly: the
  permission works, finance simply does not hold `hr.payroll.read`. What still
  needs deciding is whether the tile belongs in finance's catalogue at all —
  and either way the raw permission string should not be the screen's copy.
- 13 routes, 1 failed call, 0 JS errors, 0 unrounded percentages.

---

## Run — 25 Aug 2026, librarian, against the live host

Catalogue-driven browser walk: routes from `/api/v1/catalog`, every one visited
in Chromium with `console` and every response hooked.

| | |
|---|---|
| Routes in this role's catalogue | **15** |
| Visited | **15** |
| Failed network calls | **0** |
| Console errors | **0** |
| Timeouts | **0** |
| Unrounded percentages, raw ISO dates, raw snake_case, `undefined`/`NaN` | **0** |
| Screens rendering under 400 characters | 5 |

**Nothing to report.** The cleanest role walked — no failure, no error, no
formatting slip, and every thin screen accounted for below. Worth stating
plainly rather than padding: an optional role that nobody has been fixing this
week came out clean, which says the shared components are sound where nobody
has been touching them.

### The five thin screens, and what the count means by now

Four of them — Fine & Penalty Summary, Digital Library Usage, Annual Book Stock
Verification, New Session Textbook Orders — render the same sentence:

> *"Fine & Penalty Summary is set up for this workspace, but its screen has not
> been built. It is listed here rather than hidden so the workspace reflects the
> full feature set."*

That is the deferred-feature placeholder doing exactly its job: it names the
feature, says it does not exist yet, and says why it is still on the menu. The
fifth is My pay waiting on a month.

**This completes the picture of the "thin screens" metric, and it has three
different causes, none of them a defect:**

1. **Complete but compact** — the parent's attendance screen is 300 characters
   and carries 96%, 25 days marked and a monthly history. `innerText` on this
   shell is terse.
2. **"Pick one first"** — a picker is present and the screen is waiting on it.
   Most of the institution_admin and finance counts.
3. **Not built yet, and saying so** — these four.

Across ten roles the metric has flagged roughly a hundred screens and produced
**no defect on its own**. It remains useful as a place to look; it has never
once been a finding by itself, and this file should stop reporting the raw
count as though it were one.

---

## Re-check — 25 Aug 2026, operations: it is eleven roles, not one

The operations run found that role signing in to "No workspace — Your account
holds no feature grants yet", with a healthy session and fifteen permissions.
Confirmed, and it is not specific to operations. **Half the roles this product
defines cannot reach a single screen.**

Two lists that were never checked against each other:

- `internal/rbac/rbac.go` defines **21** roles, each with a permission set.
- `internal/catalog/catalog_gen.go`, generated from `docs/edu_features.csv`,
  carries features for **10** of them.

The eleven with no catalogue at all:

```
vice_principal    it_admin       operations        class_teacher
exam_controller   hostel_warden  driver            counsellor
nurse             discipline_officer               activity_coord
```

Each can be granted, each signs in, each holds real permissions — `operations`
holds fifteen, including hostel, inventory, library and transport read/write —
and each lands on "No workspace". The API would serve them: every hostel,
inventory and library screen exists and is registered under
`institution_admin.*`. Nothing routes them there.

### Why this was invisible until somebody signed in as one

Nine of the eleven are in `optionalRoles`, so a freshly provisioned school does
not create them and nobody meets them by accident. `class_teacher` and
`driver` are the exceptions worth noticing: **driver is the role the bus
tracker's own enrolment flow issues a PIN against**, so a school that follows
the transport instructions creates an account that can sign in to the web app
and see nothing at all.

### What it is not

It is not a permission bug — the permissions are there and correct. It is not
the ~131-tiles-to-73-screens registry finding either; that is tiles pointing at
the wrong screen, and this is roles pointing at no tiles. **A role in
rbac.go with no rows in edu_features.csv is a role that exists everywhere
except in the navigation**, and nothing regenerates one from the other or fails
when they disagree.

The cheapest guard is a test asserting that every role in `rbac.SystemRoles`
has at least one feature in the generated catalogue. It would have failed the
day the first of these eleven was added. Whether each of them then gets its own
workspace, or is folded into an existing one, is a product decision per role —
`class_teacher` is plainly faculty's screens with a narrower scope, while
`operations` has eleven features credited to it in FEATURES_BY_ROLE.txt and
nowhere to put them.

---

## Re-check — 25 Aug 2026, transport: the platform count is not a doubling join

The transport_manager run reads: *"super_admin's GPS screen said '6 buses have
no phone paired' and listed TS07UB5678 and TS07UB9012 twice… The platform-side
count is reading a join that doubles rows; the school-side one is right."*

**There is no doubling join.** There are six buses.

```
TS07UB1234    Demo School                       active
TS07UB1234    Vivencia High School, Kompally    active
TS07UB5678    Demo School                       active
TS07UB5678    Vivencia High School, Kompally    active
TS07UB9012    Demo School                       active
TS07UB9012    Vivencia High School, Kompally    active
TS09 UB 4412  JSM                               active
```

Two tenants were seeded with the same three registration numbers. A platform
operator sees both schools' fleets, so the same plate appears twice — correctly,
because they are different vehicles at different schools. `/transport/trackers`
signed in as the school returns exactly 3 rows for 3 vehicles: no duplication
anywhere.

The screen's real failing is that it prints a registration number with no school
beside it. On a platform view, a plate is not a unique name — **"TS07UB5678"
twice is not a bug in the query, it is a column missing from the table.** That is
a smaller fix than hunting a join, and a different one.

### A note on how this keeps happening

This is the third finding in this file whose diagnosis was a phantom, and all
three share a shape: **a number was read at one scope and compared against a
number read at another.**

- "11 staff have no documents against a staff of 9" — did not reproduce; both
  are 9 when read through the API.
- "The two dashboards disagree about the same money" — they agree exactly; one
  screen renders the year figures and the other the range figures.
- "Every demo employee exists twice" — my own, and the count was taken as the
  postgres superuser, which bypasses RLS and sees every tenant.
- This one — six buses across two tenants, read as three doubled.

The observations were all correct. Every diagnosis was wrong in the same
direction: an assumed single scope where there were two. **Before filing a
count as a defect, name the tenant it was counted in** — and if a platform
screen and a school screen disagree, that is the first thing to rule out rather
than the last.
