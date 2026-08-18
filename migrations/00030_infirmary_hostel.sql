-- +goose Up
-- The sick room and the rest of the boarding house.
--
-- Two registers here are the ones a school is asked to produce after something
-- has gone wrong: what was given to a child and on whose authority, and who
-- took a boarder off the premises. Both are modelled so that the awkward
-- question has an answer in a column rather than in somebody's memory.
--
-- Nothing here restates the health master file. student_health already holds a
-- child's allergies, chronic conditions and family doctor, and a second copy of
-- an allergy is not a convenience, it is a way for a nurse to read the stale
-- one. These tables join to it instead.

/* A visit to the sick room.

   One row per attendance, not per child: a boarder who comes down three times
   in a week with the same headache is a pattern, and a single mutable "current
   complaint" would erase it. outcome is recorded rather than inferred because
   "sent home" and "went back to class" are different facts about the same
   temperature reading, and only the school knows which happened. */
CREATE TABLE infirmary_visits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- The school day the visit belongs to, kept as its own column: casting
    -- arrived_at to a date depends on the session timezone, so Postgres will
    -- not index it and "today's visits" would seq-scan the year.
    on_date         date        NOT NULL DEFAULT current_date,
    arrived_at      timestamptz NOT NULL DEFAULT now(),
    complaint       text        NOT NULL,
    -- Vitals as they were taken. Nullable because a scraped knee does not need
    -- a temperature, and a nurse forced to invent one records a worse number
    -- than none at all.
    temperature_c   numeric(4,1),
    pulse_bpm       integer,
    bp              text,
    observations    text,
    treatment       text,
    rested_minutes  integer,
    outcome         text        NOT NULL DEFAULT 'returned_to_class',
    -- Where a child was sent on to, when the sick room was not the end of it.
    referred_to     text,
    -- The family being told is a separate fact from the child being treated. A
    -- parent who first hears of a fever at the school gate is the complaint
    -- this column exists to prevent.
    parent_informed_at timestamptz,
    seen_by         uuid        REFERENCES users(id) ON DELETE SET NULL,
    -- Kept as text as well as a user reference: staff leave, their user row is
    -- deactivated or reassigned, and a clinical record still has to name the
    -- person who saw the child years later.
    seen_by_name    text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT infirmary_visits_outcome CHECK (outcome IN
        ('returned_to_class','rested','sent_home','referred','hospitalised','observed')),
    -- A referral with nowhere named is a child sent out of the gate to nobody.
    CONSTRAINT infirmary_visits_referral_has_destination
        CHECK (outcome NOT IN ('referred','hospitalised')
               OR nullif(btrim(referred_to), '') IS NOT NULL),
    -- A child who left the premises without the family being told is the one
    -- case the register must refuse to record silently.
    CONSTRAINT infirmary_visits_home_needs_parent
        CHECK (outcome NOT IN ('sent_home','hospitalised') OR parent_informed_at IS NOT NULL),
    CONSTRAINT infirmary_visits_temperature
        CHECK (temperature_c IS NULL OR temperature_c BETWEEN 30 AND 45),
    CONSTRAINT infirmary_visits_rest CHECK (rested_minutes IS NULL OR rested_minutes >= 0)
);

-- The nurse's own day, and the two lookups behind it.
CREATE INDEX infirmary_visits_day ON infirmary_visits (institution_id, on_date DESC, arrived_at DESC);
CREATE INDEX infirmary_visits_student ON infirmary_visits (student_id, arrived_at DESC);

/* Medicine given to a child.

   The highest-stakes row in this file, and the reason it is not a "given"
   boolean on the visit. Four separate people can be involved in one dose — the
   doctor or parent who authorised it, the staff member who handed it over, the
   colleague who witnessed a controlled drug, and the child who may have
   refused it — and after a bad reaction the school is asked about each of them
   by name. A flag answers none of those questions.

   The authority and the administration are deliberately different sets of
   columns. A nurse giving paracetamol on a parent's written consent and a
   nurse giving an anticonvulsant on a prescription are the same action with
   completely different accountability behind it, and collapsing them loses the
   only distinction that matters at an inquiry. */
