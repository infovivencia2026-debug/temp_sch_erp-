-- Numbered 00050 as instructed. THIS NUMBER MAY BE RENUMBERED AT INTEGRATION:
-- 00047-00049 are claimed by other workers in this same round and goose refuses
-- a version that appears behind the current one, so if this lands after a
-- higher number it must be renamed rather than reordered. Nothing in the file
-- depends on its own number.

-- +goose Up

/* Timetable operations: the generator's draft, the department's grid, and the
   request for cover.

   Almost none of the timetable is new. 00001 already carries the whole model —
   periods, timetable_entries with its two unique indexes (timetable_section_slot
   and timetable_teacher_slot, which are the two hard clashes stated in SQL),
   section_subject_teachers for who teaches what, and substitutions for one
   day's proxy with UNIQUE (timetable_entry_id, on_date) already on it. A
   morning substitution board reads all of that in internal/api/admin_academics.go.

   What was missing is only what these three features actually need:

     the requirement   nothing said how many periods a week a subject wants.
                       Without it a generator has nothing to satisfy and the
                       existing generator in mod_ops.go divides the free slots
                       by the subject count, which is a guess.
     the teacher's cap nothing said how much a teacher may teach. Load was
                       observable after the fact (count timetable_entries) and
                       never a constraint.
     the draft         a generated timetable must not overwrite a live one. The
                       existing POST /timetable-admin/generate inserts straight
                       into timetable_entries, which is the one thing a school
                       cannot undo on a Monday morning.
     the ask           substitutions records the decision. Nothing recorded the
                       request that led to it, which is the half a teacher
                       submits and a head of department approves.

   Two tables that were considered and deliberately not built:

     a second substitutions table.  Approving a request writes into the
     existing one, so today's register, "who is teaching now", and the payroll
     proxy-allowance count in payroll_statutory.go all see it without knowing
     this file exists.

     an absence table.  staff_attendance and leave_requests already hold why a
     teacher is out, and the substitution board already reads both. A request
     links to the leave row rather than asking the teacher to type the dates a
     second time.
*/

-- ============================================================ the requirement

/* How many periods a week this subject wants, and whether it belongs early.

   On class_subjects rather than a table of its own: the requirement is a
   property of "Maths in Class 8", which is exactly what a class_subjects row
   is. A separate timetable_requirements table keyed on the same pair would be
   the same row twice, and the two would disagree the first time a school added
   a subject.

   Zero means "not stated" and is the default, so the column changes nothing
   for a school that never opens the optimizer: the generator skips a
   requirement of zero rather than inventing one. */
ALTER TABLE class_subjects
    ADD COLUMN IF NOT EXISTS periods_per_week integer NOT NULL DEFAULT 0
        CHECK (periods_per_week >= 0 AND periods_per_week <= 60);

/* Put this one earlier in the day if the grid allows.

   Maths before lunch and Art after it is a judgement every school makes and no
   solver can infer. One boolean, because the graded "cognitive load index" the
   idea invites would be a number nobody can defend to a parent. */
ALTER TABLE class_subjects
    ADD COLUMN IF NOT EXISTS prefers_morning boolean NOT NULL DEFAULT false;

-- ========================================================== the teacher's cap

/* What one teacher may be asked to teach.

   Separate from employees because it is a timetabling rule, not an employment
   fact: it changes when the school reshuffles a year, and a school that never
   opens the optimizer never writes a row here at all. Absent rows mean "no cap
   the generator knows of", which the solver reads as the whole week — not
   zero, which would place nothing and blame every subject.

   The defaults are the CBSE-ish norms a secondary school runs: no more than 6
   periods a day and 35 a week for a full-time teacher. They are defaults on
   the column and not a constraint, because a school with a seven-period day
   legitimately runs higher. */
