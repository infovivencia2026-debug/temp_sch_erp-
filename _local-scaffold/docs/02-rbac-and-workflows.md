# 02 — Permission Matrix, Authorization Model, Business Workflows

## D. Permission model

A permission is `<domain>.<resource>.<action>`. Authorization is a three-gate check, all server-side:

```
1. TENANT   — is the row inside the caller's org/school/campus context?   (RLS + repo guard)
2. GRANT    — does any of the caller's roles grant this permission?        (permission set)
3. SCOPE    — does the caller's scope cover this specific object?          (policy function)
```

Gate 3 is the one most ERPs get wrong. Scope types:

| Scope | Meaning | Resolved from |
|---|---|---|
| `org` | all schools in org | membership |
| `school` | one school | membership |
| `campus` | one campus | membership |
| `assigned_sections` | sections where user is class teacher | `section_teachers` |
| `assigned_allocations` | section×subject the user teaches | `timetable_allocations` / `subject_allocations` |
| `own_children` | students linked as guardian | `student_guardians` (active, verified) |
| `self` | own user/student/staff record | identity |
| `assigned_hostels` / `assigned_routes` | operational assignment | assignment tables |

Every policy is a pure function `(actor, resourceRef) → allow | deny(reason)` and every one has a test.

### Permission catalogue (abridged to the load-bearing set; full list lives in code as a typed const)

```
platform:   user.read|create|update|deactivate  role.read|create|update|assign
            permission.read  audit.read  settings.read|update  featureflag.update
            impersonate.request|approve
sis:        student.read  student.read_restricted  student.create|update|archive
            student.export  guardian.read|create|update  guardian.link
            admission.read|create|update  admission.verify_documents
            admission.evaluate  admission.approve|reject|waitlist
            lifecycle.promote|detain|transfer|withdraw|readmit|graduate
            health.read|write   discipline.read|write|resolve   discipline.read_confidential
academics:  subject.read|manage  curriculum.read|manage  timetable.read|manage|substitute
            attendance.read  attendance.mark  attendance.correct  attendance.approve_correction
            leave.request|approve|reject  homework.read|create|grade  lms.read|author
exams:      exam.read|create|configure|schedule
            exam.enter_marks  exam.verify_marks  exam.moderate  exam.grace
            exam.approve  exam.publish  exam.unlock   reportcard.generate|publish
finance:    fees.read  fees.structure_manage  fees.assign  fees.collect
            fees.discount  fees.approve_discount  fees.refund  fees.waive_late_fee
            invoice.create|void  payment.reconcile  accounting.read|post  expense.create|approve
            vendor.manage  po.create|approve
hr:         staff.read  staff.read_sensitive  staff.create|update
            staffleave.approve  payroll.read|process|approve
ops:        library.*  transport.*  hostel.*  inventory.*  asset.*
comms:      announcement.create|publish  message.send  emergency.broadcast
reports:    reports.view  reports.view_financial  reports.export  reports.export_pii
```

### Role × permission matrix (representative slice)

Legend: ● full · ◐ scoped · ○ none

| Permission | org_admin | principal | acad_coord | exam_coord | class_teacher | teacher | accountant | parent | student | auditor |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| student.read | ● | ● | ● | ● | ◐ sections | ◐ allocations | ◐ billing fields | ◐ children | ◐ self | ● |
| student.read_restricted | ◐ | ● | ○ | ○ | ○ | ○ | ○ | ◐ children | ○ | ● |
| student.create/update | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| attendance.mark | ● | ● | ● | ○ | ◐ sections | ◐ allocations | ○ | ○ | ○ | ○ |
| attendance.correct | ● | ● | ● | ○ | ◐ +reason | ○ | ○ | ○ | ○ | ○ |
| attendance.approve_correction | ● | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| exam.configure | ● | ● | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ |
| exam.enter_marks | ○ | ○ | ◐ | ◐ | ◐ allocations | ◐ allocations | ○ | ○ | ○ | ○ |
| exam.verify_marks | ● | ● | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ |
| exam.publish | ● | ● | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ |
| fees.collect | ● | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ |
| fees.discount | ● | ◐ | ○ | ○ | ○ | ○ | ◐ request | ○ | ○ | ○ |
| fees.approve_discount | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| fees.refund | ● | ○ | ○ | ○ | ○ | ○ | ○ (finance_mgr) | ○ | ○ | ○ |
| health.read | ○ | ◐ | ○ | ○ | ◐ emergency only | ○ | ○ | ◐ children | ○ | ● |
| discipline.write | ● | ● | ● | ○ | ◐ sections | ○ | ○ | ○ | ○ | ○ |
| payroll.process | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| audit.read | ● | ◐ school | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● |
| reports.export_pii | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

