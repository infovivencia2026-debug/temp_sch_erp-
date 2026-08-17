-- +goose Up
-- The transport office, minus the satellites.
--
-- The product knew which bus ran which route and which child was on it. What
-- it could not answer is everything a transport manager is actually asked:
-- whose licence expires next month, who got on the bus this morning, what the
-- diesel cost, and where the 3:15 has got to.
--
-- Live GPS tracking, geofenced arrival alerts, speeding detection, fuel-tank
-- telematics, in-bus CCTV and AIS-140/VAHAN registration are deliberately not
-- here: each needs a certified device in the vehicle and a vendor feed, and a
-- screen that draws a bus on a map from no position data would be a lie.

/* A driver or attendant, beyond their employee record.

   Kept apart from employees because these facts belong to the job rather than
   the person: a teacher has no licence expiry, and a school with fifty staff
   and four drivers should not carry four columns that are null forty-six
   times. Every field here is one a transport inspection asks for. */
CREATE TABLE transport_staff (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    role            text        NOT NULL DEFAULT 'driver',
    licence_no      text,
    licence_expiry  date,
    badge_no        text,
    -- Police verification is a statutory requirement for anyone carrying
    -- children, and the date it was done is what an inspection asks for --
    -- a boolean saying "verified" with no date proves nothing.
    police_verified_on date,
    police_ref      text,
    medical_expiry  date,
    blood_group     text,
    phone           text,
    notes           text,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT transport_staff_role CHECK (role IN ('driver','attendant','cleaner')),
    -- A driver with no licence number on file is the finding, so it is allowed
    -- to be null; a driver whose row says they have one but not when it runs
    -- out is a gap that hides itself.
    CONSTRAINT transport_staff_licence_dated
        CHECK (licence_no IS NULL OR licence_expiry IS NOT NULL)
);

CREATE UNIQUE INDEX transport_staff_one_per_employee
    ON transport_staff (employee_id) WHERE is_active;

/* Who got on the bus.

   One row per child per leg per day. The catalogue calls this an RFID scan,
   but the tag is only an input device: what matters is the record, and a
   school whose reader is broken still needs the attendant to be able to mark
   the register by hand. */
CREATE TABLE transport_attendance (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    route_id        uuid        REFERENCES routes(id) ON DELETE SET NULL,
    stop_id         uuid        REFERENCES route_stops(id) ON DELETE SET NULL,
    on_date         date        NOT NULL DEFAULT current_date,
    leg             text        NOT NULL,
    -- boarded and alighted are separate because a child who got on and was
    -- never seen to get off is the single most urgent row in this table.
    boarded_at      timestamptz,
    alighted_at     timestamptz,
    status          text        NOT NULL DEFAULT 'boarded',
    source          text        NOT NULL DEFAULT 'manual',
    marked_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    remarks         text,
    CONSTRAINT transport_attendance_leg CHECK (leg IN ('morning','afternoon')),
    CONSTRAINT transport_attendance_status
        CHECK (status IN ('boarded','alighted','absent','not_scanned')),
    CONSTRAINT transport_attendance_source CHECK (source IN ('manual','scan'))
);

CREATE UNIQUE INDEX transport_attendance_one_per_leg
    ON transport_attendance (student_id, on_date, leg);

-- The query the office runs at four o'clock: who is still on a bus.
CREATE INDEX transport_attendance_open
    ON transport_attendance (institution_id, on_date)
 WHERE alighted_at IS NULL AND status = 'boarded';

/* Fuel, servicing and repairs, in one table.

   Splitting them would be tidier and less useful: the number a school governs
   by is cost per kilometre per vehicle, which needs all three together, and
   the odometer reading that makes mileage computable is recorded the same way
   whichever it is. */
CREATE TABLE vehicle_logs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    vehicle_id      uuid        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    kind            text        NOT NULL,
    on_date         date        NOT NULL DEFAULT current_date,
    odometer_km     integer,
    litres          numeric(8,2),
    amount_paise    bigint      NOT NULL DEFAULT 0,
    vendor          text,
    invoice_no      text,
    -- When the vehicle is next due back, for servicing. The transport office's
    -- other diary.
    next_due_on     date,
    notes           text,
    recorded_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vehicle_logs_kind CHECK (kind IN ('fuel','service','repair','tyre','insurance','other')),
    CONSTRAINT vehicle_logs_fuel_has_litres
        CHECK (kind <> 'fuel' OR (litres IS NOT NULL AND litres > 0))
);