CREATE TABLE teacher_load_rules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id      uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    teacher_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    max_periods_per_day  integer NOT NULL DEFAULT 6,
    max_periods_per_week integer NOT NULL DEFAULT 35,

    -- Why this teacher is capped lower than the rest. A cap with no reason is
    -- the first thing challenged and the last thing anybody remembers.
    notes       text,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT teacher_load_rules_day_sane
        CHECK (max_periods_per_day BETWEEN 1 AND 20),
    CONSTRAINT teacher_load_rules_week_sane
        CHECK (max_periods_per_week BETWEEN 1 AND 80),
    -- A weekly cap below one day's is a typo, and it silently makes every
    -- subject this teacher owns unplaceable.
    CONSTRAINT teacher_load_rules_week_covers_a_day
        CHECK (max_periods_per_week >= max_periods_per_day)
);

-- One rule per teacher. No nullable column in the key, so nothing to COALESCE.
CREATE UNIQUE INDEX teacher_load_rules_one_per_teacher
    ON teacher_load_rules (institution_id, teacher_user_id);

COMMENT ON TABLE teacher_load_rules IS
    'One teacher''s timetabling caps: the most periods they may be given in a day and in a week. Absent means uncapped as far as the generator is concerned.';

/* A slot this teacher cannot take, every week.

   The recurring half of availability. A teacher who does the Wednesday
   assembly, or who is part-time on Friday afternoons, is unavailable in the
   same cells every week and the generator must not fill them. A one-off
   absence is not this — that is staff_attendance and leave_requests, and the
   substitution board already reads both.

   period_id NULL means the whole day. That is what makes the COALESCE below
   load-bearing rather than decorative: without it "Wednesday, all day" could
   be inserted twenty times and the unique index would enforce nothing, which
   is the trap this codebase has fallen into six times. */
CREATE TABLE teacher_unavailability (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    teacher_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- ISO-8601, matching timetable_entries.weekday: 1 = Monday.
    weekday   integer NOT NULL,
    period_id uuid REFERENCES periods(id) ON DELETE CASCADE,

    reason     text,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT teacher_unavailability_weekday
        CHECK (weekday BETWEEN 1 AND 7)
);

