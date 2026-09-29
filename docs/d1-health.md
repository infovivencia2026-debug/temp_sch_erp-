# D1 health: indexes, replicas, caching, archiving, backups

How the school databases (one D1 per school, plus CONTROL) stay fast and safe as they grow.
Code: `worker/src/tenant.ts` (sessions), `worker/src/services/refcache.ts` (cache),
`worker/migrations/tenant/0018_query_indexes.sql`, `worker/migrations/control/0012_housekeeping_indexes.sql`,
`worker/src/services/background/weekly_export.ts`, `worker/scripts/archive-year.mjs`, `worker/scripts/restore-rehearsal.mjs`.

## Index audit

The baseline schema copied Postgres's indexes, most of which begin with `institution_id`.
D1 queries never filter on it (the database *is* the school), so SQLite could not use them.

Method: every SQL string literal in `worker/src` (3,663 found, 2,660 parse without their
`${...}` interpolations) was run through `EXPLAIN QUERY PLAN` against a local SQLite copy
of `db/tenant.sql` / `db/control.sql` (never a real school), before and after the migrations.
Result: 630 queries had a full `SCAN`; 115 of them (109 tenant, 6 CONTROL) now use an index.
The remaining scans are small tables (years, roles, campuses, settings), whole-table
aggregates, or `json_each`, where a scan is correct.

Re-run: `worker/scripts` has no permanent copy of the audit; the recipe is extract literals ->
`EXPLAIN QUERY PLAN` with every `?` bound to NULL -> list `SCAN <table>` lines.

