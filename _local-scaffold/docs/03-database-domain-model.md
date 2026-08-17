# 03 — Database Domain Model

PostgreSQL 16. Naming: `snake_case`, plural tables, `id uuid pk default gen_random_uuid()`.
Every tenant table carries `organization_id`, and `school_id` where applicable, plus
`created_at, updated_at, created_by, updated_by`, and `archived_at` where soft delete applies.
RLS policy on every tenant table: `USING (organization_id = current_setting('app.org_id')::uuid AND ...)`.

## Tenancy & identity

```
organizations(id, name, slug uq, plan, status, settings jsonb, region)
schools(id, organization_id fk, name, code uq(org), board_config jsonb, address jsonb,
        logo_file_id, timezone, locale, currency default 'INR', settings jsonb)
campuses(id, school_id fk, name, code uq(school), address jsonb, settings jsonb)
academic_years(id, school_id fk, name '2026-27', start_date, end_date, status enum
        (planned|active|closed), is_current bool)   -- partial uq: one current per school
terms(id, academic_year_id fk, name, kind enum(term|semester|quarter), start_date, end_date, seq)
school_calendar_days(id, campus_id, date, kind enum(working|holiday|weekend|exam|event),
        shift_id, label)                            -- uq(campus_id, date, shift_id)
shifts(id, campus_id, name, start_time, end_time)

users(id, organization_id, email citext, phone, password_hash, status,
      failed_attempts, locked_until, mfa_enabled, must_change_password,
      last_login_at)                                -- uq(organization_id, email)
user_identities(id, user_id, provider, provider_uid)          -- future SSO/phone OTP
sessions(id, user_id, refresh_token_hash, device, ip, user_agent, expires_at, revoked_at)
mfa_factors(id, user_id, kind enum(totp|sms), secret_encrypted, verified_at)
memberships(id, user_id, organization_id, school_id null, campus_id null,
            role_id, scope jsonb, status)           -- a user may hold several
roles(id, organization_id null, key, name, is_system bool, description)
permissions(key pk, domain, description, is_restricted bool)
role_permissions(role_id, permission_key)           -- pk(role_id, permission_key)
```

## SIS

```
students(id, organization_id, school_id, campus_id, admission_number uq(school),
   student_code, first_name, middle_name, last_name, preferred_name,
   dob, gender, blood_group, nationality, mother_tongue, religion null,
   category null, photo_file_id, address jsonb, contact jsonb,
   house_id, admission_date, status enum(applicant|active|transferred|withdrawn|
   graduated|alumni|dropped), previous_school jsonb, archived_at)
student_identifiers(id, student_id, kind enum(udise_pen|apaar|aadhaar_ref|board_roll|other),
   value_encrypted, issued_at, verified_at)         -- restricted; uq(kind, hash(value), school)
guardians(id, organization_id, first_name, last_name, relation_default, occupation,
   employer, phone, email, address jsonb, user_id null)
student_guardians(student_id, guardian_id, relation enum(father|mother|guardian|other),
   is_primary, is_emergency, financial_responsibility bool, pickup_authorized bool,
   comm_preferences jsonb, status)                  -- pk(student_id, guardian_id, relation)
grades(id, school_id, name 'Class 8', level int, stage enum(pre_primary|primary|middle|
   secondary|senior_secondary), board_stream null)
sections(id, grade_id, academic_year_id, name 'A', campus_id, capacity,
   class_teacher_staff_id, room_id)                 -- uq(grade_id, academic_year_id, name)
enrollments(id, student_id, academic_year_id, grade_id, section_id, roll_number,
   status enum(active|promoted|detained|transferred|withdrawn|graduated),
   started_on, ended_on, result_status)             -- partial uq: one active per (student, year)
student_lifecycle_events(id, student_id, kind, from_json, to_json, effective_date,
   reason, actor_user_id)
houses(id, school_id, name, color)
student_documents(id, student_id, category, file_id, expires_at, verified_by, verified_at)
health_records(id, student_id, kind, notes_encrypted, recorded_by, recorded_at)   -- restricted
discipline_incidents(id, school_id, occurred_at, severity, summary, confidential_notes_encrypted,
   status, reported_by, resolved_at)
discipline_participants(incident_id, student_id, role enum(involved|witness), action_taken)
```

## Admissions

