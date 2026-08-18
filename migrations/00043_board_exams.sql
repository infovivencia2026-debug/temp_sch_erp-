-- Renumbered from 00040: 00041 had already been applied by the time this
-- merged, and goose refuses a migration that appears behind the current
-- version. Content unchanged.
-- +goose Up
-- The board examination: the nominal roll, its corrections, and the result
-- file that comes back.
--
-- board_registrations already existed and is widened rather than replaced. A
-- second candidate table would mean two answers to "who did we enter for the
-- SSC", and the one the office believed would be whichever screen it opened.
--
-- Everything here turns on one distinction the original table did not carry: a
-- board registration is a statutory submission, not a record the school keeps
-- for itself. Before it goes it is a draft that anybody may correct. After it
-- goes, the school's copy and the board's copy are two documents that have to
-- be reconcilable, and an in-place edit destroys that — the school is left
-- unable to say what it sent, which is precisely what an amendment has to
-- state.

/* The candidate's particulars as they were sent.

   These duplicate students. That is deliberate and it is the point of the
   file: the roll is a statement of fact as at the date of submission, and the
   board prints its certificate from what it received. If the office later
   corrects a spelling in students — and it will, because that is what the
   correction window is for — a roll that read through to students would
   silently rewrite history, leaving an amendment with no "before" to quote and
   the school arguing with the board from memory.

   They are filled from the school's record when the draft is created, so this
   is a snapshot, not re-keying. */
ALTER TABLE board_registrations
    -- Which examination this is, in the board's own terms, so the two
    -- registration screens can filter without parsing exam_name. SSC is one
    -- sitting at the end of Class 10; the Intermediate is two, a year apart,
    -- and TSBIE treats them as separate examinations with separate fees.
    ADD COLUMN stage            text,
    -- regular / private / supplementary / betterment. A supplementary
    -- candidate pays a different fee and sits only the papers they failed, so
    -- a roll that does not carry this cannot be priced or checked.
    ADD COLUMN candidate_type   text NOT NULL DEFAULT 'regular',
    -- MPC, BiPC, CEC, MEC, HEC. Intermediate only; NULL for the SSC.
    ADD COLUMN group_code       text,
    ADD COLUMN second_language  text,
    ADD COLUMN class_id         uuid REFERENCES classes(id) ON DELETE SET NULL,
    ADD COLUMN candidate_name   text,
    ADD COLUMN father_name      text,
    ADD COLUMN mother_name      text,
    ADD COLUMN date_of_birth    date,
    ADD COLUMN apaar_id         text,
    -- Checked by a human against the child's certificate before submission.
    -- Separate from status so that "somebody has verified this row" survives
    -- the roll being submitted, rejected and resubmitted.
    ADD COLUMN verified_at      timestamptz,
    ADD COLUMN verified_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN submitted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN submitted_at     timestamptz,
    -- What the board gave back when it took the file.
    ADD COLUMN board_ack_no     text,
    ADD COLUMN remarks          text,
    ADD CONSTRAINT board_registrations_stage_check
        CHECK (stage IS NULL OR stage = ANY (ARRAY['ssc','inter_first_year','inter_second_year'])),
    ADD CONSTRAINT board_registrations_candidate_type_check
        CHECK (candidate_type = ANY (ARRAY['regular','private','supplementary','betterment'])),
    -- A submitted row without the stamp of who sent it and when is a row
    -- nobody can be asked about.
    ADD CONSTRAINT board_registrations_submitted_is_stamped
        CHECK (status IN ('draft','verified') OR submitted_at IS NOT NULL);

/* 'verified' sits between draft and submitted.

   The office checks a roll over days, a few children at a time, and needs to
   see what is left. Without it the only states are "not sent" and "sent", and
   the checking pass has nowhere to record itself. */
ALTER TABLE board_registrations
    DROP CONSTRAINT IF EXISTS board_registrations_status_check;
ALTER TABLE board_registrations
    ADD CONSTRAINT board_registrations_status_check CHECK (
        status = ANY (ARRAY['draft','verified','submitted','accepted',
                            'hall_ticket_issued','rejected']));

