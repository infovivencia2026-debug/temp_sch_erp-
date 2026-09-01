-- Claimed as 00048; may be renumbered at integration. Nothing in this file
-- depends on its own number, and the only ordering requirement is that it lands
-- after 00038 (sqaa_frameworks, sqaa_standards, academic_calendar_models) and
-- after 00043 (board_registrations' candidate columns).
-- +goose Up
-- Statutory filings: what the school sends the state, and what it keeps.
--
-- Five features, one migration, because they share one idea — a return is a
-- snapshot with a name against it, not a query re-run later. A UDISE+ figure
-- disputed in 2029 is defended by what was filed in 2026, and re-deriving it
-- from live tables that have since been corrected answers a different
-- question. Every "file" verb below freezes rows and stamps who and when.
--
-- What already exists and is therefore NOT rebuilt here:
--
--   sqaa_frameworks /      00038. Framework -> domain -> standard -> indicator
--   sqaa_standards         as one self-referencing tree, published by the
--                          vendor and read by every school. This migration
--                          adds only the school's side: what it rated itself,
--                          what it attached, and what it is going to do about
--                          the gaps. A per-tenant copy of the framework would
--                          let a school edit the standard it is measured by.
--
--   board_registrations    00008, widened by 00043. Already carries the
--                          candidate snapshot the LOC needs -- candidate_name,
--                          father_name, mother_name, date_of_birth, apaar_id,
--                          medium, second_language, group_code, subjects,
--                          fee_paid_paise. The LOC is a *filing* of those
--                          rows, not a second register of candidates.
--
--   holidays               00001/00036. kind IN (holiday, vacation, exam,
--                          event, ptm, working_day) with a date range; the
--                          'working_day' kind is the escape hatch that pulls a
--                          Sunday back in after a bandh. Working days are
--                          counted from this, not from a new calendar.
--
--   periods /              00001. periods.starts_at/ends_at give a period its
--   timetable_entries      length; timetable_entries (section_id, weekday,
--                          period_id) says which sections sit in it.
--                          Instructional hours are derived from those two.
--
--   academic_calendar_models  00038. required_working_days per school, set by
--                          the vendor. Used as the fallback minimum when a
--                          school has not recorded a per-stage norm.
--
--   files                  00001. Evidence documents are files(id) referenced
--                          from a child table, the student_documents shape.
--                          files.owner_type/owner_id exist in the baseline but
--                          are dead in Go -- nothing reads them -- so they are
--                          not used here either.
--
--   integrations           00001. Per-school provider credentials. Deliberately
--                          NOT used for the Child Info portal connector, which
--                          is per-state platform configuration: integrations
--                          is institution-scoped and its RLS policy lets an
--                          institution admin read their own row. See the
--                          connector table's comment.

-- ========================================================================
-- 1. Board Exam LOC submission
-- ========================================================================

/* Photograph and signature, on the registration rather than on the student.

   The board wants the image that was pasted on the form it holds. A school
   that replaces a child's profile photo in March has not changed what it filed
   in January, and a validation that read students.photo_file_id would quietly
   start passing -- or failing -- on a fact the board never saw.

   Nullable, and the validator falls back to students.photo_file_id for the
   photo so a school that has not re-uploaded is not blocked on day one. There
   is no fallback for the signature: nothing in the schema holds one. */
ALTER TABLE board_registrations
    ADD COLUMN IF NOT EXISTS photo_file_id     uuid REFERENCES files(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS signature_file_id uuid REFERENCES files(id) ON DELETE SET NULL;

/* What subject combination the board will accept.

   00043 validates a candidate's subjects only as "not empty", and an
   Intermediate group only as "not blank". That is enough to catch a clerk who
   skipped a field and useless against the actual rejection: MPC with Biology
   in it, or a second language the board does not offer for that medium. The
   rule has to be data because it differs by board, by stage and by year, and
   nobody is shipping a release to add Sanskrit.

   min_subjects/max_subjects bound the count; the options below say which. */
CREATE TABLE loc_subject_groups (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    board          text NOT NULL,
    stage          text NOT NULL,
    -- MPC, BiPC, CEC, MEC, HEC for Intermediate. NULL for SSC, which has no
    -- group -- hence the COALESCE in the unique index below.
    group_code     text,
    name           text NOT NULL,
    min_subjects   integer NOT NULL DEFAULT 1,
    max_subjects   integer NOT NULL DEFAULT 8,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT loc_subject_groups_stage
        CHECK (stage IN ('ssc','inter_first_year','inter_second_year')),
    CONSTRAINT loc_subject_groups_count
        CHECK (min_subjects >= 1 AND max_subjects >= min_subjects AND max_subjects <= 20),
    CONSTRAINT loc_subject_groups_name_present CHECK (btrim(name) <> '')
);

/* group_code is nullable, so a bare UNIQUE would enforce nothing against a
   second SSC rule for the same board: NULL is distinct from every NULL. */
CREATE UNIQUE INDEX loc_subject_groups_one_per_combination
    ON loc_subject_groups (institution_id, lower(board), stage, COALESCE(group_code, ''));

COMMENT ON TABLE loc_subject_groups IS
    'A subject combination the board accepts, per board and stage. Seeded editable because boards revise their offerings; read by the LOC validator in internal/api/statutory.go.';

CREATE TABLE loc_subject_options (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    group_id       uuid NOT NULL REFERENCES loc_subject_groups(id) ON DELETE CASCADE,

    -- The board's own code, which is what an LOC file carries. The name is
    -- what the roll was typed with, and the validator matches on either.
    subject_code   text NOT NULL,
    subject_name   text NOT NULL,
    is_mandatory   boolean NOT NULL DEFAULT false,
    sequence       integer NOT NULL DEFAULT 0,

    CONSTRAINT loc_subject_options_code_present CHECK (btrim(subject_code) <> ''),
    CONSTRAINT loc_subject_options_name_present CHECK (btrim(subject_name) <> '')
);

CREATE UNIQUE INDEX loc_subject_options_one_per_code
    ON loc_subject_options (group_id, upper(subject_code));
CREATE INDEX loc_subject_options_by_group
    ON loc_subject_options (institution_id, group_id, sequence);

/* One filing of the List of Candidates.

   A submission is the unit that gets frozen. While it is a draft it is a
   working set the school adds to and revalidates; once filed, its candidate
   rows and its validation report are what was sent, and neither moves again
   however much the underlying registration is later corrected through the
   00043 amendment workflow. */
CREATE TABLE loc_submissions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,

    board            text NOT NULL,
    exam_name        text NOT NULL,
    stage            text,
    title            text NOT NULL,

    -- What the board charges per candidate this session. Paise, like every
    -- other money column: the validator compares it against the registration's
    -- fee_paid_paise, and a float here would make "paid in full" a rounding
    -- question.
    fee_per_candidate_paise bigint NOT NULL DEFAULT 0,

    status           text NOT NULL DEFAULT 'draft',
    candidate_count  integer NOT NULL DEFAULT 0,
    blocker_count    integer NOT NULL DEFAULT 0,
    warning_count    integer NOT NULL DEFAULT 0,
    validated_at     timestamptz,

    filed_at         timestamptz,
    filed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    board_ack_no     text,
    notes            text,

    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT loc_submissions_status
        CHECK (status IN ('draft','filed','cancelled')),
    CONSTRAINT loc_submissions_stage
        CHECK (stage IS NULL OR stage IN ('ssc','inter_first_year','inter_second_year')),
    CONSTRAINT loc_submissions_fee_sane
        CHECK (fee_per_candidate_paise >= 0),
    CONSTRAINT loc_submissions_title_present CHECK (btrim(title) <> ''),
    -- A filed submission is stamped. Without this a row could reach 'filed'
    -- with no filer and no time, which is the one thing an audit asks for.
    CONSTRAINT loc_submissions_filed_is_stamped
        CHECK (status <> 'filed' OR filed_at IS NOT NULL)
);

/* One open draft per exam sitting. Two drafts for the same SSC session is how
   a school files half its candidates twice: both look complete on their own
   screen. stage is nullable, so COALESCE. */
CREATE UNIQUE INDEX loc_submissions_one_draft
    ON loc_submissions (institution_id, academic_year_id, lower(board),
                        lower(exam_name), COALESCE(stage, ''))
 WHERE status = 'draft';

CREATE INDEX loc_submissions_recent
    ON loc_submissions (institution_id, academic_year_id, created_at DESC);

COMMENT ON TABLE loc_submissions IS
    'One filing of the board List of Candidates. Draft is a working set; filed is immutable and is what the board holds.';

/* The candidate as filed.

   Every column here is a copy, not a join. board_registrations is the live
   record and will be corrected; this is the paper. registration_id and
   student_id are ON DELETE SET NULL for the same reason -- a withdrawn student
   does not retract a filing that has already gone to the board. */
CREATE TABLE loc_candidates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    submission_id   uuid NOT NULL REFERENCES loc_submissions(id) ON DELETE CASCADE,
    registration_id uuid REFERENCES board_registrations(id) ON DELETE SET NULL,
    student_id      uuid REFERENCES students(id) ON DELETE SET NULL,

    serial_no       integer NOT NULL,
    candidate_name  text,
    father_name     text,
    mother_name     text,
    date_of_birth   date,
    gender          text,
    class_label     text,
    admission_no    text,
    medium          text,
    second_language text,
    group_code      text,
    candidate_type  text,
    apaar_id        text,
    registration_no text,
    hall_ticket_no  text,
    subjects        jsonb NOT NULL DEFAULT '[]'::jsonb,
    fee_paid_paise  bigint NOT NULL DEFAULT 0,
    has_photo       boolean NOT NULL DEFAULT false,
    has_signature   boolean NOT NULL DEFAULT false,

    -- Anything the board's format wants that this schema did not anticipate,
    -- captured at filing time so the export can be regenerated byte-for-byte.
    snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT loc_candidates_serial CHECK (serial_no >= 1)
);