CREATE TABLE medication_administrations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- The sick-room attendance this dose belongs to, when there was one. A
    -- boarder's regular evening dose has no visit behind it, so this is
    -- nullable rather than the register being forced through the visit log.
    visit_id        uuid        REFERENCES infirmary_visits(id) ON DELETE SET NULL,
    medicine        text        NOT NULL,
    dose            text        NOT NULL,
    route           text        NOT NULL DEFAULT 'oral',

    -- --- on whose authority ------------------------------------------------
    authority       text        NOT NULL,
    -- The parent or the doctor, by name. Not a user reference: the person who
    -- authorised a dose is usually not a user of this system at all.
    authorised_by_name text     NOT NULL,
    -- The prescription or consent-form number, and a scan of it. One or the
    -- other is required for a prescription, because "the doctor said so" with
    -- nothing to show is the position a school cannot defend.
    authority_ref   text,
    authority_file_id uuid      REFERENCES files(id) ON DELETE SET NULL,
    authorised_on   date,

    -- --- who actually gave it ----------------------------------------------
    administered_by uuid        REFERENCES users(id) ON DELETE SET NULL,
    -- Text as well, for the same reason as the visit log: the user row can be
    -- deactivated, and a drug chart must still name who held the spoon.
    administered_by_name text   NOT NULL,
    administered_at timestamptz NOT NULL DEFAULT now(),
    -- A second pair of eyes. Standard practice for controlled and injectable
    -- medicines, and worthless unless recorded at the time.
    witnessed_by_name text,
    -- A child may refuse, and a refusal is a clinical event the family must be
    -- told about — not an absence of a record.
    refused         boolean     NOT NULL DEFAULT false,
    adverse_reaction text,
    parent_informed_at timestamptz,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT medication_administrations_route
        CHECK (route IN ('oral','topical','inhaled','drops','injection','other')),
    CONSTRAINT medication_administrations_authority CHECK (authority IN
        ('doctor_prescription','parent_consent','standing_order','emergency')),
    -- A prescription that cannot be produced is not a prescription.
    CONSTRAINT medication_administrations_prescription_has_proof
        CHECK (authority <> 'doctor_prescription'
               OR nullif(btrim(authority_ref), '') IS NOT NULL
               OR authority_file_id IS NOT NULL),
    -- Giving a drug with nobody's permission is defensible exactly once, in an
    -- emergency, and only if somebody writes down why.
    CONSTRAINT medication_administrations_emergency_has_reason
        CHECK (authority <> 'emergency' OR nullif(btrim(notes), '') IS NOT NULL),
    -- Both of these end with a parent being rung. Recording either without it
    -- would let the register close over the one omission that matters.
    CONSTRAINT medication_administrations_reaction_told_parent
        CHECK (nullif(btrim(adverse_reaction), '') IS NULL OR parent_informed_at IS NOT NULL),
    CONSTRAINT medication_administrations_refusal_told_parent
        CHECK (NOT refused OR parent_informed_at IS NOT NULL)
);

-- The drug chart for one child, and the register for one day.
CREATE INDEX medication_administrations_student
    ON medication_administrations (student_id, administered_at DESC);
CREATE INDEX medication_administrations_day
    ON medication_administrations (institution_id, administered_at DESC);
-- Anything that went wrong, pulled out on its own: the list a school reviews.
CREATE INDEX medication_administrations_incidents
    ON medication_administrations (institution_id, administered_at DESC)
 WHERE refused OR adverse_reaction IS NOT NULL;

/* A visiting camp: the state school-health team, a dental van, an eye charity.

   Recorded as its own thing rather than as a batch of checkups because the
   school is answerable for the camp itself — which agency came, on whose
   programme, and what happened to the children it referred onward. RBSK and
   the state school-health programme both audit against that, not against
   individual heights. */