CREATE INDEX vehicle_logs_vehicle ON vehicle_logs (vehicle_id, on_date DESC);

/* The pre-trip check, signed before the bus moves.

   A checklist stored as columns rather than rows: these six are fixed by what
   the RTO asks, they are answered together or not at all, and a school adding
   a seventh is changing its policy, not its data. */
CREATE TABLE trip_checks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    vehicle_id      uuid        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    route_id        uuid        REFERENCES routes(id) ON DELETE SET NULL,
    on_date         date        NOT NULL DEFAULT current_date,
    leg             text        NOT NULL,
    driver_employee_id uuid     REFERENCES employees(id) ON DELETE SET NULL,
    brakes_ok       boolean     NOT NULL DEFAULT false,
    tyres_ok        boolean     NOT NULL DEFAULT false,
    lights_ok       boolean     NOT NULL DEFAULT false,
    first_aid_ok    boolean     NOT NULL DEFAULT false,
    extinguisher_ok boolean     NOT NULL DEFAULT false,
    doors_ok        boolean     NOT NULL DEFAULT false,
    -- Recorded as a reading, not a pass mark. "Cleared" hides who decided what
    -- cleared means; 0.00 is a fact.
    breathalyser    numeric(4,2),
    cleared         boolean     NOT NULL DEFAULT false,
    remarks         text,
    checked_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    checked_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trip_checks_leg CHECK (leg IN ('morning','afternoon')),
    -- A bus cannot be cleared with a failed item or a positive reading. The
    -- constraint is here rather than only in the handler because this is the
    -- one record in the product that a court would read.
    CONSTRAINT trip_checks_cleared_means_clear
        CHECK (NOT cleared OR (brakes_ok AND tyres_ok AND lights_ok
               AND first_aid_ok AND extinguisher_ok AND doors_ok
               AND COALESCE(breathalyser, 0) = 0))
);

CREATE UNIQUE INDEX trip_checks_one_per_leg
    ON trip_checks (vehicle_id, on_date, leg);

/* A bus that did not do what it was supposed to.

   Breakdowns, delays and diversions in one table, because the office handles
   them the same way — tell the parents, send another bus, write down when it
   was over. */
CREATE TABLE transport_incidents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    vehicle_id      uuid        REFERENCES vehicles(id) ON DELETE SET NULL,
    route_id        uuid        REFERENCES routes(id) ON DELETE SET NULL,
    on_date         date        NOT NULL DEFAULT current_date,
    leg             text,
    kind            text        NOT NULL,
    reported_at     timestamptz NOT NULL DEFAULT now(),
    delay_minutes   integer,
    description     text        NOT NULL,
    -- The bus that went out instead. Naming it is the difference between a
    -- dispatch record and a note.
    replacement_vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
    parents_informed boolean    NOT NULL DEFAULT false,
    resolved_at     timestamptz,
    resolution      text,
    reported_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT transport_incidents_kind
        CHECK (kind IN ('breakdown','delay','diversion','accident','other')),
    CONSTRAINT transport_incidents_resolved_has_note
        CHECK (resolved_at IS NULL OR nullif(btrim(resolution), '') IS NOT NULL)
);

CREATE INDEX transport_incidents_open
    ON transport_incidents (institution_id, on_date DESC)
 WHERE resolved_at IS NULL;

ALTER TABLE transport_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_staff FORCE ROW LEVEL SECURITY;
ALTER TABLE transport_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_attendance FORCE ROW LEVEL SECURITY;
ALTER TABLE vehicle_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE trip_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_checks FORCE ROW LEVEL SECURITY;
ALTER TABLE transport_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_incidents FORCE ROW LEVEL SECURITY;

CREATE POLICY transport_staff_tenant ON transport_staff
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY transport_attendance_tenant ON transport_attendance
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY vehicle_logs_tenant ON vehicle_logs
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY trip_checks_tenant ON trip_checks
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY transport_incidents_tenant ON transport_incidents
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS transport_incidents;
DROP TABLE IF EXISTS trip_checks;
DROP TABLE IF EXISTS vehicle_logs;
DROP TABLE IF EXISTS transport_attendance;
DROP TABLE IF EXISTS transport_staff;