```
admission_campaigns(id, school_id, academic_year_id, name, opens_at, closes_at, config jsonb)
enquiries(id, school_id, campaign_id, source, child_name, dob, grade_applied_id,
   parent_name, phone, email, status, owner_user_id, next_followup_at)
applications(id, school_id, campaign_id, enquiry_id, application_number uq(school),
   grade_applied_id, applicant jsonb, guardians jsonb, stage, status, score, rank,
   waitlist_position, offer_expires_at, submitted_at)
application_stage_events(id, application_id, stage, status, actor_user_id, remarks, at)
application_documents(id, application_id, category, file_id, status, verified_by)
entrance_tests(id, school_id, name, scheduled_at, venue, max_marks)
entrance_test_results(test_id, application_id, marks, status)
interviews(id, application_id, scheduled_at, panel jsonb, rating, remarks)
```

## Academics

```
subjects(id, school_id, name, code, kind enum(core|elective|language|co_scholastic|activity),
   is_graded, applicable_grades int[])
subject_groups(id, school_id, name, rule jsonb)     -- e.g. choose 1 of 3 languages
section_subjects(id, section_id, subject_id, weekly_periods, is_optional)
student_subjects(id, enrollment_id, subject_id, elected_at)   -- electives/languages
subject_allocations(id, section_id, subject_id, staff_id, academic_year_id)  -- teaching rights
curricula(id, school_id, subject_id, grade_id, version, status)
curriculum_units(id, curriculum_id, seq, title, outcomes jsonb)
lesson_plans(id, curriculum_unit_id, staff_id, planned_date, content, status)
periods(id, campus_id, shift_id, seq, name, start_time, end_time, is_break)
timetable_versions(id, section_id?, academic_year_id, effective_from, status)
timetable_slots(id, timetable_version_id, section_id, day_of_week, period_id,
   subject_id, staff_id, room_id)
   -- exclusion/unique indexes: (staff_id,day,period) , (room_id,day,period), (section_id,day,period)
substitutions(id, timetable_slot_id, date, absent_staff_id, substitute_staff_id, reason)
rooms(id, campus_id, name, kind, capacity)

attendance_sessions(id, section_id, date, period_id null, taken_by_staff_id, taken_at,
   locked_at)                                       -- uq(section_id, date, period_id)
attendance_records(id, attendance_session_id, student_id, status enum(present|absent|
   late|half_day|leave|excused), minutes_late, remark)   -- uq(session, student)
attendance_corrections(id, attendance_record_id, old_status, new_status, reason,
   requested_by, approved_by, approved_at, status)
staff_attendance(id, staff_id, date, status, in_time, out_time, source)

leave_types(id, school_id, applies_to enum(student|staff), name, annual_quota,
   is_paid, requires_document, workflow jsonb)
leave_requests(id, leave_type_id, subject_kind, student_id null, staff_id null,
   from_date, to_date, half_day, reason, document_file_id, status, decided_by, decided_at)
leave_balances(id, leave_type_id, staff_id, academic_year_id, entitled, used)

assignments(id, section_id, subject_id, staff_id, title, description, due_at,
   max_marks, attachments jsonb, published_at)
assignment_submissions(id, assignment_id, student_id, submitted_at, files jsonb,
   marks, feedback, graded_by, graded_at, status)
courses / course_modules / course_items / course_progress   -- LMS, same tenancy pattern
```

## Examinations

```
exam_types(id, school_id, name 'FA1'|'SA1'|'Term 1', weightage numeric, config jsonb)
examinations(id, school_id, academic_year_id, term_id, exam_type_id, name,
   status enum(draft|scheduled|in_progress|marks_entry|verification|approved|published|locked),
   published_at, locked_at)
exam_papers(id, examination_id, grade_id, subject_id, component enum(theory|practical|
   internal|project|activity), max_marks, pass_marks, weightage, exam_date, start_time, duration_min)
exam_schedules(id, exam_paper_id, section_id, room_id, invigilator_staff_id)
marks(id, exam_paper_id, student_id, enrollment_id, obtained numeric null,
   status enum(entered|absent|malpractice|withheld|exempt),
   entered_by, entered_at, verified_by, verified_at, moderation_delta, grace_marks,
   locked bool)                                     -- uq(exam_paper_id, student_id)
marks_history(id, marks_id, old_json, new_json, reason, actor_user_id, at)   -- append-only
grade_scales(id, school_id, name, kind enum(percentage|grade|gpa), bands jsonb)
exam_results(id, examination_id, enrollment_id, total, percentage, gpa, grade,
   rank, percentile, result_status enum(pass|fail|withheld|compartment),
   grade_scale_snapshot jsonb, computed_at)
report_card_templates(id, school_id, name, version, layout jsonb, status)
report_cards(id, examination_id null, academic_year_id, enrollment_id, template_id,
   version, payload jsonb, pdf_file_id, published_at)   -- versioned, never overwritten
remarks(id, report_card_id, kind enum(teacher|principal), text, author_staff_id)
```