CREATE TABLE health_camps (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    name            text        NOT NULL,
    programme       text        NOT NULL DEFAULT 'school_own',
    -- The visiting team: PHC, hospital, NGO or the school's own doctor.
    agency          text,
    doctor_lead     text,
    on_date         date        NOT NULL,
    ends_on         date,
    venue           text,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT health_camps_programme CHECK (programme IN
        ('rbsk','state_school_health','ngo','dental','eye','immunisation','school_own')),
    CONSTRAINT health_camps_window CHECK (ends_on IS NULL OR ends_on >= on_date)
);

CREATE INDEX health_camps_recent ON health_camps (institution_id, on_date DESC);

/* Who was seen at the camp.

   The follow-up columns are the point. A camp that screens four hundred
   children and refers nine is only worth running if somebody chases the nine,
   and a screening register with no follow-up is how those nine are lost. */
CREATE TABLE health_camp_attendance (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    camp_id         uuid        NOT NULL REFERENCES health_camps(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    findings        text,
    treatment_given text,
    referred        boolean     NOT NULL DEFAULT false,
    referred_to     text,
    follow_up_on    date,
    follow_up_done_at timestamptz,
    follow_up_note  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- A referral with nowhere to go is not a referral.
    CONSTRAINT health_camp_attendance_referral_has_destination
        CHECK (NOT referred OR nullif(btrim(referred_to), '') IS NOT NULL)
);

-- A child is seen once at a camp; a second scan is a correction, not a
-- separate examination. Both columns are NOT NULL, so this index bites.
CREATE UNIQUE INDEX health_camp_attendance_once
    ON health_camp_attendance (camp_id, student_id);

-- The nine children somebody has to chase.
CREATE INDEX health_camp_attendance_open_referrals
    ON health_camp_attendance (institution_id, follow_up_on)
 WHERE referred AND follow_up_done_at IS NULL;

/* The annual checkup: height, weight, vision, dental, one row per child per
   year.

   academic_year_id is a NOT NULL reference rather than a nullable one, and
   that is load-bearing. A nullable column inside the uniqueness key would make
   Postgres treat every unrecorded year as distinct, so the same child could be
   measured four times in one year and the index would say nothing. The year is
   resolved from the child's own enrolment when a checkup is filed.

   bmi is generated rather than sent by the client: a screen that computes it
   and a report that recomputes it are two chances to disagree about whether a
   child is underweight, and the national school-health programme grades on
   exactly that number. */
CREATE TABLE health_checkups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    academic_year_id uuid       NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    -- The camp it came out of, when it came out of one. Nullable on purpose:
    -- most schools weigh their own children, and it is deliberately not part
    -- of the uniqueness key below.
    camp_id         uuid        REFERENCES health_camps(id) ON DELETE SET NULL,
    on_date         date        NOT NULL DEFAULT current_date,
    height_cm       numeric(5,1),
    weight_kg       numeric(5,1),
    bmi             numeric(5,2) GENERATED ALWAYS AS (
        CASE WHEN height_cm > 0 AND weight_kg > 0
             THEN round(weight_kg / ((height_cm / 100) * (height_cm / 100)), 2)
        END
    ) STORED,
    -- Snellen, as the chart is actually read: 6/6, 6/9, 6/12. Text rather than
    -- a number because 6/60 and "counts fingers" are both real results.
    vision_left     text,
    vision_right    text,
    wears_spectacles boolean    NOT NULL DEFAULT false,
    hearing         text,
    dental          text,
    dental_notes    text,
    -- Haemoglobin, in g/dL. Screened in every state school-health round
    -- because anaemia is the commonest finding in an Indian classroom.
    haemoglobin_gdl numeric(4,1),
    immunisation_upto_date boolean,
    -- What the doctor said to do about it, and whether anyone did.
    referred_to     text,
    remarks         text,
    examined_by     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT health_checkups_height CHECK (height_cm IS NULL OR height_cm BETWEEN 30 AND 250),
    CONSTRAINT health_checkups_weight CHECK (weight_kg IS NULL OR weight_kg BETWEEN 2 AND 250),
    CONSTRAINT health_checkups_haemoglobin
        CHECK (haemoglobin_gdl IS NULL OR haemoglobin_gdl BETWEEN 2 AND 25),
    CONSTRAINT health_checkups_dental
        CHECK (dental IS NULL OR dental IN ('normal','caries','gum_disease','malocclusion','referred'))
);

