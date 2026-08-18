-- +goose Up
-- What a teacher does between the timetable and the report card.
--
-- Four of the eight screens this migration serves need no table at all, and
-- deliberately get none:
--
--   Assignments & submissions   homework + homework_submissions already carry
--                               the task, the hand-in, the mark and the
--                               feedback. A second assignment table would split
--                               one child's work across two schemas, and the
--                               parent portal already reads the first one.
--   Study materials / LMS       study_materials already carries title, kind,
--                               file_id, external_url and is_published.
--   CCE summative               a dated paper with a mark out of eighty is
--                               exactly exams(kind='summative') -> exam_subjects
--                               -> marks, which already computes a grade from
--                               the grading scale and already feeds the report
--                               card. See the note on cce_formative_entries.
--
-- What is genuinely absent is a question bank, the objective test assembled
-- from it, the meeting a class is invited to, and the continuous half of CCE.

/* The question bank.

   Tagged three ways because the three questions a teacher actually asks of a
   bank are "what covers chapter 4", "have I got enough hard ones", and "is this
   paper all recall". Chapter is the syllabus unit rather than free text, so the
   tag survives a syllabus being renamed and can be counted against coverage.

   class_subject_id is NOT NULL: a question belongs to a subject in a class, and
   a bank that is not scoped that way is a bank nobody can search. syllabus_unit_id
   is nullable because a general-ability question genuinely belongs to no chapter,
   and forcing one would file it under whichever chapter the author had open. */
CREATE TABLE question_bank_questions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    class_subject_id  uuid        NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    syllabus_unit_id  uuid        REFERENCES syllabus_units(id) ON DELETE SET NULL,
    -- Objective kinds are auto-gradable and may sit on an online test; the
    -- subjective two are bank-only and the test builder refuses them.
    kind              text        NOT NULL DEFAULT 'mcq'
                                  CHECK (kind IN ('mcq','true_false','fill_blank','short','long')),
    difficulty        text        NOT NULL DEFAULT 'medium'
                                  CHECK (difficulty IN ('easy','medium','hard')),
    -- Bloom's, in the six-level revised form Indian scheme-of-work templates
    -- use. Stored because a question paper is audited for the spread.
    bloom_level       text        NOT NULL DEFAULT 'understand'
                                  CHECK (bloom_level IN ('remember','understand','apply',
                                                         'analyse','evaluate','create')),
    stem              text        NOT NULL,
    -- What the paper is worth by default. A test may override it per question,
    -- which is why the test link carries its own marks column.
    default_marks     numeric(5,2) NOT NULL DEFAULT 1 CHECK (default_marks > 0),
    -- Shown to the child after the test closes. The reason a wrong answer was
    -- wrong is the only part of an objective test that teaches anything.
    explanation       text,
    is_active         boolean     NOT NULL DEFAULT true,
    created_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT question_bank_questions_stem CHECK (nullif(btrim(stem), '') IS NOT NULL)
);

CREATE INDEX question_bank_questions_subject
    ON question_bank_questions (institution_id, class_subject_id, is_active);
CREATE INDEX question_bank_questions_unit
    ON question_bank_questions (syllabus_unit_id) WHERE syllabus_unit_id IS NOT NULL;

/* The options, and which of them is right.

   One table for every objective kind rather than three: a true/false is two
   options, a fill-in-the-blank is its accepted answers, and an MCQ is four.
   Modelling them apart produced three code paths that graded the same way.

   No constraint here forces exactly one correct option — a multi-answer MCQ is
   real, and a fill-in-the-blank has several acceptable spellings. The API
   enforces "at least one correct" on write, where it can say why. */
CREATE TABLE question_bank_options (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid    NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    question_id    uuid    NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
    sequence       integer NOT NULL CHECK (sequence > 0),
    body           text    NOT NULL,
    is_correct     boolean NOT NULL DEFAULT false,
    CONSTRAINT question_bank_options_body CHECK (nullif(btrim(body), '') IS NOT NULL)
);

-- Option order is the order the child reads them in, so it must be stable and
-- unique; two options at position 2 render in whichever order the planner felt
-- like that day.
CREATE UNIQUE INDEX question_bank_options_order
    ON question_bank_options (question_id, sequence);

/* An objective test set for one section.

   section_id, not class_id: 6-A sits the test on Tuesday and 6-B on Thursday,
   and a test that belongs to a class cannot express that.

   The window and the duration are both kept because they answer different
   questions — opens_at/closes_at is when the test may be attempted at all, and
   duration_minutes is how long a child gets once they start. A school that sets
   only the window gets an untimed test, which is a legitimate choice. */
