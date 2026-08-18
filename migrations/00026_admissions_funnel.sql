-- +goose Up
-- The admissions funnel: where a lead came from, who is chasing it, and the
-- quotas and papers that decide who gets a seat.
--
-- The product could record an enquiry and an application and move one to the
-- other. What it could not answer is anything the admissions head is measured
-- on: which newspaper advertisement worked, which counsellor is sitting on
-- forty untouched leads, who is next on the waiting list, and whether the RTE
-- register would survive an inspection.

-- --- where a lead came from ------------------------------------------------

-- enquiries already carries source and campaign as free text. UTM parameters
-- are what a web form actually receives, and keeping them separate from the
-- human-entered source is what lets "Walk-in" and "google/cpc/august-fees"
-- coexist without one overwriting the other.
ALTER TABLE enquiries
    ADD COLUMN IF NOT EXISTS utm_source   text,
    ADD COLUMN IF NOT EXISTS utm_medium   text,
    ADD COLUMN IF NOT EXISTS utm_campaign text,
    ADD COLUMN IF NOT EXISTS referred_by  text,
    -- When the counsellor was given it, so "untouched for nine days" is a
    -- question the screen can answer rather than a feeling.
    ADD COLUMN IF NOT EXISTS assigned_at  timestamptz,
    ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz;

CREATE INDEX IF NOT EXISTS enquiries_assigned
    ON enquiries (institution_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS enquiries_source
    ON enquiries (institution_id, source);

-- --- what an application has to carry --------------------------------------

/* Statutory identity, quota and medical facts, on the application rather than
   only on the student.

   A school collects all of this before the child is a student, and losing it
   at conversion is how a UDISE+ return ends up with blanks that nobody can
   fill in six months later. */
ALTER TABLE applications
    -- Aadhaar consent is a DPDP obligation and must be recorded as a decision,
    -- not inferred from the presence of a number.
    ADD COLUMN IF NOT EXISTS aadhaar_consent    boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS aadhaar_last4      text,
    ADD COLUMN IF NOT EXISTS apaar_id           text,
    ADD COLUMN IF NOT EXISTS prior_udise_code   text,
    -- The quota a seat would be given under. Separate from category, which is
    -- the child's social category: an EWS child may be admitted on merit, and
    -- conflating the two is how quota counts stop reconciling.
    ADD COLUMN IF NOT EXISTS quota              text NOT NULL DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS sibling_student_id uuid REFERENCES students(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS alumni_parent_name text,
    -- Where they sit on the waiting list for their class. Null unless they are
    -- actually waitlisted; the rank is assigned, not derived from the order
    -- they applied in, because a school may promote on merit.
    ADD COLUMN IF NOT EXISTS waitlist_rank      integer,
    -- Medical fitness, collected on the form and needed on day one by the
    -- infirmary. Free text because "asthmatic, carries an inhaler" is not a
    -- checkbox and a checkbox version gets ignored.
    ADD COLUMN IF NOT EXISTS medical_conditions text,
    ADD COLUMN IF NOT EXISTS allergies          text,
    ADD COLUMN IF NOT EXISTS immunisation_upto  text,
    ADD COLUMN IF NOT EXISTS blood_group        text,
    -- Foreign and NRI applicants. A school taking one of these without the
    -- visa expiry on file discovers the problem at the next inspection.
    ADD COLUMN IF NOT EXISTS nationality        text NOT NULL DEFAULT 'Indian',
    ADD COLUMN IF NOT EXISTS passport_no        text,
    ADD COLUMN IF NOT EXISTS visa_type          text,
    ADD COLUMN IF NOT EXISTS visa_expiry        date,
    -- What was paid to apply, and against which receipt.
    ADD COLUMN IF NOT EXISTS form_fee_paise     bigint,
    ADD COLUMN IF NOT EXISTS form_fee_receipt   text;

ALTER TABLE applications
    ADD CONSTRAINT applications_quota
        CHECK (quota IN ('general','rte','ews','sibling','alumni','staff','sports','management')),
    -- A foreign applicant with no passport recorded is the gap; one recorded
    -- with no expiry is the gap that hides itself.
    ADD CONSTRAINT applications_visa_dated
        CHECK (passport_no IS NULL OR visa_expiry IS NOT NULL OR nationality = 'Indian');

-- One rank per class per session. Two children ranked third is not a waiting
-- list, it is an argument.
CREATE UNIQUE INDEX applications_waitlist_rank
    ON applications (admission_session_id, class_sought, waitlist_rank)
 WHERE waitlist_rank IS NOT NULL AND status = 'waitlisted';

CREATE INDEX applications_quota_idx ON applications (institution_id, quota, status);

-- --- open days -------------------------------------------------------------

/* An open house, and the slots families book into.

   Capacity lives on the slot rather than the event because the whole point is
   to spread two hundred families across a Saturday morning rather than have
   them all arrive at ten. */
CREATE TABLE admission_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE SET NULL,
    name            text        NOT NULL,
    on_date         date        NOT NULL,
    venue           text,
    description     text,
    is_published    boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admission_event_slots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    event_id        uuid        NOT NULL REFERENCES admission_events(id) ON DELETE CASCADE,
    starts_at       time        NOT NULL,
    minutes         integer     NOT NULL DEFAULT 45,
    capacity        integer     NOT NULL DEFAULT 25,
    CONSTRAINT admission_event_slots_capacity CHECK (capacity > 0)
);

CREATE UNIQUE INDEX admission_event_slots_time ON admission_event_slots (event_id, starts_at);

CREATE TABLE admission_event_bookings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    slot_id         uuid        NOT NULL REFERENCES admission_event_slots(id) ON DELETE CASCADE,
    enquiry_id      uuid        REFERENCES enquiries(id) ON DELETE SET NULL,
    parent_name     text        NOT NULL,
    phone           text        NOT NULL,
    children        integer     NOT NULL DEFAULT 1,
    -- Booked and turned up are different facts, and the ratio between them is
    -- the only honest measure of whether an open day worked.
    attended_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT admission_event_bookings_children CHECK (children BETWEEN 1 AND 10)
);

