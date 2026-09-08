# Yajur Public School — onboarding template pack

Twenty CSVs, numbered in the only order they can be uploaded in. Each file's
header row is taken from the importer that reads it (`internal/api/bulk_import.go`,
and `internal/api/students_write.go` for students), so the columns match what the
server actually accepts. Row 2 of every file is a worked example — **delete it
before you upload.**

## How to upload

Setup → the matching step → drop the file on that step's box. Every upload is a
dry run first: it is read, checked and shown to you, and nothing is written until
you say so. Any upload can be taken back out afterwards.

Two rules that cause most failures:

1. **Order matters.** A file may only name things an earlier file created. Marks
   for a child who has not been imported yet are rejected row by row, and read as
   the file being wrong when they are only early.
2. **Save as CSV, not .xlsx.** In Excel or Google Sheets: File → Download / Save
   As → CSV. A workbook is refused with a message.

Headers are matched by name after case and spacing are normalised, and only on an
exact match. Anything else you point at a column by hand on the mapping screen.
A field you leave alone is not imported.

## The files, in order

| # | File | Required columns |
|---|---|---|
| 01 | classes | `name` (sections, capacity, strength optional) |
| 02 | sections | `class`, `name` |
| 03 | subjects | `name`, `code` |
| 04 | periods | `sequence`, `name` |
| 05 | staff | `employee_code`, `first_name` |
| 06 | class-subjects | `subject` |
| 07 | allocations | `class`, `section` |
| 08 | fee-heads | `name`, `code` |
| 09 | fee-structures | `structure`, `fee_head`, `annual_amount` |
| 10 | students | `full_name` — everything else optional |
| 11 | attendance | `admission_no`, `date`, `status` |
| 12 | staff-attendance | `employee_code`, `date`, `status` |
| 13 | fee-payments | `admission_no`, `paid_on`, `amount` |
| 14 | payslips | `employee_code`, `month`, `gross`, `net` |
| 15 | student-history | `admission_no`, `year` |
| 16 | staff-history | `employee_code`, `year` |
| 17 | marks | `admission_no`, `year`, `exam`, `class`, `subject`, `max_marks` |
| 17b | marks-grid | `admission_no` + one column per subject |
| 18 | student-exits | `admission_no` |
| 19 | punches | `device_serial`, `device_user_id`, `punched_at` |

Files 11–19 are history. **A school that was not running before it came here
should skip them entirely** — nothing in them is required and no step blocks on
them.

### 17 or 17b, not both

`17-marks.csv` is one row per child per exam per subject. `17b-marks-grid.csv` is
the sheet the staff room actually keeps — children down the side, subjects across
the top. Use whichever shape your existing file is already in. The grid asks for
the year, examination, class and marks-out-of once, in the four fields above its
own drop box, because a grid has no column for them.

Subject columns in 17b are named on upload. `Total`, `Rank`, `Attendance` and
`Remarks` are left unmapped — they are worked out from the marks, not read.

## What is NOT in this pack

These have no CSV importer and are entered on the Setup screens (or by us, before
you get there). They must exist before the files above will import:

- **Institution** — name, short name, slug, logo, colour, timezone, locale
- **Campus** — name, code, address, city, state, pincode, phone, email
  (auto-created as "Main Campus / MAIN" if you never make one)
- **Academic year** — name, start date, end date, which is current, board.
  Entered rather than derived: Yajur's year runs March–April, off the financial year
- **Admin user and roles**, numbering schemes (admission no, receipt no, invoice no)
- Houses, departments, designations, grading scales and grade bands, exams,
  holidays and the calendar, bell schedules
- Transport (vehicles, routes, stops), hostel (blocks, rooms), library, inventory
- Provider credentials: SMS, WhatsApp, email, payment gateway, object storage

## Known gaps for Yajur specifically

`holidays` is empty and the timetable and duty roster have nobody scheduled.
Both have seed scripts waiting: `scripts/seed_calendar_telangana.sql` and
`scripts/seed_timetable.sql`.