/* One registration number per board.

   registration_no is nullable — it is the board's number, and it does not
   exist until the board issues it — and a NULL inside a unique index disables
   the index for exactly the rows that would otherwise collide, so the
   constraint is written partial rather than plain. Two candidates sharing a
   number is a hall ticket clash on the morning of the paper. */
CREATE UNIQUE INDEX board_registrations_reg_no
    ON board_registrations (institution_id, board, registration_no)
    WHERE registration_no IS NOT NULL;

-- The roll as the two screens read it: this year's candidates for one stage.
CREATE INDEX board_registrations_roll
    ON board_registrations (institution_id, academic_year_id, stage, status);

/* Corrections after submission.

   Append-only on purpose. The board's correction window asks for the field,
   what it said, what it should say and why — and settles it days or weeks
   later, by which time the person who raised it has gone home. Overwriting the
   registration when the correction is raised would make the school's copy
   disagree with the board's for the whole of that interval, and there would be
   no record that a correction was ever asked for if the board refuses it.

   So the value moves only when the board accepts, and applied_at records the
   moment the two copies were brought back into line. */
CREATE TABLE board_registration_amendments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    registration_id uuid NOT NULL REFERENCES board_registrations(id) ON DELETE CASCADE,
    -- The column being corrected, named as the API names it.
    field           text NOT NULL,
    -- As submitted. NULL only where the field was genuinely blank, which is
    -- itself a correction the board treats differently from a misspelling.
    old_value       text,
    new_value       text,
    -- The board asks for one, and a blank reason six weeks later is a
    -- correction nobody can explain to an inspector.
    reason          text NOT NULL,
    status          text NOT NULL DEFAULT 'requested',
    -- The board's own reference for the correction, once it has one.
    board_ref       text,
    requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    requested_at    timestamptz NOT NULL DEFAULT now(),
    decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at      timestamptz,
    applied_at      timestamptz,
    CONSTRAINT board_registration_amendments_status_check
        CHECK (status = ANY (ARRAY['requested','sent','accepted','rejected'])),
    CONSTRAINT board_registration_amendments_decided_is_stamped
        CHECK (status IN ('requested','sent') OR decided_at IS NOT NULL)
);

CREATE INDEX board_registration_amendments_by_registration
    ON board_registration_amendments (institution_id, registration_id, requested_at DESC);
-- The correction window's own worklist: everything still unsettled.
CREATE INDEX board_registration_amendments_open
    ON board_registration_amendments (institution_id, status)
    WHERE status IN ('requested','sent');

/* A result file, as received.

   One row per upload rather than one set of results per year, because a board
   publishes twice — the main result and then the supplementary — and the
   school needs both, side by side, with the file each came from. */
CREATE TABLE board_result_imports (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id         uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    academic_year_id       uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    board                  text NOT NULL,
    exam_name              text NOT NULL,
    stage                  text,
    file_name              text,
    note                   text,
    row_count              integer NOT NULL DEFAULT 0,
    matched_count          integer NOT NULL DEFAULT 0,
    /* The operator has seen both unreconciled lists and accepted them.

       Publishing while a candidate of the school's is missing from the board's
       file means telling a family nothing on the day everybody else hears. The
       import will not publish until somebody has said, in writing, that they
       know about each one. */
    unmatched_acknowledged boolean NOT NULL DEFAULT false,
    imported_by            uuid REFERENCES users(id) ON DELETE SET NULL,
    imported_at            timestamptz NOT NULL DEFAULT now(),
    published_at           timestamptz,
    published_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT board_result_imports_stage_check
        CHECK (stage IS NULL OR stage = ANY (ARRAY['ssc','inter_first_year','inter_second_year']))
);

CREATE INDEX board_result_imports_recent
    ON board_result_imports (institution_id, academic_year_id, imported_at DESC);

/* Every line of the board's file, matched or not.

   A line that matches no candidate of ours is kept exactly as it arrived. The
   alternative — dropping it — is how a school discovers in August that four
   children were entered under a name it does not use, and by then the file has
   been deleted and the board's window has shut. An unmatched line is evidence
   rather than rubbish. */
