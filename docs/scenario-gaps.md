# Real-world scenarios: gaps found and closed

Date: 2026-10-08. Method: 68 scenarios written as a school office would meet
them, run against the real Worker with local D1 through the integration
harness: 46 day-to-day ones in `real_world_scenarios.test.ts` and 22 across a
whole academic year in `academic_year.test.ts` (price list and demands, a
concession, term exam and report cards, a month of payroll, the next year,
promotion and roll-over). Every scenario states the rule a school expects.
All 68 pass as of this date: the 15 day-to-day gaps and the 6 year-cycle gaps
below were fixed the same day, and the tests now hold the rules in place.

## Year-cycle gaps (all fixed)

- **An academic year could end before it started, have no real dates, or
  overlap another.** `POST /setup/academic-years` now needs two dates, end
  after start, and refuses an overlap with 409.
- **A fee demand could be raised already overdue.** `POST /fees/invoices/generate`
  refuses a due date before today.
- **Marks could be changed under a published report card.** `POST /exams/marks`
  refuses with 409 while any of those children has a published card for the
  exam; return the card first.
- **Promotion accepted the same section, a section of the wrong year, and
  moved children with unpaid dues without a word.** `POST /lifecycle/promote`
  now refuses same-section and same-year moves, checks the target section is in
  the year given, and holds children with dues unless `allow_dues` is sent.
- **The register and the counter accepted children who had left** (closed
  with the day-to-day gaps above).
- **The family's results page** is `GET /portal/results` and
  `/portal/results/card?id=`; `GET /exams/report-cards` is a staff route and
  answers a parent 403. Not a defect, but worth knowing when reading the map.

## UI defects found and fixed the same day

- **The default palette made every destructive label unreadable.** Vivid's
  accents were the light lime, cyan and pink meant for fills, and
  `bento-theme.css` paints `.text-destructive` and the good/bad marks with them:
  1.3:1 to 2.5:1 on a white card. They are now deep inks (5.3:1 to 5.9:1); the
  bold hues stay in the tints.
- **Sixteen retired screens were still in the bundle** with no route to them
  (the alumni, campus-life and gamified-learning features the owner retired in
  migrations 0032 to 0050). Deleted.
- **One new feature had no icon and no help answer** (Take attendance, whole
  school). Added; help answers regenerated from the live catalogue.
- **Exclamation marks and emoji** in the student course, quiz, home, status,
  notifications, vehicle map, driver and ops screens, against the copy rule.
  Rewritten as plain sentences or line icons.
- **Size-tier tests were stale** against the owner's Tall card decision; the
  tests now match the shipped five-tier table.

Still open on the UI side, not fixed here: 380 hand-rolled `<button>` and 86
raw `<input>` elements in `web/src/features` against the shared-component
rule, and hard-coded hex colours on the student home. Both need a screen-by-
screen pass in a browser, which this session did not have.

