-- +goose Up
-- The NEP 2020 Holistic Progress Card.
--
-- Everything assessment-related here counted marks: exam_subjects, marks,
-- report_cards. That is CCE, and NEP replaced it. The HPC asks a different
-- question — not "what did they score" but "how are they developing" — across
-- three domains, gathered from four points of view, and reported differently
-- at each stage of school.
--
-- Three tables rather than columns on report_cards, because an observation is
-- not a mark: it has an observer, it accumulates through the term rather than
-- arriving on exam day, and the same competency is rated by four different
-- people whose views are meant to differ.

-- The things a school observes. Seeded below with the NEP set; a school may
-- add its own, which is why this is a table and not an enum.
CREATE TABLE hpc_competencies (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    domain          text        NOT NULL,
    code            text        NOT NULL,
    name            text        NOT NULL,
    description     text,
    -- Which stages this applies to. Empty means every stage: "works well with
    -- others" is observed in Class 2 and Class 10 alike, while "evaluates
    -- sources critically" is not a foundational competency.
    stages          text[]      NOT NULL DEFAULT '{}',
    sequence        integer     NOT NULL DEFAULT 0,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hpc_competencies_domain_check
        CHECK (domain IN ('cognitive', 'affective', 'psychomotor')),
    CONSTRAINT hpc_competencies_unique UNIQUE (institution_id, code)
);

/* One person's view of one competency for one child, this term.

   observer_role is the 360 loop the framework requires: the teacher's view,
   the child's own, a classmate's and the parent's. They are stored side by
   side and never averaged into one number — the disagreement is the point.

   level is 1-4 rather than a mark, because at every stage below Class 6 the
   HPC forbids numerical grading outright. Storing an ordinal lets the card
   show words at one stage and contribute to a grade at another without
   holding the data twice. */
CREATE TABLE hpc_observations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    competency_id   uuid        NOT NULL REFERENCES hpc_competencies(id) ON DELETE CASCADE,
    term_id         uuid        REFERENCES terms(id) ON DELETE SET NULL,
    academic_year_id uuid       REFERENCES academic_years(id) ON DELETE SET NULL,
    observer_role   text        NOT NULL,
    observed_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    -- 1 beginner, 2 progressing, 3 proficient, 4 advanced.
    level           smallint,
    -- The part a parent actually reads. A rating with no example is a number
    -- pretending to be feedback.
    note            text,
    observed_on     date        NOT NULL DEFAULT CURRENT_DATE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hpc_observations_role_check
        CHECK (observer_role IN ('teacher', 'self', 'peer', 'parent')),
    CONSTRAINT hpc_observations_level_check
        CHECK (level IS NULL OR level BETWEEN 1 AND 4),
    -- A rating with neither a level nor a note is an empty row.
    CONSTRAINT hpc_observations_has_content
        CHECK (level IS NOT NULL OR nullif(btrim(note), '') IS NOT NULL)
);

/* One rating per observer per competency per term.

   term_id is nullable and a plain UNIQUE would let every NULL through — the
   trap four earlier migrations in this repo already hit. COALESCE to a fixed
   sentinel so "no term" is a value like any other.

   observed_by is in the key so two different peers may each rate the same
   competency; without it the second classmate would overwrite the first. */
CREATE UNIQUE INDEX hpc_observations_one_per_observer
    ON hpc_observations (
        student_id, competency_id, observer_role,
        COALESCE(term_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(observed_by, '00000000-0000-0000-0000-000000000000'::uuid)
    );

CREATE INDEX hpc_observations_student ON hpc_observations (student_id, term_id);

ALTER TABLE hpc_competencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hpc_competencies FORCE ROW LEVEL SECURITY;
ALTER TABLE hpc_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hpc_observations FORCE ROW LEVEL SECURITY;

CREATE POLICY hpc_competencies_tenant ON hpc_competencies
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY hpc_observations_tenant ON hpc_observations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose StatementBegin
/* Seed the NEP competency set for every existing school.

   Written as a function rather than a flat INSERT because it runs once per
   institution and again for schools created later; the seller's provisioning
   path calls the same list through Go. */
DO $$
DECLARE
    inst uuid;
    rec  record;
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);
    FOR inst IN SELECT id FROM institutions LOOP
        FOR rec IN
            SELECT * FROM (VALUES
              -- Cognitive: what NEP calls higher-order rather than recall.
              ('cognitive','COG-CURIOSITY','Curiosity and questioning',
               'Asks questions that go beyond what was taught.', ARRAY[]::text[], 1),
              ('cognitive','COG-REASON','Reasoning and problem solving',
               'Breaks a problem down and explains the steps taken.', ARRAY[]::text[], 2),
              ('cognitive','COG-APPLY','Application to real situations',
               'Uses what was learned outside the lesson it was learned in.', ARRAY[]::text[], 3),
              ('cognitive','COG-CRITICAL','Critical thinking',
               'Weighs evidence and notices when a claim is unsupported.',
               ARRAY['middle','secondary','senior_secondary'], 4),
              ('cognitive','COG-CREATE','Creativity and originality',
               'Produces work that is their own rather than copied.', ARRAY[]::text[], 5),
              ('cognitive','COG-LANG','Language and expression',
               'Explains an idea clearly in speech and in writing.', ARRAY[]::text[], 6),
              -- Affective and socio-emotional.
              ('affective','AFF-TEAM','Works well with others',
               'Contributes to group work and listens to other views.', ARRAY[]::text[], 1),
              ('affective','AFF-EMPATHY','Empathy and kindness',
               'Notices when a classmate needs help and offers it.', ARRAY[]::text[], 2),
              ('affective','AFF-REGULATE','Emotional regulation',
               'Handles frustration and disappointment without disruption.', ARRAY[]::text[], 3),
              ('affective','AFF-RESPONSIBLE','Responsibility and honesty',
               'Owns mistakes; work and belongings are looked after.', ARRAY[]::text[], 4),
              ('affective','AFF-RESPECT','Respect for diversity',
               'Treats classmates of every background as equals.', ARRAY[]::text[], 5),
              ('affective','AFF-INITIATIVE','Initiative and persistence',
               'Keeps going at something difficult without being pushed.', ARRAY[]::text[], 6),
              -- Psychomotor, read from PE, health and activities.
              ('psychomotor','PSY-FITNESS','Physical fitness and stamina',
               'Takes part fully in physical activity.', ARRAY[]::text[], 1),
              ('psychomotor','PSY-COORD','Coordination and motor skill',
               'Handles equipment, tools and instruments with control.', ARRAY[]::text[], 2),
              ('psychomotor','PSY-SPORT','Participation in sport and games',
               'Joins in, and plays within the rules.', ARRAY[]::text[], 3),
              ('psychomotor','PSY-ARTS','Performing and visual arts',
               'Takes part in music, dance, drama or art.', ARRAY[]::text[], 4),
              ('psychomotor','PSY-HABITS','Health and hygiene habits',
               'Daily habits of cleanliness, diet and rest.', ARRAY[]::text[], 5)
            ) AS t(domain, code, name, description, stages, sequence)
        LOOP
            INSERT INTO hpc_competencies
                (institution_id, domain, code, name, description, stages, sequence)
            VALUES (inst, rec.domain, rec.code, rec.name, rec.description,
                    rec.stages, rec.sequence)
            ON CONFLICT (institution_id, code) DO NOTHING;
        END LOOP;
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS hpc_observations;
DROP TABLE IF EXISTS hpc_competencies;
