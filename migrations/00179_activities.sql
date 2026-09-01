-- +goose Up

/* Clubs, coaching and electives — the half of school life the product did not
 * hold.
 *
 * A school runs a robotics club on Wednesday afternoons, swimming coaching on
 * Mondays and Thursdays, an abacus class, a music school. Children sign up,
 * most of them cost money, and none of it existed here: the register was a
 * notebook in the activity coordinator's bag, the money was collected in cash
 * against a list, and the child's own record said nothing about the thing they
 * spent four hours a week doing.
 *
 * club_events, which already exists, is not this. That models a one-off
 * ticketed event — a trip, a fixture. An activity is a standing arrangement a
 * child is enrolled in for a term or a year, and the difference is exactly the
 * difference between a ticket and a subscription.
 *
 * WHY THE FEE IS ON THE ACTIVITY AND NOT ON THE ENROLMENT
 *
 * The price is a property of the club, not of the child in it — which means
 * raising it next term changes one row, and a school cannot end up charging
 * two families different amounts for the same thing by accident. What the
 * child actually owes is an invoice line, and that is deliberately a snapshot:
 * a family enrolled at ₹2,500 keeps owing ₹2,500 when the club puts its price
 * up in April.
 */

CREATE TABLE IF NOT EXISTS activities (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE SET NULL,
    name            text NOT NULL,
    -- Free text with suggestions on the screen, not an enum. A school that
    -- runs a Vedic maths class should not have to file it under "Sports".
    category        text NOT NULL DEFAULT 'Club',
    -- "Wed 3-4 PM", "Mon/Thu 4-5 PM". Deliberately a SENTENCE rather than a
    -- structured timetable: an activity meets outside the school day, is
    -- rearranged constantly, and modelling it as periods would put it into
    -- clash detection against a timetable it has nothing to do with.
    schedule        text,
    coordinator_id  uuid REFERENCES employees(id) ON DELETE SET NULL,
    venue           text,
    -- Nought is an ordinary answer: plenty of clubs are free.
    fee_paise       bigint NOT NULL DEFAULT 0,
    -- Nought means "no limit", which is the common case.
    capacity        int NOT NULL DEFAULT 0,
    -- Wound up rather than deleted, so the enrolments and the fees raised
    -- against it keep reading.
    is_active       boolean NOT NULL DEFAULT true,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT activities_fee_sane CHECK (fee_paise >= 0 AND fee_paise <= 10000000),
    CONSTRAINT activities_capacity_sane CHECK (capacity >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS activities_name_per_school
    ON activities (institution_id, lower(name));

CREATE TABLE IF NOT EXISTS student_activities (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    activity_id     uuid NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
    enrolled_on     date NOT NULL DEFAULT CURRENT_DATE,
    left_on         date,
    status          text NOT NULL DEFAULT 'enrolled',
    /* The bill this enrolment raised, where it raised one.
     *
     * Nullable on purpose and in three ordinary cases: a free club, a child
     * the school has waived the fee for, and an enrolment made before the
     * invoice run. Keeping the link means "has this family paid for swimming"
     * is answerable, and cancelling an enrolment can find what to credit. */
    invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,
    -- What the child was actually charged, frozen at enrolment. The activity's
    -- own fee may move; what this family owes must not move with it.
    fee_paise       bigint NOT NULL DEFAULT 0,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_activities_status_check
        CHECK (status IN ('enrolled', 'left', 'waitlisted')),
    CONSTRAINT student_activities_fee_sane CHECK (fee_paise >= 0)
);

/* One live enrolment per child per activity.
 *
 * Partial, on status: a child who left the robotics club in October and
 * rejoined in January is two rows and a real history, and a plain unique
 * index would refuse the second. */
CREATE UNIQUE INDEX IF NOT EXISTS student_activities_one_live
    ON student_activities (student_id, activity_id)
    WHERE status = 'enrolled';

CREATE INDEX IF NOT EXISTS student_activities_by_activity
    ON student_activities (activity_id) WHERE status = 'enrolled';

COMMENT ON TABLE activities IS
    'Standing clubs, coaching and electives a child enrols in for a term or a '
    'year. Distinct from club_events, which is a one-off ticketed occasion.';
COMMENT ON COLUMN student_activities.fee_paise IS
    'Frozen at enrolment. The activity''s price may rise; what this family '
    'owes does not rise with it.';

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON activities;
CREATE POLICY tenant_isolation ON activities
    USING (app_is_platform_admin() OR institution_id = app_current_institution());

ALTER TABLE student_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON student_activities;
CREATE POLICY tenant_isolation ON student_activities
    USING (app_is_platform_admin() OR institution_id = app_current_institution());

-- +goose Down
DROP TABLE IF EXISTS student_activities;
DROP TABLE IF EXISTS activities;
