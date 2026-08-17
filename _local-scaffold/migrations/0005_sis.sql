-- 0005_sis: academic structure and the student information system.
--
-- The shape here carries three rules that are expensive to retrofit:
--
--   1. A student's class is NOT a column on students. It is an enrollment row
--      per academic year, so last year's class survives this year's promotion.
--      Overwriting it would destroy the record a transfer certificate is built
--      from.
--   2. A guardian is a person, not a pair of columns on the student. One parent
--      with three children is one row and three links — which is what makes a
--      single parent login work.
--   3. Teachers are linked to sections here, not to students. A teacher's access
--      is derived from what they teach, so it changes when the timetable does.

-- ----------------------------------------------------------- structure ------

CREATE TABLE houses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id       uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    name            text NOT NULL,
    colour          text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT houses_name_unique UNIQUE (school_id, name)
);

-- A grade is "Class 8" as an idea; a section is "8A" in a given year.
-- level orders them for promotion: Nursery is -3, LKG -2, UKG -1, Class 1 is 1.
CREATE TABLE grades (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id       uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    name            text NOT NULL,
    level           int  NOT NULL,
    stage           text NOT NULL DEFAULT 'primary'
                    CHECK (stage IN ('pre_primary', 'primary', 'middle',
                                     'secondary', 'senior_secondary')),
    stream          text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT grades_name_unique UNIQUE (school_id, name)
);
-- A unique index rather than a table constraint: constraints cannot contain an
-- expression, and streams (Class 11 Science vs Commerce) share a level.
CREATE UNIQUE INDEX grades_level_unique
    ON grades (school_id, level, coalesce(stream, ''));
CREATE INDEX grades_school_idx ON grades (organization_id, school_id, level);

CREATE TABLE sections (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id        uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    grade_id         uuid NOT NULL REFERENCES grades (id) ON DELETE RESTRICT,
    academic_year_id uuid NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
    campus_id        uuid REFERENCES campuses (id) ON DELETE SET NULL,
    name             text NOT NULL,
    -- NULL means "no cap configured". Zero would mean "nobody may enrol", which
    -- is a different statement, and schools do run uncapped sections.
    capacity         int CHECK (capacity IS NULL OR capacity > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    archived_at      timestamptz,
    CONSTRAINT sections_name_unique UNIQUE (grade_id, academic_year_id, name)
);
CREATE INDEX sections_year_idx ON sections (organization_id, school_id, academic_year_id);

CREATE TABLE subjects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id       uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    name            text NOT NULL,
    code            text NOT NULL,
    kind            text NOT NULL DEFAULT 'core'
                    CHECK (kind IN ('core', 'elective', 'language',
                                    'co_scholastic', 'activity')),
    is_graded       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz,
    CONSTRAINT subjects_code_unique UNIQUE (school_id, code)
);

-- Who teaches what. A teacher's data access is derived from these rows: change
-- the allocation and the access changes with it, with no separate grant to
-- remember to revoke.
CREATE TABLE section_teachers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id       uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    section_id      uuid NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
    -- References users, not staff: the HR module lands in Phase 9 and will link
    -- staff.user_id to these same accounts. Pointing at users now means no
    -- migration of the authorization path later.
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind            text NOT NULL CHECK (kind IN ('class_teacher', 'subject_teacher')),
    subject_id      uuid REFERENCES subjects (id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT section_teachers_subject_required
        CHECK (kind = 'class_teacher' OR subject_id IS NOT NULL)
);
-- One class teacher per section at a time.
CREATE UNIQUE INDEX section_teachers_one_class_teacher
    ON section_teachers (section_id)
    WHERE kind = 'class_teacher' AND status = 'active';
