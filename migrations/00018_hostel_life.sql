-- +goose Up
-- A warden's day: who left, who complained, what is for dinner.
--
-- The hostel module could allocate a bed and nothing else. The three things a
-- warden actually does between allocations are letting boarders out, chasing
-- repairs, and feeding people — and the first of those is the one a school
-- gets sued over.

/* An outpass: a boarder leaving campus.

   Modelled as two approvals and two timestamps rather than a status flag,
   because each is a separate fact somebody is accountable for. The warden
   permits it, the guardian consents to it, the gate records the leaving and
   the return. A single "approved" boolean cannot answer the question that
   matters at ten at night — who is out, and who said they could be. */
CREATE TABLE hostel_outpasses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    requested_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
    reason          text        NOT NULL,
    destination     text,
    -- Who the child is going to and how to reach them. The single most useful
    -- field on this table when someone does not come back.
    escort_name     text,
    escort_phone    text,
    expected_out    timestamptz NOT NULL,
    expected_in     timestamptz NOT NULL,
    status          text        NOT NULL DEFAULT 'requested',
    -- The warden's permission.
    approved_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    approved_at     timestamptz,
    decision_note   text,
    -- The guardian's consent, separate from it. A warden may permit a trip the
    -- parent has not agreed to, and that gap is exactly what a school needs to
    -- see before the child is at the gate.
    guardian_consent_by uuid    REFERENCES users(id) ON DELETE SET NULL,
    guardian_consent_at timestamptz,
    -- What the gate recorded.
    actual_out      timestamptz,
    actual_in       timestamptz,
    gate_note       text,
    -- Who was on the gate. The pass records four different people doing four
    -- different things, and "who signed this child out" is the one a school is
    -- asked for afterwards.
    gate_by         uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hostel_outpasses_status
        CHECK (status IN ('requested','approved','rejected','out','returned','cancelled')),
    CONSTRAINT hostel_outpasses_window CHECK (expected_in > expected_out),
    -- A rejection with no reason is an argument the warden has to have twice.
    CONSTRAINT hostel_outpasses_rejection_has_note
        CHECK (status <> 'rejected' OR nullif(btrim(decision_note), '') IS NOT NULL)
);

-- The query the warden runs at lights-out: who is still out.
CREATE INDEX hostel_outpasses_open
    ON hostel_outpasses (institution_id, expected_in)
 WHERE status IN ('approved', 'out');

CREATE INDEX hostel_outpasses_student ON hostel_outpasses (student_id, created_at DESC);

/* A hostel complaint.

   Deliberately not the school's general grievance table: a broken geyser is
   raised by a boarder, fixed by the warden, and never leaves the block. Mixing
   it with academic grievances would bury both. */
CREATE TABLE hostel_complaints (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        REFERENCES students(id) ON DELETE SET NULL,
    room_id         uuid        REFERENCES hostel_rooms(id) ON DELETE SET NULL,
    raised_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    category        text        NOT NULL DEFAULT 'other',
    subject         text        NOT NULL,
    detail          text,
    priority        text        NOT NULL DEFAULT 'normal',
    status          text        NOT NULL DEFAULT 'open',
    assigned_to     text,
    resolution      text,
    resolved_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hostel_complaints_category
        CHECK (category IN ('maintenance','food','cleanliness','safety','wifi','other')),
    CONSTRAINT hostel_complaints_priority
        CHECK (priority IN ('low','normal','high','urgent')),
    CONSTRAINT hostel_complaints_status
        CHECK (status IN ('open','in_progress','resolved','closed')),
    CONSTRAINT hostel_complaints_resolved_has_resolution
        CHECK (status NOT IN ('resolved','closed')
               OR nullif(btrim(resolution), '') IS NOT NULL)
);

CREATE INDEX hostel_complaints_open ON hostel_complaints (institution_id, created_at DESC)
 WHERE status IN ('open', 'in_progress');

/* The mess menu.

   One row per meal per day. A weekly repeating menu would be tidier and wrong:
   every hostel varies it for festivals, and a menu nobody can override is a
   menu nobody keeps up to date. */
CREATE TABLE mess_menus (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    on_date         date        NOT NULL,
    meal            text        NOT NULL,
    items           text        NOT NULL,
    -- Counted at service, for the kitchen's own reckoning against stores.
    served_count    integer,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mess_menus_meal
        CHECK (meal IN ('breakfast','lunch','snacks','dinner'))
);

CREATE UNIQUE INDEX mess_menus_one_per_meal ON mess_menus (institution_id, on_date, meal);

ALTER TABLE hostel_outpasses ENABLE ROW LEVEL SECURITY;
ALTER TABLE hostel_outpasses FORCE ROW LEVEL SECURITY;
ALTER TABLE hostel_complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE hostel_complaints FORCE ROW LEVEL SECURITY;
ALTER TABLE mess_menus ENABLE ROW LEVEL SECURITY;
ALTER TABLE mess_menus FORCE ROW LEVEL SECURITY;

CREATE POLICY hostel_outpasses_tenant ON hostel_outpasses
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY hostel_complaints_tenant ON hostel_complaints
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY mess_menus_tenant ON mess_menus
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS mess_menus;
DROP TABLE IF EXISTS hostel_complaints;
DROP TABLE IF EXISTS hostel_outpasses;
