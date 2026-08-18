-- +goose Up
-- The front desk: who came in, who rang, what arrived in the post.
--
-- Every one of these is a paper register in most Indian schools, and every one
-- of them is asked for after something goes wrong: who signed that man in, who
-- took the call about the fee, where the board's envelope went.

/* A visitor on the premises.

   in_at and out_at rather than a status, because the question the gate is
   asked at closing time is "who is still inside", and that is a null out_at.
   A status column would answer it only if somebody remembered to change it. */
CREATE TABLE visitors (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE SET NULL,
    -- The pass number handed over at the desk. Human-sized and reused each
    -- day, unlike the uuid, because a visitor has to read it back.
    pass_no         text        NOT NULL,
    full_name       text        NOT NULL,
    phone           text,
    id_type         text,
    id_last4        text,
    photo_file_id   uuid        REFERENCES files(id) ON DELETE SET NULL,
    purpose         text        NOT NULL,
    -- Who they came to see. Either a staff member or a child's family, and
    -- naming the child is what makes an unauthorised pickup visible.
    host_employee_id uuid       REFERENCES employees(id) ON DELETE SET NULL,
    student_id      uuid        REFERENCES students(id) ON DELETE SET NULL,
    vehicle_no      text,
    -- The school day the pass belongs to, as its own column: casting in_at to
    -- a date depends on the session timezone, so Postgres will not index it.
    on_date         date        NOT NULL DEFAULT current_date,
    in_at           timestamptz NOT NULL DEFAULT now(),
    out_at          timestamptz,
    issued_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    closed_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    remarks         text,
    CONSTRAINT visitors_out_after_in CHECK (out_at IS NULL OR out_at >= in_at)
);

-- One live pass per number per day; a number is reused tomorrow.
CREATE UNIQUE INDEX visitors_pass_per_day
    ON visitors (institution_id, pass_no, on_date);

-- The four o'clock question: who has not signed out.
CREATE INDEX visitors_inside ON visitors (institution_id, in_at)
 WHERE out_at IS NULL;

/* People who must not be let in.

   Deliberately a tiny table with a reason and who decided. A blacklist without
   either is a list nobody will defend when the person turns up with a lawyer,
   and schools do get this wrong — usually in a custody dispute, which is
   exactly when it matters most. */
CREATE TABLE visitor_blocklist (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    full_name       text        NOT NULL,
    phone           text,
    id_last4        text,
    reason          text        NOT NULL,
    -- Court orders expire and are varied; a block with no end date outlives
    -- the order it came from.
    effective_from  date        NOT NULL DEFAULT current_date,
    effective_to    date,
    added_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT visitor_blocklist_window
        CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX visitor_blocklist_name ON visitor_blocklist (institution_id, lower(full_name));

/* A booked meeting between a family and the school.

   The point of booking is to stop parents queueing outside the principal's
   door, so a slot is held against a person and a time, and double-booking one
   person at one time is refused rather than merely discouraged. */
CREATE TABLE appointments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    with_employee_id uuid       REFERENCES employees(id) ON DELETE SET NULL,
    student_id      uuid        REFERENCES students(id) ON DELETE SET NULL,
    requested_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
    visitor_name    text        NOT NULL,
    phone           text,
    on_date         date        NOT NULL,
    starts_at       time        NOT NULL,
    minutes         integer     NOT NULL DEFAULT 15,
    purpose         text        NOT NULL,
    status          text        NOT NULL DEFAULT 'booked',
    outcome         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT appointments_status
        CHECK (status IN ('booked','met','no_show','cancelled')),
    CONSTRAINT appointments_minutes CHECK (minutes BETWEEN 5 AND 240),
    -- A meeting recorded as held with nothing said is not a record of a
    -- meeting; it is a record that somebody clicked a button.
    CONSTRAINT appointments_met_has_outcome
        CHECK (status <> 'met' OR nullif(btrim(outcome), '') IS NOT NULL)
);

-- One staff member cannot be in two meetings at once.
CREATE UNIQUE INDEX appointments_no_double_booking
    ON appointments (with_employee_id, on_date, starts_at)
 WHERE status = 'booked' AND with_employee_id IS NOT NULL;

CREATE INDEX appointments_day ON appointments (institution_id, on_date, starts_at);

/* The telephone register.

   Kept because the commonest complaint a school receives is "I rang and told
   somebody" — and without this the school has no way to agree or disagree. */
CREATE TABLE call_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    direction       text        NOT NULL DEFAULT 'in',
    caller_name     text        NOT NULL,
    phone           text,
    student_id      uuid        REFERENCES students(id) ON DELETE SET NULL,
    about           text        NOT NULL,
    -- Who the message is for, and whether it reached them. A message taken and
    -- never passed on is the failure this register exists to expose.
    for_employee_id uuid        REFERENCES employees(id) ON DELETE SET NULL,
    passed_on_at    timestamptz,
    action_taken    text,
    taken_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    at_time         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT call_log_direction CHECK (direction IN ('in','out'))
);

CREATE INDEX call_log_day ON call_log (institution_id, at_time DESC);
CREATE INDEX call_log_pending ON call_log (institution_id, for_employee_id)
 WHERE passed_on_at IS NULL AND for_employee_id IS NOT NULL;

/* Inward and outward post.

   Schools lose board correspondence, and the loss is only ever discovered
   later, so the register records who physically took it and when. */
CREATE TABLE courier_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    direction       text        NOT NULL DEFAULT 'in',
    on_date         date        NOT NULL DEFAULT current_date,
    courier         text,
    tracking_no     text,
    from_party      text,
    to_party        text,
    description     text        NOT NULL,
    -- Signed for by, and when. The two facts a lost envelope turns on.
    received_by     text,
    handed_over_at  timestamptz,
    charges_paise   bigint,
    recorded_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT courier_log_direction CHECK (direction IN ('in','out'))
);

CREATE INDEX courier_log_day ON courier_log (institution_id, on_date DESC);
CREATE INDEX courier_log_undelivered ON courier_log (institution_id, on_date)
 WHERE direction = 'in' AND handed_over_at IS NULL;

ALTER TABLE visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitors FORCE ROW LEVEL SECURITY;
ALTER TABLE visitor_blocklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitor_blocklist FORCE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
ALTER TABLE call_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_log FORCE ROW LEVEL SECURITY;
ALTER TABLE courier_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_log FORCE ROW LEVEL SECURITY;

CREATE POLICY visitors_tenant ON visitors
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY visitor_blocklist_tenant ON visitor_blocklist
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY appointments_tenant ON appointments
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY call_log_tenant ON call_log
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY courier_log_tenant ON courier_log
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS courier_log;
DROP TABLE IF EXISTS call_log;
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS visitor_blocklist;
DROP TABLE IF EXISTS visitors;
