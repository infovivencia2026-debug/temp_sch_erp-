# The school year, month by month, and where this ERP breaks

452 catalogued features, 414 built. This maps them onto the year an Indian
school actually runs — April to March — and records what the year needs that
the product does not have. Every finding below was checked in code or schema,
not inferred from a feature name.

Detail per phase: `01_pre_year.md`, `02_onboarding_daily.md`,
`03_monthly_term.md`, `04_rollover_and_seller.md`.

## The verdict in one line

**The records are strong; the joins between them are cut.** Individual modules
are well built — often better than their catalogue entry suggests. What is
missing is almost always the *seam*: the step where one month's work becomes
the next month's input, or where a decision becomes the thing that governs.

## The year

    APR ── year opens. New enrolments active. Fee invoices raised.
    │      GAP: fee versions and committee approval do not reach invoicing.
    │      GAP: last year is still editable. There is no close.
    │      GAP: arrears do not carry. A defaulter starts clean.
    │
    MAY ── first unit tests. Term 1 begins in earnest.
    │      GAP: the per-paper datesheet is read by six screens, written by none.
    │
    JUN ── monsoon. Attendance dips. Transport under strain.
    │      GAP: vehicle insurance / permit / fitness / PUC renewals absent.
    │      GAP: transport fare is computed, shown, and never billed.
    │
    JUL ── Term 1 exams. Marks. Report cards. PTM.
    │      GAP: a mark is visible to a parent the instant it is typed.
    │      GAP: Term 2 report card overwrites Term 1 — term_id never set.
    │      OK:  exam seating, PTM notes and follow-up are properly built.
    │
    AUG ── mid-year admissions. Transfers in and out.
    │      GAP: mid-year section change has no handler; the obvious route
    │           leaves the child with no active enrolment at all.
    │      GAP: refunds table is read-only. Exit settlement cannot happen.
    │
    SEP ── next year's planning starts. Fee structure drafted.
    │      GAP: two academic years cannot be alive at once.
    │
    OCT ── festivals. Half-yearlies. Payroll continues.
    │      GAP: no month close. Any past month stays editable.
    │      GAP: payroll can be silently recomputed after bank export.
    │
    NOV ── admission campaign for next year opens.
    │      GAP: creating next year's sections doubles this year's seat count.
    │      GAP: no intake target to admit against.
    │
    DEC ── procurement for next year. Books, uniforms ordered.
    │      GAP: no quotation/RFQ record behind "compare vendor quotes".
    │      GAP: nothing links enrolment projection to order quantity.
    │
    JAN ── next year's timetable drafted against vacant posts.
    │      OK:  the solver handles this correctly and deliberately.
    │      GAP: curriculum has no year — planning next year edits this one.
    │
    FEB ── final exams approach. Staff appraisal cycle.
    │      OK:  appraisal is a real annual process, properly built.
    │
    MAR ── results. Promotion. TCs. Year end.
    │      OK:  promotion preserves identity and history correctly.
    │      OK:  TC issuance exists and snapshots properly.
    │      GAP: TC carries 8 of ~20 prescribed fields, and no dues gate.
    │      GAP: no rollover. Sections, timetable, fees, transport, hostel
    │           are rebuilt by hand every April.
    │      GAP: no year close. 2026-27 stays editable for ever.

## The five that would stop a school

**1. No parent can log in.** `guardians.user_id` is written by exactly one
thing: `cmd/migrate/demo.go`. Both production paths that create a guardian —
admissions handoff and student creation — insert without it. There is no
invitation flow. So the entire parent role, 42 features and 32 built, is
unreachable in a real tenant. Worse than dark: circular fan-out resolves
recipients with `g.user_id IS NOT NULL` and silently reaches nobody, while the
newer messaging path falls back to the phone — so the school texts a parent
about an absence and links them to an app they cannot enter.

**2. Two academic years cannot coexist.** `academic_years_one_current` permits
one current year per campus, and twelve handlers resolve the working year by
`WHERE is_current` with no override. A school runs next year's admissions from
November while this year is still teaching; for a third of every year this
product is answering the wrong year's question. The reporting layer already
does it right — `rollupYear` takes an explicit year — and that pattern simply
was not propagated.

**3. There is no close, anywhere in the academic or monthly cycle.** Five
freeze mechanisms exist and are well built — accounting year, bank
reconciliation, MDM returns, regulatory filings, service book. None was applied
to marks, attendance, enrolments, exams or report cards, and `academic_years`
has no status column. An auditor cannot be told that last March is final,
because it is not.

**4. What was approved is not what is charged.** Fee structure versioning and
the regulatory filing are both real and both correct in themselves.
`activateStructureVersion` never checks that a filing exists or was approved,
`approved_paise` is read by no billing path, and invoices leave
`fee_structure_version_id` NULL. In a state that regulates fees, "did we charge
what the committee sanctioned" is unanswerable from this database.

**5. Money owed does not survive the year.** No arrears, no brought-forward, no
opening balance anywhere in the fee engine. A family that owes two terms at the
end of March starts April owing nothing.

## What is genuinely good, and should not be disturbed

The daily loop is the strongest part of the product: period-wise attendance
with an audited correction path; a substitution board that computes actually
free teachers from the register *and* approved leave and refuses a busy proxy
with a 409; an absence-alert engine that collapses eight period rows into one
message, withdraws it if the family already reported, and is idempotent under
cron. Exam seating, PTM notes with agreed actions surfaced at the next meeting,
the double-entry ledger, the gapless FY-resetting receipt series, promotion's
handling of identity versus enrolment, and the impersonation grant — capped at
four hours by a database CHECK, with the school able to audit the vendor — are
all better than the catalogue implies.

## A correction

An earlier pass reported that TC issuance did not exist, on the strength of the
catalogue containing only "Transfer Certificate Intake". That was wrong.
`issueCertificate` handles TC, bonafide and conduct certificates, allocates a
serial, and freezes a snapshot so an old TC does not change its contents when
the student is archived. The real defects are narrower: it carries 8 of the
~20 fields a TC is prescribed to have, and there is no dues or clearance gate —
which staff exits have, enforced in the database.

The lesson is the one this whole exercise exists to catch: a feature name is
not evidence in either direction.