| Query (file:line) | Before | After |
|---|---|---|
| routes/academics/admin.ts:529 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?) |
| routes/academics/admin.ts:571 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?) |
| routes/academics/admin.ts:731 | SCAN e | SEARCH e USING COVERING INDEX employees_status_department (status=? AND department_id=?); SEARCH e USING INDEX |
| routes/admin/integrations_index.ts:49 | SCAN message_log | SCAN message_log USING INDEX message_log_channel_queued |
| routes/admin/loose.ts:205 | SCAN payments | SEARCH payments USING COVERING INDEX payments_status_created (status=? AND created_at>?) |
| routes/admin/loose.ts:330 | SCAN payments | SEARCH payments USING INDEX payments_status_paid_on (status=? AND paid_on=?) |
| routes/admin/loose.ts:342 | SCAN staff_attendance | SEARCH staff_attendance USING COVERING INDEX staff_attendance_date_status (on_date=?) |
| routes/admin/metrics.ts:20 | SCAN payments | SEARCH payments USING INDEX payments_status_paid_on (status=? AND paid_on>? AND paid_on<?) |
| routes/admin/metrics.ts:22 | SCAN payments | SEARCH payments USING INDEX payments_status_paid_on (status=? AND paid_on>? AND paid_on<?) |
| routes/admin/metrics.ts:24 | SCAN invoices | SEARCH invoices USING INDEX invoices_issued_on (issued_on>? AND issued_on<?) |
| routes/admin/metrics.ts:37 | SCAN students | SEARCH students USING COVERING INDEX students_admission_date (admission_date>? AND admission_date<?) |
| routes/admin/metrics.ts:50 | SCAN staff_attendance | SEARCH staff_attendance USING COVERING INDEX staff_attendance_date_status (on_date>? AND on_date<?) |
| routes/admin/metrics.ts:56 | SCAN employees | SEARCH employees USING COVERING INDEX employees_joined_on (joined_on>? AND joined_on<?) |
| routes/admin/metrics.ts:75 | SCAN library_loans | SEARCH library_loans USING COVERING INDEX library_loans_issued_on (issued_on>? AND issued_on<?) |
| routes/admin/msg_plans.ts:105 | SCAN sa | SCAN sa USING COVERING INDEX student_attendance_student_date |
| routes/admin/ops_fee_filings.ts:220 | SCAN e | SEARCH e USING INDEX enrollments_year_section (academic_year_id=?) |
| routes/admin/platform_config.ts:707 | SCAN sessions | SEARCH sessions USING INDEX sessions_created_at (created_at>?) |
| routes/admin/platform_config.ts:725 | SCAN sessions | SEARCH sessions USING INDEX sessions_created_at (created_at>?) |
| routes/admin/platform_config.ts:741 | SCAN sessions | SEARCH sessions USING INDEX sessions_created_at (created_at>?) |
| routes/admin/platform_signals.ts:30 | SCAN student_attendance; SCAN st | SEARCH st USING INDEX students_status (status=?) |
| routes/admin/platform_signals.ts:106 | SCAN invoices | SEARCH invoices USING INDEX invoices_status_due (status=? AND due_on>? AND due_on<?) |
| routes/admin/platform_signals.ts:108 | SCAN invoices | SEARCH invoices USING INDEX invoices_status_due (status=? AND due_on>? AND due_on<?) |
| routes/admin/security.ts:90 | SCAN fee_structures | SEARCH fee_structures USING INDEX fee_structures_year_class (academic_year_id=?) |
| routes/admin/security.ts:115 | SCAN fs; SCAN t | SEARCH fs USING INDEX fee_structures_year_class (academic_year_id=?); SEARCH t USING INDEX fee_structures_year |
| routes/admin/security.ts:160 | SCAN te | SEARCH te USING INDEX timetable_entries_year_section (academic_year_id=?) |
| routes/admin/security.ts:285 | SCAN y | SEARCH y USING INDEX sessions_created_at (created_at>?) |
| routes/admin/student_logins.ts:16 | SCAN st | SEARCH st USING INDEX students_status (status=?) |
| routes/admissions/campaigns.ts:331 | SCAN a | SEARCH a USING INDEX applications_enquiry (enquiry_id=?) |
| routes/admissions/crm.ts:62 | SCAN applications | SEARCH applications USING INDEX applications_enquiry (enquiry_id=?) |
| routes/admissions/funnel.ts:268 | SCAN applications | SEARCH applications USING INDEX applications_application_no (application_no=?) |
| routes/admissions/public_forms.ts:226 | SCAN a | SEARCH a USING COVERING INDEX applications_enquiry (enquiry_id=?) |
| routes/admissions/workflow.ts:335 | SCAN a2 | SEARCH a2 USING INDEX applications_status_decided (status=?) |
| routes/ai/drafting.ts:152 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?); SEARCH e USING INDEX sqlite_autoindex_employ |
| routes/comms/grievances.ts:162 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?) |
| routes/daily.ts:820 | SCAN student_attendance | SEARCH student_attendance USING COVERING INDEX student_attendance_student_date (student_id=? AND on_date>?) |
| routes/daily.ts:1219 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/exams.ts:1116 | SCAN es | SEARCH es USING INDEX exam_subjects_class_subject (class_subject_id=?) |
| routes/exams.ts:1422 | SCAN student_attendance | SEARCH student_attendance USING COVERING INDEX student_attendance_student_date (student_id=?) |
| routes/exams.ts:1704 | SCAN e; SCAN sa; SCAN sa; SCAN rc; SCAN rc | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?); SEARCH sa USING COVERING INDEX student_atten |
| routes/fees/ledgers.ts:1435 | SCAN i | SEARCH i USING INDEX invoices_issued_on (issued_on>? AND issued_on<?) |
| routes/fees/ledgers.ts:1480 | SCAN p | SEARCH p USING INDEX payments_status_created (status=?) |
| routes/growth/rollups.ts:137 | SCAN leave_requests | SEARCH leave_requests USING COVERING INDEX leave_requests_status_kind (status=? AND subject_kind=? AND from_da |
| routes/growth/rollups.ts:175 | SCAN en | SEARCH en USING INDEX enrollments_year_section (academic_year_id=?) |
| routes/growth/rollups.ts:235 | SCAN pa | SEARCH pa USING INDEX sqlite_autoindex_payment_allocations_2 (payment_id=?) |
| routes/growth/rollups.ts:253 | SCAN p | SEARCH p USING INDEX payments_status_created (status=?) |
| routes/hr/attendance.ts:94 | SCAN sa | SCAN sa USING COVERING INDEX student_attendance_student_date |
| routes/hr/concerns.ts:497 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?) |
| routes/hr/office.ts:86 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?) |
| routes/hr/staff.ts:298 | SCAN r | SEARCH r USING COVERING INDEX leave_requests_type (leave_type_id=?) |
| routes/hr/staff.ts:316 | SCAN employees USING COVERING INDEX employees_institution_id | SEARCH employees USING COVERING INDEX employees_status_department (status=?); SEARCH staff_attendance USING CO |
| routes/hr/staff.ts:333 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?); SEARCH e USING INDEX employees_status_department  |
| routes/misc/assistant.ts:193 | SCAN lr | SEARCH lr USING INDEX leave_requests_status_kind (status=? AND subject_kind=? AND from_date<?) |
| routes/misc/chat.ts:206 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?) |
| routes/misc/files.ts:66 | SCAN homework_attachments; SCAN hs | SEARCH homework_attachments USING INDEX homework_attachments_file (file_id=?); SEARCH hs USING INDEX homework_ |
| routes/misc/profile.ts:41 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/payroll.ts:518 | SCAN e | SEARCH e USING INDEX employees_user_id_idx (user_id=?) |
| routes/payroll.ts:581 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?) |
| routes/portal/family.ts:806 | SCAN es | SEARCH es USING INDEX exam_subjects_class_subject (class_subject_id=?) |
| routes/portal/life.ts:844 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/portal/lms.ts:74 | SCAN t | SEARCH t USING INDEX online_tests_section_subject (section_id=?) |
| routes/portal/lms.ts:151 | SCAN t | SEARCH t USING INDEX online_tests_section_subject (section_id=? AND class_subject_id=? AND status=?) |
| routes/portal/lms.ts:240 | SCAN a | SEARCH a USING INDEX announcements_publish_at (publish_at<?) |
| routes/portal/records.ts:66 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/portal/records.ts:230 | SCAN es | SEARCH es USING INDEX exam_subjects_class_subject (class_subject_id=?) |
| routes/portal/records.ts:370 | SCAN sa | SEARCH sa USING COVERING INDEX student_attendance_student_date (student_id=?) |
| routes/portal/requests.ts:783 | SCAN e; SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?); SEARCH e USING INDEX enrollments_student_enr |
| routes/setup/academics.ts:325 | SCAN te | SEARCH te USING COVERING INDEX timetable_entries_class_subject (class_subject_id=?) |
| routes/setup/imports.ts:935 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/setup/imports.ts:943 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/setup/imports.ts:1144 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/setup/staff.ts:256 | SCAN e | SEARCH e USING COVERING INDEX employees_status_department (status=? AND department_id=?) |
| routes/setup/staff.ts:349 | SCAN staff_attendance | SEARCH staff_attendance USING INDEX staff_attendance_date_status (on_date>? AND on_date<?) |
| routes/statutory.ts:1486 | SCAN te | SEARCH te USING INDEX timetable_entries_year_section (academic_year_id=?) |
| routes/students.ts:632 | SCAN student_attendance; SCAN student_attendance | SEARCH student_attendance USING COVERING INDEX student_attendance_student_date (student_id=?); SEARCH student_ |
| routes/students.ts:642 | SCAN student_attendance | SEARCH student_attendance USING COVERING INDEX student_attendance_student_date (student_id=?) |
| routes/students.ts:647 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/students.ts:699 | SCAN e | SEARCH e USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/students.ts:726 | SCAN en | SEARCH en USING INDEX enrollments_student_enrolled (student_id=?) |
| routes/students.ts:745 | SCAN c | SEARCH c USING INDEX student_fee_components_student_year (student_id=?) |
| routes/teaching/comms.ts:233 | SCAN a | SCAN a USING INDEX announcements_publish_at |
| routes/teaching/comms.ts:299 | SCAN e | SCAN e USING COVERING INDEX enrollments_student_enrolled |
| routes/teaching/dashboards.ts:109 | SCAN lr | SEARCH lr USING INDEX leave_requests_status_kind (status=?) |
| routes/teaching/dashboards.ts:119 | SCAN st | SEARCH st USING INDEX students_status (status=?) |
| routes/teaching/dashboards.ts:249 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?) |
| routes/teaching/dashboards.ts:405 | SCAN es | SEARCH es USING INDEX exam_subjects_class_subject (class_subject_id=?) |
| routes/teaching/dashboards.ts:580 | SCAN lr | SEARCH lr USING COVERING INDEX leave_requests_status_kind (status=? AND subject_kind=?) |
| routes/teaching/lms.ts:190 | SCAN t | SEARCH t USING INDEX online_tests_section_subject (section_id=? AND class_subject_id=?) |
| routes/teaching/videos.ts:162 | SCAN l | SEARCH l USING COVERING INDEX lms_lessons_video (video_id=?) |
| routes/teaching/videos.ts:313 | SCAN lms_lessons | SEARCH lms_lessons USING COVERING INDEX lms_lessons_video (video_id=?) |
| routes/teaching/videos.ts:315 | SCAN lms_video_progress | SEARCH lms_video_progress USING INDEX lms_video_progress_video (video_id=?) |
| routes/teaching/videos.ts:316 | SCAN lms_lessons | SEARCH lms_lessons USING INDEX lms_lessons_video (video_id=?) |
| services/ai/briefs.ts:85 | SCAN s | SEARCH s USING INDEX sections_year (academic_year_id=?) |
| services/ai/briefs.ts:103 | SCAN payments | SEARCH payments USING INDEX payments_status_paid_on (status=? AND paid_on=?) |
| services/ai/briefs.ts:104 | SCAN payments | SEARCH payments USING INDEX payments_status_paid_on (status=? AND paid_on>? AND paid_on<?) |
| services/ai/briefs.ts:112 | SCAN applications | SEARCH applications USING COVERING INDEX applications_created (created_at>?) |
| services/ai/briefs.ts:113 | SCAN applications | SEARCH applications USING COVERING INDEX applications_status_decided (status=? AND decided_at>?) |
| services/ai/briefs.ts:114 | SCAN applications | SEARCH applications USING INDEX applications_status_decided (status=?) |
| services/ai/briefs.ts:115 | SCAN applications | SEARCH applications USING COVERING INDEX applications_status_decided (status=? AND decided_at>?) |
| services/ai/context.ts:42 | SCAN student_attendance | SEARCH student_attendance USING COVERING INDEX student_attendance_student_date (student_id=? AND on_date>?) |
| services/ai/context.ts:57 | SCAN rc | SEARCH rc USING INDEX report_cards_student_year (student_id=?) |
| services/ai/context.ts:94 | SCAN report_cards | SEARCH report_cards USING INDEX report_cards_remarks_by (class_teacher_remarks_by=?) |
| services/ai/warnings.ts:29 | SCAN st | SEARCH st USING INDEX students_status (status=?) |
| services/ai/warnings.ts:40 | SCAN student_attendance | SEARCH student_attendance USING INDEX student_attendance_date_status (on_date>? AND on_date<?) |
| services/ai/warnings.ts:93 | SCAN e | SEARCH e USING INDEX employees_status_department (status=?) |
| services/background/health.ts:50 | SCAN s | SEARCH s USING INDEX students_status (status=?) |
| services/background/housekeeping.ts:37 | SCAN login_events | SEARCH login_events USING INDEX login_events_created_at (created_at<?) |
| services/background/report-digest.ts:56 | SCAN applications; SCAN applications USING COVERING INDEX ap | SEARCH applications USING COVERING INDEX applications_status_decided (status=?); SEARCH applications USING COV |
| services/background/report-digest.ts:64 | SCAN staff_attendance | SEARCH staff_attendance USING INDEX staff_attendance_date_status (on_date>? AND on_date<?) |
| services/message_rules.ts:237 | SCAN announcements | SEARCH announcements USING INDEX announcements_publish_at (publish_at>? AND publish_at<?) |
| routes/admin/users.ts:607 | SCAN login_events | SEARCH login_events USING INDEX login_events_user_at (user_id=? AND at>?) |
| routes/seller/lifecycle.ts:408 | SCAN login_index | SEARCH login_index USING INDEX login_index_institution (institution_id=?) |
| services/background/housekeeping.ts:11 | SCAN sessions | SEARCH sessions USING INDEX sessions_expires (expires_at<?) |
| services/background/housekeeping.ts:23 | SCAN login_events | SEARCH login_events USING INDEX login_events_at (at<?) |
| services/background/housekeeping.ts:28 | SCAN jobs | SEARCH jobs USING INDEX jobs_finished (finished_at>? AND finished_at<?) |