## Finance

```
fee_heads(id, school_id, name 'Tuition', account_id, is_refundable, taxable)
fee_structures(id, school_id, academic_year_id, name, applicable jsonb {grades, campuses,
   categories}, status)
fee_structure_components(id, fee_structure_id, fee_head_id, amount, frequency
   enum(one_time|monthly|term|annual), installment_plan jsonb, due_rule jsonb, late_fee_rule jsonb)
fee_assignments(id, student_id, academic_year_id, fee_structure_id, effective_from, status)
fee_concessions(id, fee_assignment_id, fee_head_id null, kind enum(discount|scholarship|
   waiver|sibling|staff_ward), value_type enum(percent|amount), value, reason,
   requested_by, approved_by, approved_at, status)
invoices(id, school_id, student_id, academic_year_id, invoice_number uq(school, fy),
   issue_date, due_date, subtotal, discount_total, late_fee, total, amount_paid,
   status enum(draft|issued|partially_paid|paid|overdue|void|written_off), void_reason)
invoice_lines(id, invoice_id, fee_head_id, description, amount, discount, tax)
payment_intents(id, school_id, student_id, amount, currency, provider, provider_ref,
   idempotency_key uq, status, created_by, expires_at)
payments(id, school_id, student_id, payment_intent_id null, amount, method enum(cash|
   cheque|dd|bank_transfer|upi|card|netbanking|gateway), provider, provider_payment_id,
   status enum(pending|succeeded|failed|refunded|partially_refunded), paid_at,
   instrument jsonb, collected_by_user_id, reconciled_at)
   -- uq(provider, provider_payment_id)
payment_allocations(id, payment_id, invoice_id, invoice_line_id null, amount)
receipts(id, payment_id, receipt_number uq(school, fy), issued_at, pdf_file_id)  -- immutable
refunds(id, payment_id, amount, reason, requested_by, approved_by, status,
   provider_refund_id, processed_at)
credit_notes(id, invoice_id, amount, reason, issued_by, issued_at)
webhook_events(id, provider, provider_event_id uq, payload jsonb, signature_valid,
   received_at, processed_at, processing_error)
-- accounting (double entry)
accounts(id, school_id, code, name, type enum(asset|liability|income|expense|equity), parent_id)
journal_entries(id, school_id, entry_date, source_kind, source_id, narration, posted_at)
journal_lines(id, journal_entry_id, account_id, debit, credit, cost_center)
   -- CHECK: sum(debit) = sum(credit) per entry, enforced by trigger
expenses(id, school_id, vendor_id, category_account_id, amount, date, status, approved_by)
vendors(id, organization_id, name, gstin, contact jsonb, bank jsonb, status)
```

## HR, operations, platform