CREATE UNIQUE INDEX health_checkups_one_per_year
    ON health_checkups (institution_id, student_id, academic_year_id);

CREATE INDEX health_checkups_year ON health_checkups (institution_id, academic_year_id, on_date DESC);

/* Night study roll call.

   Separate from both the school register and the hostel's morning roll call:
   the question is whether a boarder was in the study hall between seven and
   nine, and a child can be present in the building and absent from prep. That
   distinction is the only reason a warden takes this register at all. */
CREATE TABLE night_study_attendance (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    on_date         date        NOT NULL DEFAULT current_date,
    -- Most hostels run two sittings. NOT NULL with a default so it can sit in
    -- the uniqueness key without the nullable trap disabling it.
    session         text        NOT NULL DEFAULT 'night',
    hall            text,
    status          text        NOT NULL DEFAULT 'present',
    minutes_late    integer,
    remarks         text,
    marked_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    marked_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT night_study_attendance_session CHECK (session IN ('evening','night')),
    CONSTRAINT night_study_attendance_status
        CHECK (status IN ('present','absent','late','excused','sick_bay','on_outpass')),
    -- An excusal nobody has to justify is how prep quietly becomes optional.
    CONSTRAINT night_study_attendance_excusal_has_reason
        CHECK (status <> 'excused' OR nullif(btrim(remarks), '') IS NOT NULL),
    CONSTRAINT night_study_attendance_late CHECK (minutes_late IS NULL OR minutes_late >= 0)
);

CREATE UNIQUE INDEX night_study_attendance_once
    ON night_study_attendance (institution_id, student_id, on_date, session);

-- Who was not in prep, for the warden's evening.
CREATE INDEX night_study_attendance_missing
    ON night_study_attendance (institution_id, on_date)
 WHERE status IN ('absent','late');

/* The room handover.

   A boarder is shown a room with four chairs and two fans at check-in and
   billed for what is missing at check-out, so the two inspections have to be
   the same shape and the same list. One table with a kind, not two tables that
   will drift. */
CREATE TABLE room_inventory_checks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    room_id         uuid        NOT NULL REFERENCES hostel_rooms(id) ON DELETE CASCADE,
    -- Nullable on purpose: a warden also walks empty rooms between terms, and
    -- forcing a child onto that inspection would mean blaming one.
    student_id      uuid        REFERENCES students(id) ON DELETE SET NULL,
    kind            text        NOT NULL,
    on_date         date        NOT NULL DEFAULT current_date,
    checked_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    -- Whether the boarder agreed the list. A recovery raised against a child
    -- who never saw the check-in sheet is the argument this column settles.
    boarder_signed  boolean     NOT NULL DEFAULT false,
    remarks         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT room_inventory_checks_kind CHECK (kind IN ('check_in','check_out','routine'))
);

/* One inspection per room, per boarder, per kind, per day.

   COALESCE, not a bare student_id: the room-only walks leave that column null,
   and a nullable column inside a unique index makes Postgres treat every null
   as distinct — the index would exist, be reported by \d, and silently permit
   the duplicates it was added to stop. The zero uuid stands in for "no
   boarder" so those rows collide with each other properly. */