Baseline before this work: 358 of 362 existing integration tests pass. The 4
failures predate this work: three query-count budgets in `perf.test.ts` and
`status_perf.test.ts` (16 tenant statements where 14 are allowed, 18 where 15
are allowed) and one class-status notification test
(`class_status_gaps.test.ts`, "a post to a section reaches its subject
teacher"). After the fixes: 426 of 430 pass, the same four failing.

## Day-to-day gaps, most serious first (all fixed)

### 1. A new child typed with an existing admission number overwrites that child

`POST /students` upserts by admission number (`routes/students/write.ts`,
`planUpsertStudent`). The scenario created "Dup Licate" with admission number
A001 and got back 201 with Chirag's id; Chirag's record now reads "Dup". A
clerk's typo silently renames another family's child, and nothing on the
receipt tells them. The import path needs upsert; the single-record form does
not. Fix: `POST /students` refuses an admission number that is already on the
roll with 409, and offers "open that child" instead.

### 2. Money can be collected against a child who has left

A transferred child (status `transferred`, enrollment ended) still takes a
receipt at the counter: 201, receipt issued, invoice allocated. The counter
checks only that the student row exists (`fees/counter.ts`). Fix: refuse
with 409 unless the clerk explicitly chooses "settle an old account", and
say so on the receipt.

### 3. Recording a child as left ignores unpaid dues

`POST /students/{id}/exit` returned 200 for Diya, who owes the full INV-2,
and ended the family login in the same call. The office loses the dues view
and the family loses the way to pay. Fix: 409 with the outstanding amount;
allow override with a reason that goes on the student's ledger.

### 4. Attendance accepts children who are not in the section

A student with no enrollment in the section was marked absent in it (200,
`written: 1`, an absence alert queued for a family that is not in that
class). The same happens for a child who has left. The handler never joins
`enrollments`. Fix: drop entries whose active enrollment is not this section
and report them in the response, so the screen can show "not in this class".

### 5. Attendance and receipts accept future dates

A register for a week ahead and a receipt dated next month were both saved.
Only the open accounting month is checked. Fix: refuse any date after today
(school timezone) on both, with the receipt allowing the configured
back-dating window only.

### 6. Marks are saved for a child who is not in the class

The principal entered marks on the Half yearly Mathematics paper for a student
with no enrollment in Class 5: 200, `written: 1`. The scope check runs only
for teachers; the paper is never matched to the child's class. Fix: every
entry must have an active enrollment in a section of the paper's class.

### 7. Homework due dates are not validated

`due_on: "next tuesday"` and a due date 30 days in the past were both
published and sent to every family in the section. Fix: must be a date, not
before the assigned date.

### 8. Homework can be turned in when the teacher said no, and for the wrong class

`allow_submission: false` is ignored by `POST /homework/{id}/submit`, and a
homework set for section B was turned in by a child in section A. The
handler checks that the child is the parent's own, not that the homework
belongs to the child's section or takes submissions. Fix: join the child's
enrollment to the homework's section; refuse closed work with 409.

### 9. Approved leave is silently overwritten by the register

After the class teacher approved two days of leave, marking the child
absent on one of those days flipped the register to `absent` with no
warning. The leave stays approved, so reports disagree. Fix: either refuse
with 409 ("on approved leave") or keep `leave` and tell the teacher.

### 10. The same leave can be filed twice

Two identical requests for the same child and dates both became pending.
Fix: 409 when a pending or approved request overlaps the dates.

### 11. A concession of 150 percent is accepted

Percent is checked to be a number and nothing more. Fix: 0 to 100 inclusive,
and an amount concession not above the fee head's charge.

## What held up (31 scenarios)

Zero and negative receipts refused; cheque without instrument number
refused; overpayment kept as an advance with the right ledger balance; the
teacher and the parent cannot collect money; a parent sees only their own
child's invoices, attendance and receipts; refunds cannot exceed what was
paid, two simultaneous refund requests cannot together exceed it, and a
rejection needs a reason; a teacher cannot grant a concession; a child with
payments cannot be deleted; the register is idempotent and refuses unknown
statuses; a parent cannot mark it; leave is scoped to the parent's own child,
decided only by the class teacher and only once, and approved days land on
the register as `leave`; marks above the maximum or negative are refused; a
parent cannot enter marks; a leaving date in the future is refused; a
signed-out visitor gets 401; the teacher cannot open the finance dashboard;
finance cannot reach role administration; eight wrong passwords lock the
identifier even when every try comes from a different address.

## Enhancements worth building

- **Admission-number typo flow.** On 409 from gap 1, the form offers to open
  the existing child, or to use the next free number.
- **Leaving checklist.** Dues, library books, hostel, transport and the
  family login shown together before "Record that they have left", with an
  override that writes the reason to the ledger.
- **Register guardrails.** The section's roll is the only list the register
  accepts; children on approved leave are pre-filled and locked; a date
  picker that stops at today.
- **Homework form.** Date picker only; "takes submissions" switch respected
  on the family side; the parent's diary hides closed work's submit button.
- **Concession limits.** Percent slider 0 to 100; amount capped at the head's
  charge; approvals above a configured threshold routed to the principal.
- **Audit on overwrite.** Any write that changes an existing child's name or
  date of birth records who, when and from which screen.
- **Perf budgets.** Bring the two class-status feeds back under budget (16 to
  14 and 18 to 15 statements) or raise the budget on purpose with a note.

## Not run here

`scripts/simulate.py` drives the demo school over HTTP against a running
server with the eleven demo accounts; no server was available in this
session, so the role-by-role read sweep it performs was not repeated. The
scenarios above were run through the Worker in-process instead.
