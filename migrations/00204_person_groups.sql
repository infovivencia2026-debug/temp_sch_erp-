-- +goose Up
-- Named groups of people, defined by hand or by a rule.
--
-- A school's own groupings are not the ones this product ships with. Classes,
-- sections and houses are here; the swimming squad, the bus that leaves at
-- 3.15, the twelve children whose fees are paid by a trust, the staff who ran
-- last year's exam duty and the four teachers trained on the new lab are not,
-- and every one of them is a list the office currently keeps in a notebook or
-- a spreadsheet and retypes into the message screen.
--
-- TWO KINDS OF GROUP, one table, because the difference is what fills them and
-- not what they are for:
--
--   * Picked by hand. The list is the point and nothing derives it — the six
--     children going on Saturday's trip.
--   * Defined by a rule. "Class 6, girls, on the roll" is a fact about a query
--     rather than about twelve names, and a group that has to be re-picked
--     every time a child joins the class is a group that will be wrong by
--     Tuesday.
--
-- A group may be both: the rule finds most of them and a few are added by
-- hand. Members are the union, which is the answer that surprises nobody.
--
-- RULES ARE STORED, NOT SQL. The column holds what the office chose — a field,
-- an operator, a value — and the server builds the query from a whitelist. A
-- saved query language in a jsonb column is a saved injection.
CREATE TABLE IF NOT EXISTS person_groups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- student | staff. A group never mixes: the fields you can filter on and
    -- the screens that use it are different for each.
    kind            text NOT NULL CHECK (kind IN ('student', 'staff')),
    name            text NOT NULL,
    note            text,
    -- [] means "nobody by rule", which is a hand-picked group.
    rules           jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS person_groups_institution_kind_name
    ON person_groups (institution_id, kind, lower(name));

-- The hand-picked half. Exactly one of the two person columns is filled, which
-- the check enforces rather than trusting every writer to remember.
CREATE TABLE IF NOT EXISTS person_group_members (
    group_id       uuid NOT NULL REFERENCES person_groups(id) ON DELETE CASCADE,
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id     uuid REFERENCES students(id) ON DELETE CASCADE,
    employee_id    uuid REFERENCES employees(id) ON DELETE CASCADE,
    added_at       timestamptz NOT NULL DEFAULT now(),
    added_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    CHECK (num_nonnulls(student_id, employee_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS person_group_members_student
    ON person_group_members (group_id, student_id) WHERE student_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS person_group_members_employee
    ON person_group_members (group_id, employee_id) WHERE employee_id IS NOT NULL;

ALTER TABLE person_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_groups        FORCE  ROW LEVEL SECURITY;
ALTER TABLE person_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_group_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON person_groups
    USING (app_is_platform_admin() OR institution_id = app_current_institution())
    WITH CHECK (app_is_platform_admin() OR institution_id = app_current_institution());
CREATE POLICY tenant_isolation ON person_group_members
    USING (app_is_platform_admin() OR institution_id = app_current_institution())
    WITH CHECK (app_is_platform_admin() OR institution_id = app_current_institution());

COMMENT ON COLUMN person_groups.rules IS
  'What the office chose, as [{field,op,value}]. Never SQL: the server builds '
  'the query from a whitelist of fields, so a rule cannot name a column.';

-- +goose Down
DROP TABLE IF EXISTS person_group_members;
DROP TABLE IF EXISTS person_groups;
