-- +goose Up
-- What a teacher writes about a child, and who is allowed to read it.
--
-- The teaching workspace could record marks, attendance and homework — every
-- number a school keeps — and nothing a teacher would say in a sentence. The
-- qualitative side of the year was therefore kept in a diary: the term-end
-- remark was typed straight onto the printed card, the note about a child who
-- has started speaking up in class was remembered or lost, and what a parent
-- was promised at the October meeting existed only in whoever's handwriting.
--
-- Four things are stored here, and the reason they are not one table is that
-- they differ on the only question that matters — who may read them.
--
--   student_remarks         an observation, ordinarily shared with the family;
--                           an anecdotal record is the same shape, kept private
--   ptm_notes               what was raised at a meeting and what was agreed,
--                           which the parent was present for and part-owns
--   announcement_students   a notice aimed at one child rather than a section
--   report_cards.*_by/_at   attribution for the remark printed on the card
--
-- The term-end remark itself gets no table: report_cards already carries
-- class_teacher_remarks and principal_remarks, the family portal already reads
-- the first of them, and a second copy would be the version that disagrees.

/* An observation about one child.

   kind and visible_to_family are separate columns rather than two tables
   because discipline_records already settled this question the same way: one
   record, one visibility flag, one query path. A screen that has to union two
   tables to show a child's year is a screen that will eventually forget one.

   The flag is not, however, left to the author's judgement for an anecdotal
   record. "Private qualitative observation" is what the record *is* — a
   teacher noting that a child has been withdrawn since their grandmother died
   is writing for the staff who will teach them next term, not for the family —
   so the constraint below makes the wrong combination unrepresentable rather
   than merely discouraged. */
CREATE TABLE student_remarks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id        uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- Which class the child was sitting in when this was observed. Kept even
    -- though it is derivable from the enrolment: a child moves section, and a
    -- remark written in 6-B should still read as having been written in 6-B.
    section_id        uuid        REFERENCES sections(id) ON DELETE SET NULL,
    -- The lesson it came out of, where there was one. A remark from the
    -- Physics teacher and one from the class teacher are read differently.
    class_subject_id  uuid        REFERENCES class_subjects(id) ON DELETE SET NULL,
    term_id           uuid        REFERENCES terms(id) ON DELETE SET NULL,
    kind              text        NOT NULL DEFAULT 'academic',
    body              text        NOT NULL,
    -- Follows discipline_records.visible_to_student: the record exists either
    -- way, and the flag decides whether the portal shows it.
    visible_to_family boolean     NOT NULL DEFAULT true,
    observed_on       date        NOT NULL DEFAULT CURRENT_DATE,
    recorded_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_remarks_kind_check CHECK (kind IN (
        'academic', 'behaviour', 'participation', 'achievement', 'concern',
        'anecdotal')),
    -- An empty remark is a row that costs a reader time and tells them nothing.
    CONSTRAINT student_remarks_body_present
        CHECK (nullif(btrim(body), '') IS NOT NULL),
    CONSTRAINT student_remarks_anecdotal_is_private
        CHECK (kind <> 'anecdotal' OR visible_to_family = false)
);

CREATE INDEX student_remarks_student ON student_remarks (student_id, observed_on DESC);
CREATE INDEX student_remarks_section ON student_remarks (section_id, observed_on DESC);
CREATE INDEX student_remarks_institution ON student_remarks (institution_id);

/* One parent-teacher meeting, about one child.

   Attendance is a word rather than a boolean because "the mother came alone"
   and "nobody came" are both worth recording and are not the same absence —
   the second is the one that goes in the file when a school later has to show
   it tried. A meeting nobody attended still gets a row for exactly that
   reason.

   concerns and agreed_actions are kept apart on purpose. What the parent
   raised is theirs and should survive being summarised; what the school
   undertook to do is the half that can be chased in September. */