```
departments, designations
staff(id, school_id, employee_id uq(school), user_id, name..., department_id, designation_id,
   employment_type, joining_date, exit_date, qualifications jsonb, bank_encrypted jsonb, status)
staff_documents, staff_experience
salary_structures(id, school_id, name), salary_components(id, structure_id, name,
   kind enum(earning|deduction), calc jsonb)
staff_salary_assignments(staff_id, structure_id, effective_from, overrides jsonb)
payroll_runs(id, school_id, month, status, processed_by, approved_by)
payslips(id, payroll_run_id, staff_id, gross, deductions, net, breakdown jsonb, pdf_file_id)

books(id, school_id, title, author, publisher, isbn, category, language)
book_copies(id, book_id, accession_number uq(school), shelf, rack, status enum(available|
   issued|reserved|lost|damaged|withdrawn))
library_members(id, school_id, subject_kind, student_id null, staff_id null, card_number,
   max_books, status)
library_transactions(id, book_copy_id, member_id, kind enum(issue|return|renew|reserve|lost),
   issued_at, due_at, returned_at, fine_amount, fine_paid)

vehicles(id, campus_id, registration_number uq, type, capacity, insurance jsonb, permit jsonb,
   fitness_expiry, status)
drivers(id, staff_id, license_number, license_expiry)
routes(id, campus_id, name, vehicle_id, driver_id, attendant_id, shift, capacity_override)
route_stops(id, route_id, seq, name, geo point, pickup_time, drop_time)
transport_assignments(id, student_id, academic_year_id, route_id, pickup_stop_id,
   drop_stop_id, status)                            -- capacity enforced by trigger + app check
vehicle_maintenance, transport_incidents

hostels(id, campus_id, name, kind), hostel_blocks, hostel_rooms(id, block_id, number, capacity)
beds(id, room_id, label)                            -- uq(room_id, label)
hostel_assignments(id, student_id, bed_id, from_date, to_date, status)
   -- partial uq(bed_id) where status='active'
hostel_visitors, hostel_attendance

item_categories, items(id, school_id, name, sku, unit, reorder_level)
warehouses, stock_levels(item_id, warehouse_id, quantity)  -- pk(item, warehouse)
stock_movements(id, item_id, warehouse_id, kind enum(purchase|issue|return|damage|adjust),
   quantity, reference_kind, reference_id, at, by)
assets(id, school_id, category, name, serial_number, purchase_date, cost, warranty_until,
   location, assigned_staff_id, depreciation jsonb, status, disposed_at)
purchase_requests, quotations, purchase_orders, po_lines, goods_receipts, vendor_invoices

announcements(id, school_id, title, body, audience jsonb, channels[], scheduled_at,
   published_at, created_by)
notification_templates(id, school_id null, event_key, channel, locale, subject, body,
   variables jsonb, version)
notifications(id, organization_id, user_id, event_key, channel, payload jsonb,
   status enum(queued|sent|delivered|failed|read), provider_ref, attempts, error, sent_at)
notification_preferences(user_id, event_key, channel, enabled)
events(id, school_id, kind, title, starts_at, ends_at, audience jsonb, location)

files(id, organization_id, school_id, bucket, object_key, mime, size_bytes, checksum,
   scan_status, uploaded_by, purpose, retention_until)
documents(id, owner_kind, owner_id, category, file_id, version, expires_at, verified_by)
audit_logs(id, organization_id, school_id, actor_user_id, actor_role, action, entity_kind,
   entity_id, before jsonb, after jsonb, reason, ip, user_agent, request_id, at)
   -- append-only: REVOKE UPDATE/DELETE; monthly partitions on `at`
outbox_events(id, aggregate, event_key, payload, published_at)
import_jobs(id, school_id, kind, file_id, status, total_rows, valid_rows, error_file_id,
   preview jsonb, committed_at, created_by)
export_jobs(id, school_id, report_key, params jsonb, format, status, file_id, requested_by)
sequences(id, school_id, key, scope, current_value)   -- gapless numbering, row-locked
feature_flags(id, organization_id null, key, enabled, config jsonb)
```

### Indexing strategy (the ones that matter)
- Every tenant table: `(organization_id, school_id, <natural filter>)` composite leading index.
- `attendance_records`: `(student_id, date)` via session join → denormalize `date` onto the record for the student-history query; partition `attendance_records` by academic year at scale.
- `marks`: `(exam_paper_id, student_id)` unique; `(student_id)` for transcripts.
- `invoices`: `(school_id, status, due_date)` for the outstanding-fees report; `(student_id, academic_year_id)`.
- `audit_logs`: partitioned monthly, `(entity_kind, entity_id, at desc)` and `(actor_user_id, at desc)`.
- Trigram indexes on `students.first_name/last_name/admission_number` for global search; full-text `tsvector` column maintained by trigger.

### Data lifecycle
Soft delete (`archived_at`) for master data; **never** for financial, marks, attendance, or audit rows. Historical enrollments, marks, invoices and ledger entries are append-only. Retention and erasure (DPDP) handled by a documented anonymisation routine that preserves financial aggregates while removing personal identifiers.