CREATE UNIQUE INDEX section_teachers_unique_allocation
    ON section_teachers (section_id, user_id, kind, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE status = 'active';
CREATE INDEX section_teachers_user_idx ON section_teachers (user_id) WHERE status = 'active';

-- -------------------------------------------------------------- people ------

CREATE TABLE guardians (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id       uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    full_name       text NOT NULL,
    phone           text,
    email           citext,
    occupation      text,
    employer        text,
    address         jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Set once the guardian has a login. One account, many children.
    user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz,
    CONSTRAINT guardians_contactable CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX guardians_user_idx  ON guardians (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX guardians_phone_idx ON guardians (organization_id, phone);
CREATE INDEX guardians_name_trgm ON guardians USING gin (full_name gin_trgm_ops);

CREATE TABLE students (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id        uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    campus_id        uuid REFERENCES campuses (id) ON DELETE SET NULL,
    admission_number text NOT NULL,
    first_name       text NOT NULL,
    middle_name      text,
    last_name        text NOT NULL,
    preferred_name   text,
    date_of_birth    date NOT NULL,
    gender           text NOT NULL DEFAULT 'unspecified'
                     CHECK (gender IN ('male', 'female', 'other', 'unspecified')),
    blood_group      text,
    mother_tongue    text,
    nationality      text NOT NULL DEFAULT 'Indian',
    -- Optional and off by default. Collected only where a school needs it for
    -- statutory reporting, and treated as restricted data when it is.
    category         text,
    religion         text,
    address          jsonb NOT NULL DEFAULT '{}'::jsonb,
    house_id         uuid REFERENCES houses (id) ON DELETE SET NULL,
    admission_date   date NOT NULL DEFAULT current_date,
    previous_school  jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- A login for the student themselves. Optional: a Nursery child has none.
    user_id          uuid REFERENCES users (id) ON DELETE SET NULL,
    status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('applicant', 'active', 'transferred',
                                       'withdrawn', 'graduated', 'alumni', 'dropped')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    created_by       uuid,
    updated_by       uuid,
    archived_at      timestamptz,
    CONSTRAINT students_admission_number_unique UNIQUE (school_id, admission_number),
    CONSTRAINT students_dob_sane CHECK (date_of_birth > '1900-01-01' AND date_of_birth < current_date)
);
CREATE INDEX students_school_idx ON students (organization_id, school_id, status);
CREATE INDEX students_user_idx   ON students (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX students_name_trgm  ON students USING gin (
    (first_name || ' ' || coalesce(middle_name, '') || ' ' || last_name) gin_trgm_ops);
CREATE INDEX students_admission_number_trgm ON students USING gin (admission_number gin_trgm_ops);

-- Restricted identifiers, stored separately so the sensitive columns are not
-- dragged into every SELECT that needs a name. Values are encrypted by the
-- application before they arrive here.
CREATE TABLE student_identifiers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    student_id      uuid NOT NULL REFERENCES students (id) ON DELETE CASCADE,
    kind            text NOT NULL CHECK (kind IN ('udise_pen', 'apaar', 'aadhaar_ref',
                                                  'board_roll', 'other')),
    value_encrypted bytea NOT NULL,
    issued_on       date,
    verified_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_identifiers_unique UNIQUE (student_id, kind)
);

CREATE TABLE student_guardians (
    student_id               uuid NOT NULL REFERENCES students (id) ON DELETE CASCADE,
    guardian_id              uuid NOT NULL REFERENCES guardians (id) ON DELETE CASCADE,
    organization_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    relation                 text NOT NULL
                             CHECK (relation IN ('father', 'mother', 'guardian', 'other')),
    is_primary               boolean NOT NULL DEFAULT false,
    is_emergency_contact     boolean NOT NULL DEFAULT false,
    financial_responsibility boolean NOT NULL DEFAULT false,
    pickup_authorised        boolean NOT NULL DEFAULT true,
    status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'revoked')),
    created_at               timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (student_id, guardian_id, relation)
);
-- One primary guardian per student: the person the school rings first.
CREATE UNIQUE INDEX student_guardians_one_primary
    ON student_guardians (student_id) WHERE is_primary AND status = 'active';
CREATE INDEX student_guardians_guardian_idx
    ON student_guardians (guardian_id) WHERE status = 'active';

-- --------------------------------------------------------- enrollment ------

CREATE TABLE enrollments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id        uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    student_id       uuid NOT NULL REFERENCES students (id) ON DELETE RESTRICT,
    academic_year_id uuid NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
    grade_id         uuid NOT NULL REFERENCES grades (id) ON DELETE RESTRICT,
    section_id       uuid NOT NULL REFERENCES sections (id) ON DELETE RESTRICT,
    roll_number      int,
    status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'promoted', 'detained',
                                       'transferred', 'withdrawn', 'graduated')),
    started_on       date NOT NULL DEFAULT current_date,
    ended_on         date,
    result_status    text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT enrollments_ended_after_start CHECK (ended_on IS NULL OR ended_on >= started_on)
);
-- The rule that makes history reliable: a student sits in exactly one section
-- per academic year at a time. Promotion closes one row and opens another.
CREATE UNIQUE INDEX enrollments_one_active_per_year
    ON enrollments (student_id, academic_year_id) WHERE status = 'active';
CREATE UNIQUE INDEX enrollments_roll_number_unique
    ON enrollments (section_id, roll_number)
    WHERE roll_number IS NOT NULL AND status = 'active';
CREATE INDEX enrollments_section_idx ON enrollments (section_id) WHERE status = 'active';
CREATE INDEX enrollments_student_idx ON enrollments (student_id, academic_year_id);

-- Every change of standing, kept forever. This is what a transfer certificate,
-- an alumni record and a parent's "why was my child moved" question are answered
-- from.
CREATE TABLE student_lifecycle_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    student_id      uuid NOT NULL REFERENCES students (id) ON DELETE CASCADE,
    kind            text NOT NULL CHECK (kind IN ('admitted', 'enrolled', 'section_changed',
                                                  'promoted', 'detained', 'transferred',
                                                  'withdrawn', 'readmitted', 'graduated')),
    from_state      jsonb,
    to_state        jsonb,
    effective_on    date NOT NULL DEFAULT current_date,
    reason          text,
    actor_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_lifecycle_student_idx
    ON student_lifecycle_events (student_id, effective_on DESC);

-- --------------------------------------------------------------- RLS --------

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['houses', 'grades', 'sections', 'subjects',
                             'section_teachers', 'guardians', 'students',
                             'student_identifiers', 'student_guardians',
                             'enrollments', 'student_lifecycle_events']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON %I
                USING (app_org_bound() AND organization_id = app_current_org())
                WITH CHECK (app_org_bound() AND organization_id = app_current_org())
        $f$, t);
    END LOOP;
END $$;

DO $$
DECLARE
    app_role text := coalesce(nullif(current_setting('erp.app_role', true), ''), 'schoolerp_app');
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON houses, grades, sections, subjects, '
                || 'section_teachers, guardians, students, student_identifiers, '
                || 'student_guardians, enrollments, student_lifecycle_events TO %I', app_role);
    -- Lifecycle events are the student's history: append-only, like the audit log.
    EXECUTE format('REVOKE UPDATE, DELETE ON student_lifecycle_events FROM %I', app_role);
END $$;