## Read replicas (D1 Sessions API)

Every request that touches the school database runs in a D1 Session
(`tenantSession` in `tenant.ts`, wired in `src/index.ts`):

- a GET starts `first-unconstrained` (any replica), a write `first-primary`;
- if the request carries `X-D1-Bookmark: <school id>:<bookmark>`, the session starts from that
  bookmark, so it reads a copy at least as new as what the person last saw or wrote;
- every response carries the session's new bookmark in `X-D1-Bookmark`;
- `web/src/lib/api.ts` keeps the newest bookmark (per tab, sessionStorage) and sends it back.
- A bookmark for another school is ignored. Schools reached over the D1 HTTP API
  (no binding yet) have no sessions and read the primary.

Replication itself must be switched on per database. **Owner** (token with `D1:Edit`):

```
for ID in 097509b3-8425-464f-832b-bfe38a8273ed 73088586-9c8b-4a10-a130-8690782a1ddf \
          6ff7d5b9-01c8-48d8-94da-c52b4933ef1f 8485aae2-4795-408e-984a-93926d5133b0 \
          477538e2-da45-49d5-8176-79f20d7539f1; do
  curl -m 60 -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/$ID" \
    -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
    -d '{"read_replication": {"mode": "auto"}}'
done
```
(demo-school, demo, yajur, jsm, CONTROL.) Or in the dashboard: D1 -> database -> Settings -> Enable Read Replication.
Until then sessions still work and simply read the primary. CONTROL is read directly (not in a session) today.