CREATE UNIQUE INDEX room_inventory_checks_once
    ON room_inventory_checks (institution_id, room_id,
        COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, on_date);

CREATE INDEX room_inventory_checks_room ON room_inventory_checks (room_id, on_date DESC);

/* A line on the checklist: one item of furniture or fitting.

   The charge is per line rather than a total on the check, because a family
   disputing a bill disputes one broken chair, and a single figure gives them
   nothing to dispute and the school nothing to justify. */
CREATE TABLE room_inventory_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    check_id        uuid        NOT NULL REFERENCES room_inventory_checks(id) ON DELETE CASCADE,
    item            text        NOT NULL,
    expected        integer     NOT NULL DEFAULT 1,
    found           integer     NOT NULL DEFAULT 0,
    condition       text        NOT NULL DEFAULT 'good',
    damage_note     text,
    charge_paise    bigint      NOT NULL DEFAULT 0,
    CONSTRAINT room_inventory_items_condition
        CHECK (condition IN ('good','worn','damaged','missing')),
    CONSTRAINT room_inventory_items_counts
        CHECK (expected >= 0 AND found >= 0 AND found <= expected),
    CONSTRAINT room_inventory_items_charge CHECK (charge_paise >= 0),
    -- A family cannot be billed without being told what for.
    CONSTRAINT room_inventory_items_charge_has_reason
        CHECK (charge_paise = 0 OR nullif(btrim(damage_note), '') IS NOT NULL)
);

-- The same chair listed twice is a checklist nobody can total.
CREATE UNIQUE INDEX room_inventory_items_once ON room_inventory_items (check_id, lower(item));

/* A relative visiting a boarder.

   This deliberately does not open a second register of people on the premises.
   A warden signing in a boarder's uncle at six in the evening is the same
   physical event as the front desk signing in a supplier at eleven in the
   morning, and the school needs one answer to "who is inside" and one
   blocklist — the blocklist being there for custody orders, which is to say
   for exactly this visitor and exactly this child. Two registers would mean a
   barred relative refused at the gate and admitted at the hostel.

   So the gate pass stays in visitors, and this table carries only the facts
   the front desk has no column for: which boarder, the claimed relationship,
   the warden who allowed it, and whether the child physically left with the
   visitor. That last one is the difference between a visit and a collection,
   and it is the one a school gets wrong. */
CREATE TABLE hostel_visits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- One hostel visit per gate pass. Both columns NOT NULL, so the constraint
    -- is real rather than decorative.
    visitor_id      uuid        NOT NULL UNIQUE REFERENCES visitors(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    relationship    text        NOT NULL,
    -- The warden's permission, which a front-desk pass does not record.
    permitted_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
    met_in          text,
    -- The boarder went out with them, rather than sitting in the parlour.
    boarder_released boolean    NOT NULL DEFAULT false,
    expected_back   timestamptz,
    returned_at     timestamptz,
    remarks         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Letting a child off the premises with no hour named is how a boarder is
    -- discovered missing at lights-out rather than at the hour they were due.
    CONSTRAINT hostel_visits_release_has_return_time
        CHECK (NOT boarder_released OR expected_back IS NOT NULL),
    CONSTRAINT hostel_visits_returned_after_expected
        CHECK (returned_at IS NULL OR boarder_released)
);

-- Which boarders are currently off the premises with a relative.
CREATE INDEX hostel_visits_out ON hostel_visits (institution_id, expected_back)
 WHERE boarder_released AND returned_at IS NULL;

CREATE INDEX hostel_visits_student ON hostel_visits (student_id, created_at DESC);

/* Laundry.

   Petty until a boarder's blazer goes missing the week before a board exam,
   at which point the school is asked for the token number. Counted out and
   counted back in, because "sent" and "returned" without item counts cannot
   settle the only argument this register ever has. */