-- One booking per phone number per slot; families ring twice.
CREATE UNIQUE INDEX admission_event_bookings_once
    ON admission_event_bookings (slot_id, phone);

CREATE INDEX admission_event_bookings_slot ON admission_event_bookings (slot_id);

-- --- prospectus sales ------------------------------------------------------

/* Prospectus and admission kits sold over the counter.

   A tiny cash book that schools genuinely keep, because the prospectus is
   often the first money a family pays and the count has to reconcile against
   the stack of printed copies in the cupboard. */
CREATE TABLE prospectus_sales (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE SET NULL,
    receipt_no      text        NOT NULL,
    on_date         date        NOT NULL DEFAULT current_date,
    buyer_name      text        NOT NULL,
    phone           text,
    class_sought    uuid        REFERENCES classes(id) ON DELETE SET NULL,
    enquiry_id      uuid        REFERENCES enquiries(id) ON DELETE SET NULL,
    kind            text        NOT NULL DEFAULT 'prospectus',
    quantity        integer     NOT NULL DEFAULT 1,
    amount_paise    bigint      NOT NULL,
    mode            text        NOT NULL DEFAULT 'cash',
    sold_by         uuid        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT prospectus_sales_kind CHECK (kind IN ('prospectus','application_form','kit')),
    CONSTRAINT prospectus_sales_mode CHECK (mode IN ('cash','card','upi','online','waived')),
    CONSTRAINT prospectus_sales_quantity CHECK (quantity > 0)
);

CREATE UNIQUE INDEX prospectus_sales_receipt
    ON prospectus_sales (institution_id, receipt_no);

CREATE INDEX prospectus_sales_day ON prospectus_sales (institution_id, on_date DESC);

/* How many copies the school started with, so sold can be measured against
   stock rather than against nothing. One row per print run. */
CREATE TABLE prospectus_stock (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    kind            text        NOT NULL DEFAULT 'prospectus',
    received_on     date        NOT NULL DEFAULT current_date,
    quantity        integer     NOT NULL,
    unit_cost_paise bigint,
    notes           text,
    CONSTRAINT prospectus_stock_kind CHECK (kind IN ('prospectus','application_form','kit')),
    CONSTRAINT prospectus_stock_quantity CHECK (quantity > 0)
);

ALTER TABLE admission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_events FORCE ROW LEVEL SECURITY;
ALTER TABLE admission_event_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_event_slots FORCE ROW LEVEL SECURITY;
ALTER TABLE admission_event_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_event_bookings FORCE ROW LEVEL SECURITY;
ALTER TABLE prospectus_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospectus_sales FORCE ROW LEVEL SECURITY;
ALTER TABLE prospectus_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospectus_stock FORCE ROW LEVEL SECURITY;

CREATE POLICY admission_events_tenant ON admission_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY admission_event_slots_tenant ON admission_event_slots
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY admission_event_bookings_tenant ON admission_event_bookings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY prospectus_sales_tenant ON prospectus_sales
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY prospectus_stock_tenant ON prospectus_stock
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS prospectus_stock;
DROP TABLE IF EXISTS prospectus_sales;
DROP TABLE IF EXISTS admission_event_bookings;
DROP TABLE IF EXISTS admission_event_slots;
DROP TABLE IF EXISTS admission_events;
DROP INDEX IF EXISTS applications_quota_idx;
DROP INDEX IF EXISTS applications_waitlist_rank;
ALTER TABLE applications
    DROP CONSTRAINT IF EXISTS applications_visa_dated,
    DROP CONSTRAINT IF EXISTS applications_quota;
ALTER TABLE applications
    DROP COLUMN IF EXISTS form_fee_receipt, DROP COLUMN IF EXISTS form_fee_paise,
    DROP COLUMN IF EXISTS visa_expiry, DROP COLUMN IF EXISTS visa_type,
    DROP COLUMN IF EXISTS passport_no, DROP COLUMN IF EXISTS nationality,
    DROP COLUMN IF EXISTS blood_group, DROP COLUMN IF EXISTS immunisation_upto,
    DROP COLUMN IF EXISTS allergies, DROP COLUMN IF EXISTS medical_conditions,
    DROP COLUMN IF EXISTS waitlist_rank, DROP COLUMN IF EXISTS alumni_parent_name,
    DROP COLUMN IF EXISTS sibling_student_id, DROP COLUMN IF EXISTS quota,
    DROP COLUMN IF EXISTS prior_udise_code, DROP COLUMN IF EXISTS apaar_id,
    DROP COLUMN IF EXISTS aadhaar_last4, DROP COLUMN IF EXISTS aadhaar_consent;
ALTER TABLE enquiries
    DROP COLUMN IF EXISTS last_contacted_at, DROP COLUMN IF EXISTS assigned_at,
    DROP COLUMN IF EXISTS referred_by, DROP COLUMN IF EXISTS utm_campaign,
    DROP COLUMN IF EXISTS utm_medium, DROP COLUMN IF EXISTS utm_source;