## Reference cache

`services/refcache.ts` keeps, per school and per isolate: academic years (and the default
working year), each person's chosen working year, and /ref-data's classes, sections and subjects.
They are keyed on `ref_versions.version` (tenant migration 0018), which triggers bump on
any INSERT/UPDATE/DELETE of classes, sections, subjects, academic_years, user_working_years.
The version is re-read at most every 10 s; a write request in the same isolate drops the
school's entry at once, so the writer always reads its own change. Other isolates can lag by
up to 10 s.

Used by: every `workingYear*` helper (students, fees, setup, admissions, shell) — the
chosen-year and latest-year queries (2 round trips per request) are gone on a warm isolate —
and `GET /ref-data` (4 queries -> 0).

Feature switches and identities are cached by `src/idcache.ts` (the backend agent's identity cache,
keyed on CONTROL `cache_versions`, which CONTROL migration 0012 now creates properly).

## Archiving a closed year

```
cd worker
node scripts/archive-year.mjs --school <slug> --year <name|id> --remote            # dry run
node scripts/archive-year.mjs --school <slug> --year <name|id> --remote --confirm  # deletes
```
Exports the year's rows of the high-volume tables (attendance, message_log, notifications,
chats, audit_log, app/login events, session activity, LMS views, vehicle positions, ...; list
in the script) as gzipped JSONL to the `school-erp-d1-uploads` bucket (FILES_WRITE) under
`archive/<slug>/<year>/`, with a manifest; downloads each back and checks sha256, line count and
JSON; deletes only with `--confirm`, only rows inside the verified rowid range. Refuses the
current or an unclosed year. A dry run writes under `archive-dryrun/`; `--allow-open` lets a
dry run export an open year for rehearsal (never with `--confirm`).
Restore: download the `.jsonl.gz`, and insert each line's object back into its table.