/* registration_id is nullable (SET NULL above), so the COALESCE guard is what
   actually stops one registration appearing twice in the same filing. */
CREATE UNIQUE INDEX loc_candidates_one_per_registration
    ON loc_candidates (submission_id,
                       COALESCE(registration_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE UNIQUE INDEX loc_candidates_serial_unique
    ON loc_candidates (submission_id, serial_no);
CREATE INDEX loc_candidates_by_submission
    ON loc_candidates (institution_id, submission_id, serial_no);

COMMENT ON TABLE loc_candidates IS
    'A candidate as filed, copied from board_registrations at submission time. Never updated after the submission is filed — the live record is board_registrations.';

/* Why a candidate is not submittable.

   The point of the whole feature. A rejected LOC is re-filed under deadline
   with the board unhelpful about which of 300 rows was wrong, so the report is
   the deliverable and the export is the easy part. Rows are recomputed on
   every validate of a draft and frozen when the submission is filed, which is
   how a school can later show the board that the row it is complaining about
   was flagged, considered and sent anyway. */
CREATE TABLE loc_validation_issues (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    submission_id   uuid NOT NULL REFERENCES loc_submissions(id) ON DELETE CASCADE,
    registration_id uuid REFERENCES board_registrations(id) ON DELETE SET NULL,
    student_id      uuid REFERENCES students(id) ON DELETE SET NULL,

    candidate_name  text,
    admission_no    text,
    severity        text NOT NULL DEFAULT 'blocker',
    code            text NOT NULL,
    field           text,
    message         text NOT NULL,
    detected_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT loc_validation_issues_severity
        CHECK (severity IN ('blocker','warning')),
    CONSTRAINT loc_validation_issues_message_present CHECK (btrim(message) <> '')
);

CREATE INDEX loc_validation_issues_by_submission
    ON loc_validation_issues (institution_id, submission_id, severity);

COMMENT ON COLUMN loc_validation_issues.severity IS
    'blocker stops the candidate being filed; warning is filed with a note. Only blockers hold a submission back.';

-- ========================================================================
-- 2. SQAA compliance tracking (the school's side of the 00038 framework)
-- ========================================================================

/* One self-assessment cycle against one published framework version.

   framework_code carries no foreign key, and that is deliberate. The framework
   is platform data the vendor edits and retires; an FK would either cascade a
   school's assessment history away when a framework is withdrawn, or block the
   vendor from ever withdrawing one. An assessment must outlive the framework
   it was made under -- that is what "assessed under the 2023 rules" means. */
CREATE TABLE sqaa_assessments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,

    framework_code   text NOT NULL,
    -- Copied at creation so the record still reads when the framework is gone.
    framework_name   text,
    framework_version text,

    title            text NOT NULL,
    status           text NOT NULL DEFAULT 'draft',
    started_on       date,
    due_on           date,

    -- Weighted score in basis points, matching sqaa_standards.weight_bp, so a
    -- framework whose domains are 12.5% each totals 10000 and not 99.9.
    score_bp         integer,
    max_score_bp     integer,

    submitted_at     timestamptz,
    submitted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    notes            text,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sqaa_assessments_status
        CHECK (status IN ('draft','in_progress','submitted','closed')),
    CONSTRAINT sqaa_assessments_title_present CHECK (btrim(title) <> ''),
    CONSTRAINT sqaa_assessments_dates
        CHECK (due_on IS NULL OR started_on IS NULL OR due_on >= started_on),
    CONSTRAINT sqaa_assessments_score_range
        CHECK (score_bp IS NULL OR (score_bp >= 0 AND score_bp <= 10000)),
    CONSTRAINT sqaa_assessments_submitted_is_stamped
        CHECK (status NOT IN ('submitted','closed') OR submitted_at IS NOT NULL)
);

-- academic_year_id is nullable -- a trust may run an assessment outside the
-- year cycle -- so the guard is required for the index to enforce anything.
CREATE UNIQUE INDEX sqaa_assessments_one_per_cycle
    ON sqaa_assessments (institution_id, framework_code,
                         COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid),
                         lower(title));
CREATE INDEX sqaa_assessments_open
    ON sqaa_assessments (institution_id, status, due_on);

COMMENT ON TABLE sqaa_assessments IS
    'A school self-assessment against a platform-published SQAA framework (sqaa_frameworks/sqaa_standards, 00038). The framework is never copied per tenant; only the rating is.';

/* One rating against one standard or indicator.

   standard_id also carries no FK, and additionally snapshots the standard's
   code and name. The framework tree is editable by the vendor; a school that
   rated "3.2 Teacher professional development" must still be able to read what
   3.2 said when it rated it, even after the 2026 revision renumbers it. */
CREATE TABLE sqaa_assessment_entries (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    assessment_id  uuid NOT NULL REFERENCES sqaa_assessments(id) ON DELETE CASCADE,

    standard_id    uuid NOT NULL,
    standard_code  text,
    standard_name  text,
    domain_code    text,
    domain_name    text,

    rating         text NOT NULL DEFAULT 'not_assessed',
    -- Score for this standard in basis points of its own weight.
    score_bp       integer,
    weight_bp      integer NOT NULL DEFAULT 0,
    evidence_required boolean NOT NULL DEFAULT false,
    remarks        text,
    assessed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    assessed_at    timestamptz,

    CONSTRAINT sqaa_assessment_entries_rating
        CHECK (rating IN ('not_assessed','not_met','partially_met','met','exceeds','not_applicable')),
    CONSTRAINT sqaa_assessment_entries_score_range
        CHECK (score_bp IS NULL OR (score_bp >= 0 AND score_bp <= 10000)),
    CONSTRAINT sqaa_assessment_entries_weight
        CHECK (weight_bp BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX sqaa_assessment_entries_one_per_standard
    ON sqaa_assessment_entries (assessment_id, standard_id);
CREATE INDEX sqaa_assessment_entries_by_assessment
    ON sqaa_assessment_entries (institution_id, assessment_id);

COMMENT ON COLUMN sqaa_assessment_entries.standard_id IS
    'sqaa_standards.id, without a foreign key: the framework is platform data that may be revised or retired, and the assessment must survive it. standard_code/name are snapshotted for the same reason.';

/* Evidence, as a link to files -- not a new storage mechanism.

   external_url is the concession to reality: R2 is unconfigured on the current
   deployment, POST /api/v1/files/presign answers 503, and no file_id can be
   minted at all. study_materials (00041) made the same allowance. Exactly one
   of the two must be present. */
CREATE TABLE sqaa_evidence (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    entry_id       uuid NOT NULL REFERENCES sqaa_assessment_entries(id) ON DELETE CASCADE,

    file_id        uuid REFERENCES files(id) ON DELETE CASCADE,
    external_url   text,
    caption        text NOT NULL,
    added_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    added_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sqaa_evidence_has_target
        CHECK ((file_id IS NOT NULL) <> (external_url IS NOT NULL)),
    CONSTRAINT sqaa_evidence_caption_present CHECK (btrim(caption) <> '')
);

-- file_id is nullable, so without the COALESCE this index would let the same
-- document be attached to one entry any number of times.
CREATE UNIQUE INDEX sqaa_evidence_one_per_document
    ON sqaa_evidence (entry_id,
                      COALESCE(file_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      COALESCE(lower(external_url), ''));
CREATE INDEX sqaa_evidence_by_entry ON sqaa_evidence (institution_id, entry_id);

/* The gap, and who is fixing it by when.

   A self-assessment that records a 2-out-of-4 and stops is a scoring exercise.
   The action plan is the part an inspector reads, so an item carries an owner
   and a due date and nothing else makes it closeable. */
CREATE TABLE sqaa_action_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    assessment_id  uuid NOT NULL REFERENCES sqaa_assessments(id) ON DELETE CASCADE,
    entry_id       uuid REFERENCES sqaa_assessment_entries(id) ON DELETE SET NULL,

    standard_code  text,
    title          text NOT NULL,
    detail         text,
    owner_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
    -- Kept alongside the id because an action plan filed in 2026 should still
    -- name its owner after that employee's row is gone.
    owner_name     text,
    due_on         date,
    priority       text NOT NULL DEFAULT 'normal',
    status         text NOT NULL DEFAULT 'open',
    progress_note  text,
    closed_at      timestamptz,
    closed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sqaa_action_items_status
        CHECK (status IN ('open','in_progress','done','dropped')),
    CONSTRAINT sqaa_action_items_priority
        CHECK (priority IN ('low','normal','high')),
    CONSTRAINT sqaa_action_items_title_present CHECK (btrim(title) <> ''),
    CONSTRAINT sqaa_action_items_closed_is_stamped
        CHECK (status NOT IN ('done','dropped') OR closed_at IS NOT NULL)
);

CREATE INDEX sqaa_action_items_open
    ON sqaa_action_items (institution_id, status, due_on)
 WHERE status IN ('open','in_progress');
CREATE INDEX sqaa_action_items_by_assessment
    ON sqaa_action_items (institution_id, assessment_id);

-- ========================================================================
-- 3. Child Info reconciliation
-- ========================================================================

/* One portal extract, loaded and diffed.

   The state's Child Info portal holds its own roster and the school's drifts
   from it -- a child admitted here in June who the portal still shows at the
   previous school, a date of birth typed differently at each end. There is no
   API, so the input is the extract a clerk downloads. */
CREATE TABLE child_info_imports (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,

    source_label     text,
    file_name        text,
    row_count        integer NOT NULL DEFAULT 0,
    portal_only_count  integer NOT NULL DEFAULT 0,
    school_only_count  integer NOT NULL DEFAULT 0,
    mismatch_count     integer NOT NULL DEFAULT 0,
    -- How many differences this run raised that a previous run had already
    -- settled, and therefore did not show anybody. The number that tells a
    -- head whether the resolutions are doing their job.
    suppressed_count   integer NOT NULL DEFAULT 0,

    imported_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    imported_at      timestamptz NOT NULL DEFAULT now(),
    note             text
);

CREATE INDEX child_info_imports_recent
    ON child_info_imports (institution_id, imported_at DESC);

/* The portal's rows, as given. Kept verbatim so a disputed difference can be
   traced to the line it came from rather than to our parse of it. */
CREATE TABLE child_info_rows (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    import_id      uuid NOT NULL REFERENCES child_info_imports(id) ON DELETE CASCADE,

    line_no        integer NOT NULL,
    child_info_id  text,
    student_name   text,
    father_name    text,
    mother_name    text,
    date_of_birth  date,
    gender         text,
    aadhaar_last4  text,
    apaar_id       text,
    class_label    text,
    section_label  text,
    admission_no   text,
    raw            jsonb NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT child_info_rows_line CHECK (line_no >= 1)
);

CREATE UNIQUE INDEX child_info_rows_one_per_line
    ON child_info_rows (import_id, line_no);
CREATE INDEX child_info_rows_by_child_id
    ON child_info_rows (institution_id, import_id, child_info_id);

/* A settled difference, and what was decided about it.

   This table, not the difference table, is the feature. A three-way diff that
   re-raises the same 400 rows every month is a report nobody opens by the
   third run: the school has already decided that Ramesh's portal spelling is
   the portal's problem, and being told again is noise.

   Keyed on the identity of the difference rather than on an import, so it
   outlives the extract that raised it. The values it was settled at are stored
   with it: if the portal later changes its answer, the difference is genuinely
   new and must come back. Accepting a mismatch is not accepting every future
   mismatch on that field. */
CREATE TABLE child_info_resolutions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    kind           text NOT NULL,
    -- The stable identity of the child across imports: the Child Info id when
    -- the portal knows them, otherwise 'student:<uuid>' for a child only we
    -- hold. Text because those two namespaces are not the same type.
    match_key      text NOT NULL,
    field          text,

    portal_value   text,
    school_value   text,
    action         text NOT NULL,
    note           text,
    resolved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    resolved_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT child_info_resolutions_kind
        CHECK (kind IN ('portal_only','school_only','field_mismatch')),
    CONSTRAINT child_info_resolutions_action
        CHECK (action IN ('fix_local','mark_for_portal','accept')),
    CONSTRAINT child_info_resolutions_key_present CHECK (btrim(match_key) <> ''),
    -- A field mismatch without a field cannot be matched against next month's
    -- diff, so it would suppress everything or nothing.
    CONSTRAINT child_info_resolutions_field_for_mismatch
        CHECK (kind <> 'field_mismatch' OR field IS NOT NULL)
);

/* One live resolution per difference identity. field is NULL for the two
   whole-child kinds, so the COALESCE is what stops a second 'accept' for the
   same child sitting alongside the first and making "is this settled?"
   ambiguous. */
CREATE UNIQUE INDEX child_info_resolutions_one_per_difference
    ON child_info_resolutions (institution_id, kind, match_key, COALESCE(field, ''));

COMMENT ON TABLE child_info_resolutions IS
    'A difference the school has already decided about. Survives the import that raised it; re-raised only if the values change. Without this the reconciliation is a diff you cannot dismiss.';
COMMENT ON COLUMN child_info_resolutions.action IS
    'fix_local = our record is wrong and was corrected; mark_for_portal = the portal is wrong and the school will file a change; accept = the two differ legitimately and that is known.';

/* One difference raised by one run. Disposable -- the durable decision is in
   child_info_resolutions above. */
CREATE TABLE child_info_differences (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    import_id      uuid NOT NULL REFERENCES child_info_imports(id) ON DELETE CASCADE,

    kind           text NOT NULL,
    match_key      text NOT NULL,
    field          text,
    portal_value   text,
    school_value   text,

    row_id         uuid REFERENCES child_info_rows(id) ON DELETE SET NULL,
    student_id     uuid REFERENCES students(id) ON DELETE SET NULL,
    child_info_id  text,
    display_name   text,
    admission_no   text,

    status         text NOT NULL DEFAULT 'open',
    resolution_id  uuid REFERENCES child_info_resolutions(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT child_info_differences_kind
        CHECK (kind IN ('portal_only','school_only','field_mismatch')),
    CONSTRAINT child_info_differences_status
        CHECK (status IN ('open','resolved','suppressed'))
);

CREATE UNIQUE INDEX child_info_differences_one_per_identity
    ON child_info_differences (import_id, kind, match_key, COALESCE(field, ''));
CREATE INDEX child_info_differences_open
    ON child_info_differences (institution_id, import_id, kind) WHERE status = 'open';

COMMENT ON COLUMN child_info_differences.status IS
    'open = needs a decision; resolved = decided in this run; suppressed = a stored resolution already covers it at these same values.';

-- ========================================================================
-- 4. Working days and instructional hours
-- ========================================================================

/* The statutory minimum, by stage.

   The RTE Act schedule sets 200 instructional days and 800 hours for classes
   I-V, and 220 days and 1000 hours for VI-VIII; states add their own for the
   secondary stage. It is a table rather than a constant because the numbers
   differ by state and are amended, and because a school under a stricter board
   norm needs to measure against the one it will be inspected on.

   Stage bands are expressed as a range over classes.level, since nothing in
   this schema maps a class to a stage -- institutions.school_category
   describes the school, not the class. */
CREATE TABLE instructional_norms (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    stage_code     text NOT NULL,
    label          text NOT NULL,
    min_level      integer NOT NULL,
    max_level      integer NOT NULL,
    min_days       integer NOT NULL,
    -- Hours to one decimal: some state norms are expressed in half hours.
    min_hours      numeric(6,1) NOT NULL,
    authority      text,
    note           text,
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT instructional_norms_levels
        CHECK (min_level >= 1 AND max_level >= min_level AND max_level <= 12),
    CONSTRAINT instructional_norms_minima
        CHECK (min_days BETWEEN 0 AND 366 AND min_hours >= 0),
    CONSTRAINT instructional_norms_stage_present CHECK (btrim(stage_code) <> '')
);

CREATE UNIQUE INDEX instructional_norms_one_per_stage
    ON instructional_norms (institution_id, lower(stage_code));

COMMENT ON TABLE instructional_norms IS
    'Minimum instructional days and hours per stage, matched to classes.level. Seeded from the RTE Act schedule for every existing school and auto-seeded for new ones on first read; editable because states amend them.';

/* Reality: half days, bandhs, an inspection that took a morning.

   The calendar in holidays says what was planned. A working-days return that
   cannot be corrected against what happened is one a school will keep in a
   spreadsheet instead, so an adjustment is a signed row with a reason -- never
   a silent edit of the computed figure. */
CREATE TABLE working_days_adjustments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    -- NULL means the adjustment applies to every class, which is the usual
    -- case: the school shut, not one section.
    class_id         uuid REFERENCES classes(id) ON DELETE CASCADE,

    on_date          date NOT NULL,
    -- Signed. -0.5 is the half day that got counted as whole; +1 is the
    -- Saturday worked to make it back.
    days_delta       numeric(4,2) NOT NULL DEFAULT 0,
    minutes_delta    integer NOT NULL DEFAULT 0,
    reason           text NOT NULL,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT working_days_adjustments_reason_present CHECK (btrim(reason) <> ''),
    CONSTRAINT working_days_adjustments_delta_sane
        CHECK (days_delta BETWEEN -31 AND 31 AND minutes_delta BETWEEN -100000 AND 100000),
    -- An adjustment of nothing is a note, and belongs in the reason of a real
    -- one rather than as a row that silently changes no figure.
    CONSTRAINT working_days_adjustments_not_empty
        CHECK (days_delta <> 0 OR minutes_delta <> 0)
);

/* One adjustment per class per day per reason. class_id is nullable, so the
   COALESCE guard is what stops the same closure being entered twice for the
   whole school and double-counted. */
CREATE UNIQUE INDEX working_days_adjustments_one_per_day
    ON working_days_adjustments (institution_id, academic_year_id,
                                 COALESCE(class_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                 on_date, lower(reason));
CREATE INDEX working_days_adjustments_by_year
    ON working_days_adjustments (institution_id, academic_year_id, on_date);

/* The return as filed.

   Same rule as the LOC: a draft recomputes from the calendar and the
   timetable, a filed return does not. The whole point of the feature is to
   show a shortfall while there is still term left to fix it, and the figure
   that gets sent has to stay what was sent. */
CREATE TABLE working_days_returns (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,

    title            text NOT NULL,
    period_from      date NOT NULL,
    period_to        date NOT NULL,
    status           text NOT NULL DEFAULT 'draft',
    working_days     numeric(6,2) NOT NULL DEFAULT 0,
    classes_short    integer NOT NULL DEFAULT 0,
    filed_at         timestamptz,
    filed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    notes            text,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT working_days_returns_status CHECK (status IN ('draft','filed')),
    CONSTRAINT working_days_returns_period CHECK (period_to >= period_from),
    CONSTRAINT working_days_returns_title_present CHECK (btrim(title) <> ''),
    CONSTRAINT working_days_returns_filed_is_stamped
        CHECK (status <> 'filed' OR filed_at IS NOT NULL)
);

CREATE UNIQUE INDEX working_days_returns_one_per_title
    ON working_days_returns (institution_id, academic_year_id, lower(title));
CREATE INDEX working_days_returns_recent
    ON working_days_returns (institution_id, academic_year_id, created_at DESC);

CREATE TABLE working_days_return_lines (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id       uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    return_id            uuid NOT NULL REFERENCES working_days_returns(id) ON DELETE CASCADE,

    class_id             uuid REFERENCES classes(id) ON DELETE SET NULL,
    class_label          text,
    class_level          integer,
    stage_code           text,
    working_days         numeric(6,2) NOT NULL DEFAULT 0,
    instructional_minutes integer NOT NULL DEFAULT 0,
    required_days        integer NOT NULL DEFAULT 0,
    required_minutes     integer NOT NULL DEFAULT 0,
    -- Stored rather than computed on read: the shortfall as filed is a fact
    -- about the filing, and recomputing it later against an amended norm would
    -- silently restate what the school told the state.
    shortfall_days       numeric(6,2) NOT NULL DEFAULT 0,
    shortfall_minutes    integer NOT NULL DEFAULT 0
);

-- class_id is ON DELETE SET NULL, so the guard is doing real work here.
CREATE UNIQUE INDEX working_days_return_lines_one_per_class
    ON working_days_return_lines (return_id,
                                  COALESCE(class_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX working_days_return_lines_by_return
    ON working_days_return_lines (institution_id, return_id, class_level);

-- ========================================================================
-- 5. Child Info portal sync (platform tier)
-- ========================================================================

/* The connector for one state's Child Info portal.

   Platform scope: a state portal is one endpoint for the whole installation,
   not a per-school setting, and the credential behind it is the vendor's
   arrangement with the state rather than the school's.

   This is why it is not a row in `integrations`, which would otherwise be the
   right home. integrations.institution_id is NOT NULL and its tenant_isolation
   policy reads `institution_id = app_current_institution() OR
   app_is_platform_admin()` -- an institution admin can select their own row
   and, with it, the credentials bytea. Encrypted at rest is not the same as
   not handed out, and a state portal credential is not a school's to hold.

   So: RLS on, forced, and a policy with no tenant limb at all. Even a platform
   admin acting inside a school (X-Acting-Institution) reads this only because
   app_is_platform_admin() is still on for them. Every other caller sees zero
   rows regardless of what the handler forgot to check, which is the point of
   putting the boundary here rather than only in Go.

   The credential itself is sealed with AES-GCM under CREDENTIAL_KEY by
   sealSecret/openSecret in internal/api/messaging.go -- the same pair the SMTP
   password uses. Nothing here ever returns it. */
CREATE TABLE child_info_portal_connectors (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    state_code     text NOT NULL,
    name           text NOT NULL,
    -- file_exchange is the only implementation that exists. 'api' is accepted
    -- so a connector can be recorded ahead of credentials arriving, and the
    -- screen says plainly that it cannot run.
    provider       text NOT NULL DEFAULT 'file_exchange',
    endpoint_url   text,
    username       text,
    credentials    bytea,
    config         jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Free text, e.g. 'monthly' or 'before the 10th'. Not a cron expression:
    -- there is no scheduler behind this and pretending otherwise would be the
    -- claim of a live integration that does not exist.
    schedule       text,
    is_enabled     boolean NOT NULL DEFAULT false,

    last_sync_at   timestamptz,
    last_status    text,
    last_error     text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT child_info_portal_connectors_provider
        CHECK (provider IN ('file_exchange','api')),
    CONSTRAINT child_info_portal_connectors_state_present CHECK (btrim(state_code) <> ''),
    CONSTRAINT child_info_portal_connectors_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT child_info_portal_connectors_last_status
        CHECK (last_status IS NULL OR last_status IN ('ok','failed'))
);

CREATE UNIQUE INDEX child_info_portal_connectors_one_per_state
    ON child_info_portal_connectors (lower(state_code), lower(name));

COMMENT ON TABLE child_info_portal_connectors IS
    'Platform configuration for a state Child Info portal. Readable only by a platform admin — the RLS policy has no tenant limb, deliberately. Credentials are AES-GCM sealed under CREDENTIAL_KEY and are never returned by the API.';
COMMENT ON COLUMN child_info_portal_connectors.provider IS
    'file_exchange is implemented: export a file, import the portal extract. api is a placeholder — no state portal exposes one to this installation, and no code pretends it does.';

/* What the connector actually did, and when.

   institution_id is a plain uuid with no foreign key and no tenant policy: a
   run is platform activity that happens to name a school, and an FK would make
   deleting a tenant silently delete the record of what was filed for it. */
CREATE TABLE child_info_sync_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id   uuid NOT NULL REFERENCES child_info_portal_connectors(id) ON DELETE CASCADE,

    institution_id uuid,
    institution_name text,
    direction      text NOT NULL,
    status         text NOT NULL DEFAULT 'ok',
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    row_count      integer NOT NULL DEFAULT 0,
    message        text,
    started_by     uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT child_info_sync_runs_direction
        CHECK (direction IN ('export','import')),
    CONSTRAINT child_info_sync_runs_status
        CHECK (status IN ('ok','failed'))
);

CREATE INDEX child_info_sync_runs_recent
    ON child_info_sync_runs (connector_id, started_at DESC);

-- ------------------------------------------------------- row level security

/* The tenant-scoped tables, in one loop. Policy named tenant_isolation to
   match the baseline and 00043, so a reader grepping for it finds all of them.

   child_info_portal_connectors and child_info_sync_runs are absent on purpose
   and get their own platform-only policies below. */
-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'loc_subject_groups','loc_subject_options','loc_submissions',
        'loc_candidates','loc_validation_issues',
        'sqaa_assessments','sqaa_assessment_entries','sqaa_evidence',
        'sqaa_action_items',
        'child_info_imports','child_info_rows','child_info_differences',
        'child_info_resolutions',
        'instructional_norms','working_days_adjustments',
        'working_days_returns','working_days_return_lines'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (app_is_platform_admin() '
            'OR institution_id = app_current_institution()) WITH CHECK '
            '(app_is_platform_admin() OR institution_id = app_current_institution())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    END LOOP;
END $$;
-- +goose StatementEnd

/* Platform only. No institution limb: there is no institution for which these
   rows are "theirs", and the credential column means a mistake here is a
   credential disclosure rather than a data leak. */
ALTER TABLE child_info_portal_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE child_info_portal_connectors FORCE  ROW LEVEL SECURITY;
CREATE POLICY platform_only ON child_info_portal_connectors
    USING (app_is_platform_admin())
    WITH CHECK (app_is_platform_admin());

ALTER TABLE child_info_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE child_info_sync_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY platform_only ON child_info_sync_runs
    USING (app_is_platform_admin())
    WITH CHECK (app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON child_info_portal_connectors TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON child_info_sync_runs         TO app_user;

-- ------------------------------------------------------------------ seed

/* The RTE Act schedule, for every school that already exists.

   Schools created after this migration are seeded on first read by
   ensureInstructionalNorms in internal/api/statutory.go -- a migration cannot
   seed a row for a tenant that does not exist yet, and a screen that shows
   nothing until somebody runs a backfill is a screen that looks broken.

   Secondary and higher secondary are not in the RTE schedule, which stops at
   class VIII. The figures below are the common state norm; they are marked as
   such in `authority` so nobody cites them as statute. */
INSERT INTO instructional_norms
    (institution_id, stage_code, label, min_level, max_level, min_days, min_hours, authority, note)
SELECT i.id, v.stage_code, v.label, v.min_level, v.max_level, v.min_days, v.min_hours,
       v.authority, v.note
  FROM institutions i
 CROSS JOIN (VALUES
    ('primary',          'Primary (I-V)',            1,  5, 200, 800.0,
     'RTE Act 2009, Schedule',
     'Statutory minimum for classes I-V.'),
    ('upper_primary',    'Upper primary (VI-VIII)',  6,  8, 220, 1000.0,
     'RTE Act 2009, Schedule',
     'Statutory minimum for classes VI-VIII.'),
    ('secondary',        'Secondary (IX-X)',         9, 10, 220, 1100.0,
     'State norm',
     'Not set by the RTE Act, which stops at class VIII. Check the figure your board inspects against.'),
    ('higher_secondary', 'Higher secondary (XI-XII)', 11, 12, 220, 1100.0,
     'State norm',
     'Not set by the RTE Act. Check the figure your board inspects against.')
 ) AS v(stage_code, label, min_level, max_level, min_days, min_hours, authority, note)
ON CONFLICT DO NOTHING;

-- +goose Down
DROP TABLE IF EXISTS child_info_sync_runs;
DROP TABLE IF EXISTS child_info_portal_connectors;

DROP TABLE IF EXISTS working_days_return_lines;
DROP TABLE IF EXISTS working_days_returns;
DROP TABLE IF EXISTS working_days_adjustments;
DROP TABLE IF EXISTS instructional_norms;

-- differences references resolutions, so it goes first.
DROP TABLE IF EXISTS child_info_differences;
DROP TABLE IF EXISTS child_info_resolutions;
DROP TABLE IF EXISTS child_info_rows;
DROP TABLE IF EXISTS child_info_imports;

DROP TABLE IF EXISTS sqaa_action_items;
DROP TABLE IF EXISTS sqaa_evidence;
DROP TABLE IF EXISTS sqaa_assessment_entries;
DROP TABLE IF EXISTS sqaa_assessments;

DROP TABLE IF EXISTS loc_validation_issues;
DROP TABLE IF EXISTS loc_candidates;
DROP TABLE IF EXISTS loc_submissions;
DROP TABLE IF EXISTS loc_subject_options;
DROP TABLE IF EXISTS loc_subject_groups;

ALTER TABLE board_registrations
    DROP COLUMN IF EXISTS signature_file_id,
    DROP COLUMN IF EXISTS photo_file_id;