**Invariants encoded as tests:** `parent` can never read a non-child; `teacher` can never write outside allocations; `accountant` has zero academic write permissions; `auditor` has zero write permissions anywhere; nobody except `exam_coordinator`/`principal`/`org_admin` can publish; `super_admin` reads tenant PII only under an approved, time-boxed, audited impersonation grant.

---

## G. Major business workflows

### 1. Admissions → enrollment
```
Enquiry ──▶ Application ──▶ Documents ──▶ Entrance Test ──▶ Interview
                                                                │
   Waitlist ◀── Evaluation ──▶ Rejected                         │
       │            │                                           │
       └────────────▼───────────────────────────────────────────┘
                  Offer ──▶ Admission Fee Paid ──▶ Enrolled ──▶ Student + Enrollment created
```
Rules: stages are configurable per school (a stage may be skipped, not reordered past approval). Offer expires on a deadline → auto-lapse job → next waitlist candidate notified. Enrollment is transactional: creates `students`, `enrollments`, `users` (parent + student), fee assignment, and admission number from a per-school gapless sequence. Idempotent on application id.

### 2. Attendance + correction
```
Teacher opens section → roster prefilled all-present → deviations marked → submit
   → attendance_records written (period or daily per school config)
   → absentee notification job (respects quiet hours + parent preferences)
Correction after lock window:
   Teacher requests (reason mandatory) → coordinator approves → record updated
   → attendance_corrections + audit_log row, original value preserved forever
```

### 3. Examination → result
```
Exam created → papers + max/pass/weightage configured → schedule published (conflict-checked)
  → Marks entry (teacher, per allocation, draft-saveable)
  → Submitted → Verification queue (coordinator; sees outliers, blanks, >max flags)
  → Moderation / grace (reason + audit) → Approval
  → PUBLISH: state machine locks marks, generates report cards as background jobs,
             fires exam.result_published notifications, snapshots grade scale used
Post-publish change requires exam.unlock (principal/org_admin), a reason, and creates
a revaluation record + republished report card version. Never a silent edit.
```

### 4. Fee → payment → receipt
```
Fee structure (components, installments) → assigned to students (with concessions)
  → Invoice generated per installment (due date, late-fee rule)
  → Payment initiated:  gateway  |  cash  |  cheque  |  UPI  |  bank transfer
       gateway: payment_intent → provider → webhook (idempotent, raw-stored, signature verified)
       offline: recorded by accountant, requires day-end cash reconciliation
  → Payment verified → Allocation across invoices/components (oldest-arrears-first, configurable)
  → Receipt issued (gapless per-school series, immutable) → Ledger journal posted (double entry)
Refund: request → approve (finance_manager) → credit note + reverse journal + gateway refund.
Nothing in this chain is ever deleted; corrections are reversing entries.
```

### 5. Student lifecycle / promotion
```
Year-end → promotion run (per grade) → rules evaluated (attendance %, result status, fee clearance flag)
  → Promote | Detain | Graduate proposals → review screen → commit (transactional, bulk)
  → new enrollments created for next academic year; prior enrollments closed, never mutated
Transfer/withdrawal → TC generation → alumni record.
```

### 6. Timetable + substitution
```
Periods defined → allocations placed (teacher × subject × section × room × slot)
Conflict engine rejects: teacher double-book, room double-book, section double-book,
   teacher unavailability, max-periods-per-day, subject weekly-quota violation
Teacher absent → substitution board suggests free teachers with subject match → assign → notify
```

### 7. Procure → pay
```
Purchase request → approval (threshold-based) → quotations → PO → goods received (GRN)
  → vendor invoice matched (3-way: PO/GRN/invoice) → payment → expense journal
```

---

## Business rules that are enforced in the backend, always

1. A teacher may only write attendance/marks for their own allocations, and only within the open window.
2. A parent's data access is derived from `student_guardians` where the link is active and verified — never from a request parameter.
3. A published exam is immutable without an audited unlock.
4. Financial records are never deleted; corrections are reversing entries with a reason.
5. Payment webhooks are idempotent by `(provider, provider_event_id)`, stored raw before processing.
6. A section cannot exceed capacity when capacity enforcement is enabled; the override requires a permission and is audited.
7. A vehicle/route cannot exceed seat capacity; hostel beds cannot be double-allocated (unique partial index on active allocation).
8. An admission number, receipt number, and invoice number are gapless per school per financial/academic year, allocated inside the transaction via a sequence table with row lock.
9. A student cannot have two active enrollments in the same academic year.
10. Marks cannot exceed the paper maximum; absent/malpractice are states, not scores of 0.
11. Restricted fields (health, discipline, category, government IDs) require the specific permission, and reads are audited.
12. Deleting anything a human might need later is a soft delete + `archived_at`; hard delete exists only for uploaded files under a retention policy.