## Backups

- Nightly (existing): `backup:fanout` -> SQL dumps written by the Worker, `backups/<slug>/<date>.sql.gz`, 30 daily + 12 monthly.
- Weekly (new): `backup:weekly_fanout` Saturday 21:00 UTC (Sunday 02:30 IST) -> `backup:weekly_export` per school
  uses Cloudflare's D1 export API, gzips into FILES_WRITE `backups/<slug>/weekly/<date>.sql.gz`, keeps the newest 8.
  Needs the Worker secrets `CF_ACCOUNT_ID` and `CF_API_TOKEN` (D1:Edit). An export briefly blocks the database, hence the night slot.

### Restore rehearsal
```
node scripts/restore-rehearsal.mjs --school demo-school
```
Exports the school (D1 export API), stores the backup in R2 as the weekly job does, downloads it
back, creates the scratch D1 `school-erp-restore-test`, loads it, compares row counts table by
table with the live database, and deletes the scratch database. `--from-r2 <key>` restores an
existing backup instead; `--keep` keeps the scratch database.

A D1 export is written table by table (CREATE, then its rows, in sqlite_master order), and D1
refuses a row whose foreign key names a table not yet created or a row not yet loaded, even with
`PRAGMA defer_foreign_keys` (the import commits in batches). A raw export therefore does NOT load
as is ("no such table: main.files", then FOREIGN KEY failures: users <-> files, self-referencing
syllabus_units, lms_lessons). The rehearsal script re-orders it through a local SQLite: every
CREATE TABLE first, rows parent-first, foreign keys that point back (cycles, self references)
loaded NULL and set by UPDATE afterwards, then indexes and triggers. Use the script, not a bare
`wrangler d1 execute --file`, for a real restore.