CREATE TABLE hostel_laundry (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- The token handed to the boarder. Human-sized and reused each week, which
    -- is why the date is part of the key below.
    token_no        text        NOT NULL,
    vendor          text,
    sent_on         date        NOT NULL DEFAULT current_date,
    due_on          date,
    items_sent      integer     NOT NULL,
    item_detail     text,
    returned_on     date,
    items_returned  integer,
    status          text        NOT NULL DEFAULT 'sent',
    -- Charged to the family, in paise like every other amount in this system.
    charge_paise    bigint      NOT NULL DEFAULT 0,
    damage_note     text,
    recorded_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hostel_laundry_status
        CHECK (status IN ('sent','returned','short','lost')),
    CONSTRAINT hostel_laundry_counts
        CHECK (items_sent > 0 AND (items_returned IS NULL
               OR (items_returned >= 0 AND items_returned <= items_sent))),
    CONSTRAINT hostel_laundry_window CHECK (returned_on IS NULL OR returned_on >= sent_on),
    CONSTRAINT hostel_laundry_charge CHECK (charge_paise >= 0),
    -- A bundle marked back with no date and no count is a claim nobody can
    -- check against the boarder standing there with three shirts.
    CONSTRAINT hostel_laundry_closed_is_counted
        CHECK (status IN ('sent','lost')
               OR (returned_on IS NOT NULL AND items_returned IS NOT NULL)),
    CONSTRAINT hostel_laundry_loss_has_note
        CHECK (status NOT IN ('short','lost') OR nullif(btrim(damage_note), '') IS NOT NULL)
);

-- One live token per number per day; the number is reused next week.
CREATE UNIQUE INDEX hostel_laundry_token_per_day
    ON hostel_laundry (institution_id, token_no, sent_on);

-- What has gone out and not come back.
CREATE INDEX hostel_laundry_outstanding ON hostel_laundry (institution_id, sent_on DESC)
 WHERE status = 'sent';

ALTER TABLE infirmary_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE infirmary_visits FORCE ROW LEVEL SECURITY;
ALTER TABLE medication_administrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_administrations FORCE ROW LEVEL SECURITY;
ALTER TABLE health_camps ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_camps FORCE ROW LEVEL SECURITY;
ALTER TABLE health_camp_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_camp_attendance FORCE ROW LEVEL SECURITY;
ALTER TABLE health_checkups ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_checkups FORCE ROW LEVEL SECURITY;
ALTER TABLE night_study_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE night_study_attendance FORCE ROW LEVEL SECURITY;
ALTER TABLE room_inventory_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_inventory_checks FORCE ROW LEVEL SECURITY;
ALTER TABLE room_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_inventory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE hostel_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE hostel_visits FORCE ROW LEVEL SECURITY;
ALTER TABLE hostel_laundry ENABLE ROW LEVEL SECURITY;
ALTER TABLE hostel_laundry FORCE ROW LEVEL SECURITY;

CREATE POLICY infirmary_visits_tenant ON infirmary_visits
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY medication_administrations_tenant ON medication_administrations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY health_camps_tenant ON health_camps
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY health_camp_attendance_tenant ON health_camp_attendance
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY health_checkups_tenant ON health_checkups
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY night_study_attendance_tenant ON night_study_attendance
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY room_inventory_checks_tenant ON room_inventory_checks
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY room_inventory_items_tenant ON room_inventory_items
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY hostel_visits_tenant ON hostel_visits
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY hostel_laundry_tenant ON hostel_laundry
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS hostel_laundry;
DROP TABLE IF EXISTS hostel_visits;
DROP TABLE IF EXISTS room_inventory_items;
DROP TABLE IF EXISTS room_inventory_checks;
DROP TABLE IF EXISTS night_study_attendance;
DROP TABLE IF EXISTS health_checkups;
DROP TABLE IF EXISTS health_camp_attendance;
DROP TABLE IF EXISTS health_camps;
DROP TABLE IF EXISTS medication_administrations;
DROP TABLE IF EXISTS infirmary_visits;