CREATE TABLE online_tests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    section_id        uuid        NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    class_subject_id  uuid        NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    title             text        NOT NULL,
    instructions      text,
    opens_at          timestamptz,
    closes_at         timestamptz,
    duration_minutes  integer     CHECK (duration_minutes IS NULL OR duration_minutes > 0),
    -- One sitting unless the teacher says otherwise; a practice test is the
    -- case for more.
    max_attempts      integer     NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
    shuffle_questions boolean     NOT NULL DEFAULT false,
    -- Draft is invisible to the child. Published is the only state a student
    -- portal may read, and closed stops further attempts without deleting the
    -- paper.
    status            text        NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft','published','closed')),
    published_at      timestamptz,
    created_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT online_tests_title CHECK (nullif(btrim(title), '') IS NOT NULL),
    -- A window that shuts before it opens is a test nobody can sit, and the
    -- error is invisible until the morning it matters.
    CONSTRAINT online_tests_window CHECK (opens_at IS NULL OR closes_at IS NULL
                                          OR closes_at > opens_at)
);

CREATE INDEX online_tests_section
    ON online_tests (institution_id, section_id, status, opens_at DESC);

/* Which questions are on the paper, in what order, for how many marks.

   marks is per-paper rather than read from the bank: the same question is worth
   one mark in a slip test and four in a unit test, and copying the bank's
   default at insert time is what lets a teacher change it without editing the
   bank for everyone. */
CREATE TABLE online_test_questions (
    id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid    NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    test_id        uuid    NOT NULL REFERENCES online_tests(id) ON DELETE CASCADE,
    question_id    uuid    NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
    sequence       integer NOT NULL CHECK (sequence > 0),
    marks          numeric(5,2) NOT NULL DEFAULT 1 CHECK (marks > 0)
);

-- The same question twice on one paper is always a mistake, and it doubles the
-- total silently.
CREATE UNIQUE INDEX online_test_questions_once
    ON online_test_questions (test_id, question_id);
CREATE UNIQUE INDEX online_test_questions_order
    ON online_test_questions (test_id, sequence);

/* The meeting provider a school has connected.

   No credentials live here. A client id and secret belong in the platform
   integration store, which is another agent's table and another agent's
   encryption; this row records only that a school intends to use Zoom, under
   which account, so the launcher can say which provider a session will run on.

   account_ref is the provider's own identifier for the host account — a Zoom
   user id or a Workspace address — and is the one field a support engineer
   needs when a meeting fails to create. */
CREATE TABLE virtual_class_providers (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    provider       text        NOT NULL CHECK (provider IN ('zoom','google_meet','ms_teams')),
    display_name   text        NOT NULL,
    account_ref    text,
    is_active      boolean     NOT NULL DEFAULT true,
    configured_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT virtual_class_providers_name CHECK (nullif(btrim(display_name), '') IS NOT NULL)
);

-- One configuration per provider per school. Two Zoom rows means the launcher
-- picks one at random and half the meetings are created on the wrong account.
CREATE UNIQUE INDEX virtual_class_providers_one
    ON virtual_class_providers (institution_id, provider);

/* A scheduled live class.

   join_url is nullable and stays null until a provider integration fills it.
   That is the whole point of the column: a launcher that invents a plausible
   URL sends thirty children to a meeting that does not exist, and the failure
   surfaces at 9am on the day rather than when the row was written. status
   'provider_pending' is the honest state for a session whose meeting has not
   been created yet, and the API refuses to pretend otherwise.

   class_subject_id is nullable because a form-tutor session, a parents' evening
   or an assembly is a live class with no subject. */
CREATE TABLE virtual_class_sessions (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    section_id        uuid        NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    class_subject_id  uuid        REFERENCES class_subjects(id) ON DELETE SET NULL,
    provider_id       uuid        REFERENCES virtual_class_providers(id) ON DELETE SET NULL,
    topic             text        NOT NULL,
    agenda            text,
    scheduled_at      timestamptz NOT NULL,
    duration_minutes  integer     NOT NULL DEFAULT 40 CHECK (duration_minutes > 0),
    join_url          text,
    -- The provider's meeting identifier, once one exists. Kept apart from
    -- join_url so a session can be reconciled even if the URL is rotated.
    meeting_ref       text,
    status            text        NOT NULL DEFAULT 'provider_pending'
                                  CHECK (status IN ('provider_pending','scheduled','live',
                                                    'ended','cancelled')),
    started_at        timestamptz,
    ended_at          timestamptz,
    created_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT virtual_class_sessions_topic CHECK (nullif(btrim(topic), '') IS NOT NULL),
    -- A session may only claim to be joinable once it has somewhere to join.
    CONSTRAINT virtual_class_sessions_joinable
        CHECK (status NOT IN ('scheduled','live') OR join_url IS NOT NULL)
);