**Rehearsal run 2026-09-29, demo-school:** backup `backups/demo-school/weekly/2026-09-29.sql.gz`
(3.2 MB SQL) restored into `school-erp-restore-test`: 489 tables, 6,307 rows, 0 tables differ.
The scratch database was deleted. About 6 minutes.

**Archive dry run 2026-09-29, demo-school 2026-27** (`--allow-open`, the school has no closed
year): 2,300 rows over 12 tables exported to `archive-dryrun/demo-school/2026-27/`, every file
verified, nothing deleted. Tables without the named date column (transport_attendance, app_events,
lms_lesson_views, study_material_views, call_log) were skipped; give them their own column in
ARCHIVE when they matter.

### Off-site copy (owner)
R2 in the same account is not off-site. To keep copies in a separate Cloudflare account:
1. Create a second Cloudflare account (different owner email, 2FA) and in it an R2 bucket, e.g. `school-erp-offsite`, with a lifecycle rule deleting objects after 90 days.
2. In that account create an R2 API token scoped to that bucket only, Object Read & Write.
3. Either configure R2 Super Slurper / Sippy, or add the token to this Worker as secrets (`OFFSITE_R2_ENDPOINT`, `OFFSITE_R2_KEY_ID`, `OFFSITE_R2_SECRET`) so a job can copy `backups/*/weekly/*` there via the S3 API after each weekly export (not built yet; needs the account first).
4. Run the restore rehearsal from the off-site copy once a term.

## CONTROL housekeeping

CONTROL migration 0012 adds `cache_versions` (was created at runtime by idcache.ts) and indexes for the retention deletes (sessions.expires_at, created_at;
login_events.at and (user_id, at); login_throttle.window_started_at; jobs.finished_at;
login_index.institution_id). `session:prune` now runs daily (was weekly) and also purges
`login_throttle` rows whose window is over a day old and that hold no live lock.
`security:retention` (nightly) already trims login_events (1 year), old sessions and jobs.