CREATE UNIQUE INDEX teacher_unavailability_one_per_slot
    ON teacher_unavailability (
        institution_id, teacher_user_id, weekday,
        COALESCE(period_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX teacher_unavailability_by_teacher
    ON teacher_unavailability (institution_id, teacher_user_id);

COMMENT ON TABLE teacher_unavailability IS
    'A weekly-recurring slot a teacher cannot be timetabled into. NULL period_id means the whole weekday. One-off absence lives in staff_attendance and leave_requests, not here.';

-- ================================================================= the draft

/* A generated candidate timetable, before anybody agrees to it.

   The entire reason this table exists. A generator that writes into
   timetable_entries has replaced the live grid of a school that is mid-term,
   and there is no undo: the previous arrangement was only ever in those rows.
   So the run produces a draft, a human reads the failure report, edits what
   they disagree with, and publishes — one explicit act, recorded with a name
   against it.

   seed is stored because "generate another option" has to mean something. The
   solver is a pure function of (input, seed); keeping the seed means a draft
   somebody liked can be reproduced, and two drafts can be compared knowing
   what differed. */
CREATE TABLE timetable_drafts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id         uuid REFERENCES campuses(id) ON DELETE CASCADE,
    academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,

    name   text NOT NULL,
    seed   bigint NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'draft',

    -- The honest summary, computed at generation and never recomputed. These
    -- describe the run that produced the draft; a later edit to the
    -- requirements does not retroactively change what this run managed.
    periods_required integer NOT NULL DEFAULT 0,
    periods_placed   integer NOT NULL DEFAULT 0,
    blocking_issues  integer NOT NULL DEFAULT 0,
    warning_issues   integer NOT NULL DEFAULT 0,

    generated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    generated_at timestamptz NOT NULL DEFAULT now(),
    published_by uuid REFERENCES users(id) ON DELETE SET NULL,
    published_at timestamptz,
    notes        text,

    CONSTRAINT timetable_drafts_status
        CHECK (status = ANY (ARRAY['draft', 'published', 'discarded'])),
    -- A published draft has a moment and a name against it, and a draft that
    -- is not published has neither. Both halves matter: the first is the audit
    -- trail, the second stops a discarded draft looking authorised.
    CONSTRAINT timetable_drafts_published_is_stamped
        CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE INDEX timetable_drafts_by_year
    ON timetable_drafts (institution_id, academic_year_id, generated_at DESC);

COMMENT ON TABLE timetable_drafts IS
    'One run of the timetable generator: a candidate grid a human reviews and publishes explicitly. Never the live timetable — that is timetable_entries.';

/* One period of a draft. Deliberately the same shape as timetable_entries, so
   publishing is a copy rather than a translation.

   The two unique indexes are the two hard constraints, stated where they
   cannot be forgotten. The solver already refuses to violate them; asserting
   them here means a hand-edit of a draft through the API cannot either, and a
   future second writer inherits the guarantee for free. */
CREATE TABLE timetable_draft_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    draft_id        uuid NOT NULL REFERENCES timetable_drafts(id) ON DELETE CASCADE,

    section_id       uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    period_id        uuid NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    weekday          integer NOT NULL,
    class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    teacher_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    room             text,

    CONSTRAINT timetable_draft_entries_weekday CHECK (weekday BETWEEN 1 AND 7)
);

-- A section cannot be taught two subjects at once.
CREATE UNIQUE INDEX timetable_draft_section_slot
    ON timetable_draft_entries (draft_id, section_id, weekday, period_id);

/* A teacher cannot be in two rooms at once.

   Partial rather than COALESCE'd: an unstaffed period is a real state — the
   school has allocated Sanskrit and not yet hired for it — and several of them
   may legitimately share a slot. A zero-uuid COALESCE here would forbid the
   second one, which is a rule nobody asked for. Every row with a teacher named
   is still covered, which is the clash that matters. */
CREATE UNIQUE INDEX timetable_draft_teacher_slot
    ON timetable_draft_entries (draft_id, teacher_user_id, weekday, period_id)
    WHERE teacher_user_id IS NOT NULL;

CREATE INDEX timetable_draft_entries_by_draft
    ON timetable_draft_entries (draft_id, section_id);

COMMENT ON TABLE timetable_draft_entries IS
    'One period of a candidate timetable. Same shape as timetable_entries so publishing is a copy; the two unique indexes are the two clashes a timetable exists to prevent.';

/* What the run could not do, in words.

   The most important table in this file. A generator that quietly places four
   of Class 8B''s six Maths periods is worse than one that refuses, because the
   school finds out in week three from the class. detail carries the sentence a
   head of department can act on — "Ramesh Kumar is at 34 of 35 periods for the
   week" — because "required 6, placed 4" names no cause and suggests no fix.

   Stored rather than recomputed on read: the report describes the run. Editing
   a teacher's cap tomorrow does not change what happened when the draft was
   generated, and a report that silently rewrites itself is one nobody can
   quote in a meeting. */
CREATE TABLE timetable_draft_issues (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    draft_id       uuid NOT NULL REFERENCES timetable_drafts(id) ON DELETE CASCADE,

    kind     text NOT NULL,
    severity text NOT NULL,

    section_id       uuid REFERENCES sections(id) ON DELETE CASCADE,
    class_subject_id uuid REFERENCES class_subjects(id) ON DELETE CASCADE,
    teacher_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,

    periods_required integer NOT NULL DEFAULT 0,
    periods_placed   integer NOT NULL DEFAULT 0,
    detail           text NOT NULL,

    CONSTRAINT timetable_draft_issues_severity
        CHECK (severity = ANY (ARRAY['blocking', 'warning'])),
    CONSTRAINT timetable_draft_issues_kind
        CHECK (kind = ANY (ARRAY['unmet_periods', 'no_teacher', 'teacher_oversubscribed',
                                 'section_oversubscribed', 'subject_stacked']))
);

CREATE INDEX timetable_draft_issues_by_draft
    ON timetable_draft_issues (draft_id, severity, section_id);

COMMENT ON TABLE timetable_draft_issues IS
    'The failure report for one generator run: which requirements went unmet and which constraint did the blocking, in a sentence.';

-- ================================================= the request for substitution

/* A teacher saying, in advance, that they will not be in.

   substitutions already records the decision — who covered which period on
   which day. What it never recorded is the ask, which is the half the teacher
   submits and somebody else approves. Without it the request lives in a
   WhatsApp message and the approval is a verbal yes nobody can produce in
   August when the proxy allowance is queried.

   leave_request_id links to the leave the teacher already applied for. A
   school that runs leave properly should never type the dates twice, and the
   two records disagreeing about which days a teacher was out is the sort of
   thing payroll finds and nobody can resolve. */
CREATE TABLE substitution_requests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- Both the person and their employment record. The user is who signed in
    -- and who owns the request; the employee is what leave, payroll and the
    -- department roll are keyed on.
    requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    employee_id  uuid REFERENCES employees(id) ON DELETE SET NULL,

    from_date date NOT NULL,
    to_date   date NOT NULL,
    reason    text NOT NULL,

    leave_request_id uuid REFERENCES leave_requests(id) ON DELETE SET NULL,
    -- The colleague the teacher suggests. A suggestion, not an instruction:
    -- the approver decides, and the API checks the suggestion is actually free
    -- before offering it.
    suggested_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

    status        text NOT NULL DEFAULT 'pending',
    decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at    timestamptz,
    decision_note text,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT substitution_requests_dates CHECK (to_date >= from_date),
    CONSTRAINT substitution_requests_status
        CHECK (status = ANY (ARRAY['pending', 'approved', 'partially_approved',
                                   'rejected', 'cancelled'])),
    -- A decided request has a decider and a moment. A pending one has neither,
    -- which is what stops a rejected request from looking like it was never
    -- looked at.
    CONSTRAINT substitution_requests_decision_is_stamped
        CHECK ((status IN ('pending', 'cancelled')) OR
               (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE INDEX substitution_requests_pending
    ON substitution_requests (institution_id, status, from_date);

CREATE INDEX substitution_requests_by_teacher
    ON substitution_requests (requested_by, from_date DESC);

COMMENT ON TABLE substitution_requests IS
    'A teacher asking for cover: which days, why, and optionally who they suggest. Approving writes the day''s cover into substitutions, which every other view already reads.';

/* One period the request needs covered, on one date.

   A range of dates times a weekly timetable is a set of concrete (period,
   date) pairs, and the approver decides them one at a time: a colleague free
   on Tuesday period 3 may be teaching on Wednesday period 3. Expanding the
   range into lines at submission is what makes the suggestion list — "who is
   actually free in *this* period" — answerable at all.

   substitution_id is the link back to the decision. Populated on approval, so
   a line is either an unanswered ask or a pointer at the row that answered it,
   and the two can never drift. */
CREATE TABLE substitution_request_periods (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    request_id     uuid NOT NULL REFERENCES substitution_requests(id) ON DELETE CASCADE,

    timetable_entry_id uuid NOT NULL REFERENCES timetable_entries(id) ON DELETE CASCADE,
    on_date            date NOT NULL,

    -- Filled on approval. NULL on a line the approver declined or has not
    -- reached yet.
    assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    substitution_id  uuid REFERENCES substitutions(id) ON DELETE SET NULL,

    status text NOT NULL DEFAULT 'pending',

    CONSTRAINT substitution_request_periods_status
        CHECK (status = ANY (ARRAY['pending', 'covered', 'declined'])),
    CONSTRAINT substitution_request_periods_covered_has_a_teacher
        CHECK (status <> 'covered' OR assigned_user_id IS NOT NULL)
);

/* One line per period per date within a request. No nullable column in the
   key, so this one is honest as written. */
CREATE UNIQUE INDEX substitution_request_periods_one_per_slot
    ON substitution_request_periods (request_id, timetable_entry_id, on_date);

/* And one open ask per period per date across the whole school.

   Two teachers cannot both be absent from the same period of the same class,
   so a second pending request against the same slot is either a duplicate
   submission or a mistake. Restricted to pending rows: a rejected request must
   not block the teacher from asking again, and substitutions already carries
   UNIQUE (timetable_entry_id, on_date) for the decision itself. */
CREATE UNIQUE INDEX substitution_request_periods_one_open_ask
    ON substitution_request_periods (timetable_entry_id, on_date)
    WHERE status = 'pending';

CREATE INDEX substitution_request_periods_by_date
    ON substitution_request_periods (institution_id, on_date);

COMMENT ON TABLE substitution_request_periods IS
    'One (period, date) a substitution request needs covered, and — once approved — the substitutions row that covers it.';

/* Why this cover was arranged.

   substitutions is written by two paths: the morning board, where somebody
   noticed an absence an hour ago, and an approved request made three weeks
   ago. Both are legitimate and they are not the same thing; without this
   column the morning board cannot tell an arrangement it made from one it
   inherited, and a teacher cannot see that the cover they asked for was
   granted. */
ALTER TABLE substitutions
    ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES substitution_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS substitutions_by_request ON substitutions (request_id)
    WHERE request_id IS NOT NULL;

-- ======================================================== row level security

ALTER TABLE teacher_load_rules            ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_load_rules            FORCE  ROW LEVEL SECURITY;
ALTER TABLE teacher_unavailability        ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_unavailability        FORCE  ROW LEVEL SECURITY;
ALTER TABLE timetable_drafts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetable_drafts              FORCE  ROW LEVEL SECURITY;
ALTER TABLE timetable_draft_entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetable_draft_entries       FORCE  ROW LEVEL SECURITY;
ALTER TABLE timetable_draft_issues        ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetable_draft_issues        FORCE  ROW LEVEL SECURITY;
ALTER TABLE substitution_requests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE substitution_requests         FORCE  ROW LEVEL SECURITY;
ALTER TABLE substitution_request_periods  ENABLE ROW LEVEL SECURITY;
ALTER TABLE substitution_request_periods  FORCE  ROW LEVEL SECURITY;

CREATE POLICY teacher_load_rules_tenant ON teacher_load_rules
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY teacher_unavailability_tenant ON teacher_unavailability
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY timetable_drafts_tenant ON timetable_drafts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY timetable_draft_entries_tenant ON timetable_draft_entries
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY timetable_draft_issues_tenant ON timetable_draft_issues
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY substitution_requests_tenant ON substitution_requests
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY substitution_request_periods_tenant ON substitution_request_periods
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- 00042 sets ALTER DEFAULT PRIVILEGES so tables created after it are covered
-- whichever role creates them. Stated explicitly anyway, for the same reason
-- 00046 states it: a database restored from a dump taken before that migration
-- has the default privileges but not necessarily the creating role.
GRANT SELECT, INSERT, UPDATE, DELETE ON teacher_load_rules           TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON teacher_unavailability       TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON timetable_drafts             TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON timetable_draft_entries      TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON timetable_draft_issues       TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON substitution_requests        TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON substitution_request_periods TO app_user;

-- +goose Down
DROP INDEX IF EXISTS substitutions_by_request;
ALTER TABLE substitutions DROP COLUMN IF EXISTS request_id;
DROP TABLE IF EXISTS substitution_request_periods;
DROP TABLE IF EXISTS substitution_requests;
DROP TABLE IF EXISTS timetable_draft_issues;
DROP TABLE IF EXISTS timetable_draft_entries;
DROP TABLE IF EXISTS timetable_drafts;
DROP TABLE IF EXISTS teacher_unavailability;
DROP TABLE IF EXISTS teacher_load_rules;
ALTER TABLE class_subjects DROP COLUMN IF EXISTS prefers_morning;
ALTER TABLE class_subjects DROP COLUMN IF EXISTS periods_per_week;
