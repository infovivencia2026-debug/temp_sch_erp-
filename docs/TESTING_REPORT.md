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