CREATE TABLE ptm_notes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id        uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    section_id        uuid        REFERENCES sections(id) ON DELETE SET NULL,
    term_id           uuid        REFERENCES terms(id) ON DELETE SET NULL,
    met_on            date        NOT NULL DEFAULT CURRENT_DATE,
    attendance        text        NOT NULL DEFAULT 'guardian',
    -- The name given at the desk. Guardian records are often out of date, and
    -- "the uncle who collects him" is who actually sat down.
    attended_by       text,
    mode              text        NOT NULL DEFAULT 'in_person',
    concerns          text,
    agreed_actions    text,
    follow_up_on      date,
    follow_up_done    boolean     NOT NULL DEFAULT false,
    -- The parent was in the room. Withholding the note of what was agreed is
    -- possible, but it is a decision rather than the default.
    visible_to_family boolean     NOT NULL DEFAULT true,
    recorded_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ptm_notes_attendance_check CHECK (attendance IN (
        'both', 'mother', 'father', 'guardian', 'none')),
    CONSTRAINT ptm_notes_mode_check CHECK (mode IN ('in_person', 'phone', 'video')),
    -- A meeting that produced neither a concern nor an action, and that
    -- somebody attended, is a row nobody will ever read.
    CONSTRAINT ptm_notes_has_content CHECK (
        attendance = 'none'
        OR nullif(btrim(coalesce(concerns, '') || coalesce(agreed_actions, '')), '') IS NOT NULL)
);

/* One note per teacher per child per meeting day.

   Without this, a teacher who corrects a typo and saves again ends the
   afternoon with two versions of the same meeting and no way to tell which the
   parent saw. The endpoint upserts onto this index instead.

   recorded_by is nullable — the author's account may be deleted while the
   record must survive — and a nullable column inside a UNIQUE index silently
   disables it, because Postgres treats every NULL as distinct. COALESCE to a
   fixed sentinel so "no author" is one value rather than unlimited ones. The
   same trap is documented in 00004, 00006 and 00014. */
CREATE UNIQUE INDEX ptm_notes_one_per_meeting ON ptm_notes (
    student_id, met_on,
    COALESCE(recorded_by, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE INDEX ptm_notes_section ON ptm_notes (section_id, met_on DESC);
CREATE INDEX ptm_notes_follow_up ON ptm_notes (institution_id, follow_up_on)
    WHERE follow_up_done = false AND follow_up_on IS NOT NULL;

/* A notice addressed to one child's family.

   announcements could already be aimed at the school or at a list of sections,
   which covers "no school on Friday" and "6-B bring PE kit" but not "Aarav has
   not returned the consent form" — the message a class teacher actually needs
   to send, and the one that was being sent by telephone instead.

   A separate table rather than a nullable student_id on announcements: a
   notice may name several children (the four who are on the trip), and the
   join table is the same shape announcement_sections already is. */
CREATE TABLE announcement_students (
    announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    student_id      uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    PRIMARY KEY (announcement_id, student_id)
);

CREATE INDEX announcement_students_student ON announcement_students (student_id);

/* Who wrote the remark on the card, and when.

   report_cards has carried class_teacher_remarks and principal_remarks since
   the baseline, with no record of authorship — which is fine while the card is
   typed by one person on one afternoon and useless the moment a parent asks
   why the remark changed between the draft and the print run. */
ALTER TABLE report_cards
    ADD COLUMN class_teacher_remarks_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN class_teacher_remarks_at timestamptz,
    ADD COLUMN principal_remarks_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN principal_remarks_at     timestamptz;

ALTER TABLE student_remarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_remarks FORCE ROW LEVEL SECURITY;
ALTER TABLE ptm_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ptm_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE announcement_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement_students FORCE ROW LEVEL SECURITY;

CREATE POLICY student_remarks_tenant ON student_remarks
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY ptm_notes_tenant ON ptm_notes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY announcement_students_tenant ON announcement_students
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
ALTER TABLE report_cards
    DROP COLUMN IF EXISTS class_teacher_remarks_by,
    DROP COLUMN IF EXISTS class_teacher_remarks_at,
    DROP COLUMN IF EXISTS principal_remarks_by,
    DROP COLUMN IF EXISTS principal_remarks_at;
DROP TABLE IF EXISTS announcement_students;
DROP TABLE IF EXISTS ptm_notes;
DROP TABLE IF EXISTS student_remarks;