CREATE INDEX virtual_class_sessions_section
    ON virtual_class_sessions (institution_id, section_id, scheduled_at DESC);

/* The continuous half of CCE.

   Formative assessment is not a lighter summative. A summative is one paper,
   sat on a date, marked out of eighty — exams -> exam_subjects -> marks holds
   that exactly, and this migration adds nothing for it. A formative is four
   activities gathered over a term and a sentence about how the child is
   getting on, and the marks table can hold neither: it has one numeric column
   where four are needed, and one free-text `remarks` that would have to carry a
   descriptive judgement it was never meant for.

   So the two are related by shared keys rather than by a shared table. Both
   hang off (student_id, class_subject_id, term_id), which is the grain the
   report card aggregates on: a term's grade is the weighted sum of the FA rows
   here and the SA rows in marks. Nothing is duplicated between them.

   The four component columns are the state-board scheme the catalogue names —
   written work, project, slip test, participation — five marks each, twenty in
   total. They are nullable and not defaulted to zero, because a project not yet
   set and a project scored nought are different facts and a report card that
   shows the first as the second has libelled the child.

   `observation` is the descriptive record and is deliberately text. It is the
   part of CCE that a numeric column would destroy. `indicator` is the coarse
   descriptive band a teacher picks alongside it; it is not derived from the
   marks, because "scoring well but disengaged" is exactly the observation a
   formative scheme exists to capture. */
CREATE TABLE cce_formative_entries (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id        uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    class_subject_id  uuid        NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    term_id           uuid        REFERENCES terms(id) ON DELETE SET NULL,
    cycle             text        NOT NULL CHECK (cycle IN ('FA1','FA2','FA3','FA4')),
    written_work      numeric(5,2) CHECK (written_work  IS NULL OR written_work  >= 0),
    project_work      numeric(5,2) CHECK (project_work  IS NULL OR project_work  >= 0),
    slip_test         numeric(5,2) CHECK (slip_test     IS NULL OR slip_test     >= 0),
    participation     numeric(5,2) CHECK (participation IS NULL OR participation >= 0),
    -- The scheme's ceiling for each of the four, so a school running a 10+10
    -- variant is not forced into the 5+5+5+5 the default assumes. The total is
    -- computed on read; storing it guarantees one screen disagrees with another.
    component_max     numeric(5,2) NOT NULL DEFAULT 5 CHECK (component_max > 0),
    observation       text,
    indicator         text        CHECK (indicator IS NULL OR indicator IN
                                         ('excellent','good','satisfactory','needs_support')),
    recorded_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    recorded_at       timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

/* One row per child, per subject, per cycle, per term.

   term_id is COALESCEd to the nil uuid because a nullable column inside a
   unique index silently switches the index off: with a bare four-column index,
   every FA1 row written before terms were configured would be allowed through
   again and again, and the entry screen would quietly accumulate duplicates
   that the report card would then sum. */
CREATE UNIQUE INDEX cce_formative_entries_once
    ON cce_formative_entries (student_id, class_subject_id, cycle,
                              COALESCE(term_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX cce_formative_entries_subject
    ON cce_formative_entries (institution_id, class_subject_id, cycle);

ALTER TABLE question_bank_questions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_bank_questions   FORCE  ROW LEVEL SECURITY;
ALTER TABLE question_bank_options     ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_bank_options     FORCE  ROW LEVEL SECURITY;
ALTER TABLE online_tests              ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_tests              FORCE  ROW LEVEL SECURITY;
ALTER TABLE online_test_questions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_test_questions     FORCE  ROW LEVEL SECURITY;
ALTER TABLE virtual_class_providers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_class_providers   FORCE  ROW LEVEL SECURITY;
ALTER TABLE virtual_class_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_class_sessions    FORCE  ROW LEVEL SECURITY;
ALTER TABLE cce_formative_entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cce_formative_entries     FORCE  ROW LEVEL SECURITY;

CREATE POLICY question_bank_questions_tenant ON question_bank_questions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY question_bank_options_tenant ON question_bank_options
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY online_tests_tenant ON online_tests
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY online_test_questions_tenant ON online_test_questions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY virtual_class_providers_tenant ON virtual_class_providers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY virtual_class_sessions_tenant ON virtual_class_sessions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY cce_formative_entries_tenant ON cce_formative_entries
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS cce_formative_entries;
DROP TABLE IF EXISTS virtual_class_sessions;
DROP TABLE IF EXISTS virtual_class_providers;
DROP TABLE IF EXISTS online_test_questions;
DROP TABLE IF EXISTS online_tests;
DROP TABLE IF EXISTS question_bank_options;
DROP TABLE IF EXISTS question_bank_questions;