CREATE TABLE board_result_rows (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    import_id       uuid NOT NULL REFERENCES board_result_imports(id) ON DELETE CASCADE,
    line_no         integer NOT NULL,
    hall_ticket_no  text,
    registration_no text,
    candidate_name  text,
    student_id      uuid REFERENCES students(id) ON DELETE SET NULL,
    registration_id uuid REFERENCES board_registrations(id) ON DELETE SET NULL,
    -- How the line was matched, so a name match can be looked at again. A
    -- match nobody can audit is a match nobody should trust.
    match_method    text NOT NULL DEFAULT 'unmatched',
    result          text,
    total_marks     numeric(8,2),
    max_marks       numeric(8,2),
    subjects        jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- The line verbatim. When a column turns out to have been misread, the
    -- file does not have to be found again.
    raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
    matched_at      timestamptz,
    matched_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (import_id, line_no),
    CONSTRAINT board_result_rows_match_method_check
        CHECK (match_method = ANY (ARRAY['hall_ticket','registration_no','name','manual','unmatched'])),
    CONSTRAINT board_result_rows_matched_has_student
        CHECK (match_method = 'unmatched' OR student_id IS NOT NULL)
);

/* Two lines of the file cannot both be one child.

   student_id is nullable and most of a bad import's rows are NULL, so this is
   partial: folding NULL to a sentinel would make every unmatched line collide
   with every other. The hazard it stops is real — a name match against a
   school with two Sai Kumars in Class 10 will otherwise attach both lines to
   whichever one sorts first, and one child's result is then the other's. */
CREATE UNIQUE INDEX board_result_rows_one_per_candidate
    ON board_result_rows (import_id, student_id)
    WHERE student_id IS NOT NULL;

-- The reconciliation report's own query: what this file could not place.
CREATE INDEX board_result_rows_unmatched
    ON board_result_rows (institution_id, import_id)
    WHERE student_id IS NULL;

-- --------------------------------------------------------------- tenancy
-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['board_registration_amendments','board_result_imports',
                             'board_result_rows'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (app_is_platform_admin() '
            'OR institution_id = app_current_institution()) WITH CHECK '
            '(app_is_platform_admin() OR institution_id = app_current_institution())', t);
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS board_result_rows;
DROP TABLE IF EXISTS board_result_imports;
DROP TABLE IF EXISTS board_registration_amendments;

DROP INDEX IF EXISTS board_registrations_roll;
DROP INDEX IF EXISTS board_registrations_reg_no;

ALTER TABLE board_registrations
    DROP CONSTRAINT IF EXISTS board_registrations_status_check;
ALTER TABLE board_registrations
    ADD CONSTRAINT board_registrations_status_check CHECK (
        status = ANY (ARRAY['draft','submitted','accepted','hall_ticket_issued','rejected']));

ALTER TABLE board_registrations
    DROP CONSTRAINT IF EXISTS board_registrations_submitted_is_stamped,
    DROP CONSTRAINT IF EXISTS board_registrations_candidate_type_check,
    DROP CONSTRAINT IF EXISTS board_registrations_stage_check,
    DROP COLUMN IF EXISTS remarks,
    DROP COLUMN IF EXISTS board_ack_no,
    DROP COLUMN IF EXISTS submitted_at,
    DROP COLUMN IF EXISTS submitted_by,
    DROP COLUMN IF EXISTS verified_by,
    DROP COLUMN IF EXISTS verified_at,
    DROP COLUMN IF EXISTS apaar_id,
    DROP COLUMN IF EXISTS date_of_birth,
    DROP COLUMN IF EXISTS mother_name,
    DROP COLUMN IF EXISTS father_name,
    DROP COLUMN IF EXISTS candidate_name,
    DROP COLUMN IF EXISTS class_id,
    DROP COLUMN IF EXISTS second_language,
    DROP COLUMN IF EXISTS group_code,
    DROP COLUMN IF EXISTS candidate_type,
    DROP COLUMN IF EXISTS stage;
