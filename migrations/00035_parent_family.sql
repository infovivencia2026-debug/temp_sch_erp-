-- +goose Up
-- What a family sees of school life, and the four facts nothing already holds.
--
-- The rule applied throughout the parent portal is that a table is only added
-- when the fact it carries exists nowhere else. Most of school life is already
-- modelled and is reused here rather than copied:
--
--   holidays          the calendar, including kind='ptm' and kind='event'
--   exams             the examination dates a calendar has to show
--   terms             the shape of the year
--   appointments      the front desk's diary — and, from now on, PTM bookings
--   ptm_notes         what was said at a meeting once it has happened
--   student_support_plans  the accommodations agreed for a child who needs them
--   files             every byte the school stores
--   students          the child, their photo, their class
--   notifications     a per-user alert with a read mark
--
-- Deliberately NOT added:
--
--   a PTM booking table. A booked meeting is an appointment, and appointments
--   already carries with_employee_id, student_id, on_date, starts_at and a
--   status. A second table would give the school two diaries that disagree on
--   the morning of the meeting — the failure this whole design exists to avoid.
--   Only the offer of a slot was missing, so only that is added below.
--
--   a parent alerts table. notifications already has user_id, student_id, kind,
--   title, body, link and read_at. What it lacked was a way to say "this row is
--   about that invoice", without which a delivery loop re-inserts the same
--   alert on every poll. Two columns fix that; a parallel table would not.

/* The offer of a parent-teacher meeting.

   A slot is the school saying "this teacher is free at this time". It is not a
   booking and never becomes one: booking writes an appointments row, and the
   slot's availability is then derived by counting appointments against it. The
   alternative — a taken/booked flag on the slot — is a second copy of a fact
   the diary already holds, and the copy is the one left stale when the front
   desk cancels a meeting from its own screen.

   One family at a time, by construction. appointments already carries a
   partial unique index on (with_employee_id, on_date, starts_at) for live
   bookings, so a slot cannot be taken twice however many callers race for it.
   That index is the concurrency control here; there is no capacity column
   because a capacity above one would silently disable it. */
CREATE TABLE ptm_slots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE CASCADE,
    -- The teacher the family will sit with. Not nullable: a slot with nobody
    -- behind it is an appointment the parent turns up for and finds empty, and
    -- appointments.with_employee_id is what the no-double-booking index keys
    -- on, so a null here would also void that guarantee.
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- Which class this sitting is for. Null means the teacher is open to any
    -- family, which is how a head of department or a counsellor publishes time.
    section_id      uuid        REFERENCES sections(id) ON DELETE CASCADE,
    term_id         uuid        REFERENCES terms(id) ON DELETE SET NULL,
    on_date         date        NOT NULL,
    starts_at       time        NOT NULL,
    minutes         integer     NOT NULL DEFAULT 10,
    mode            text        NOT NULL DEFAULT 'in_person',
    -- Where to go, or the joining instruction for a video sitting. Free text
    -- because "Block B staff room, first floor" is not a foreign key.
    location        text,
    -- Withdrawing an offer the school can no longer keep. Separate from
    -- deleting the row, because a slot that was once bookable and is now not
    -- is the explanation a parent is owed when their screen changes.
    is_open         boolean     NOT NULL DEFAULT true,
    notes           text,
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ptm_slots_mode CHECK (mode IN ('in_person', 'phone', 'video')),
    CONSTRAINT ptm_slots_minutes CHECK (minutes BETWEEN 5 AND 120)
);

-- A teacher offered at one time, once. Publishing the same slot twice puts two
-- rows on the parent's screen, and booking either one makes the other
-- unbookable through an index error the family cannot read.
CREATE UNIQUE INDEX ptm_slots_one_per_time
    ON ptm_slots (institution_id, employee_id, on_date, starts_at);

CREATE INDEX ptm_slots_open_day
    ON ptm_slots (institution_id, on_date, starts_at) WHERE is_open;

/* A thing that happens at the school: sports day, annual day, a concert.

   holidays already carries kind='event' and is what the calendar reads, but a
   holiday is a date with a name. An event has a venue, photographs afterwards
   and — for the ones held in a hall — numbered seats, none of which belong on a
   row whose job is to say the school is shut. The calendar shows both.

   section_id null means the whole school. It is deliberately a column rather
   than a join table: an event is announced to everyone or to one class, and
   the two-class case has never once been asked for by a school. */
CREATE TABLE school_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE CASCADE,
    section_id      uuid        REFERENCES sections(id) ON DELETE CASCADE,
    name            text        NOT NULL,
    kind            text        NOT NULL DEFAULT 'event',
    on_date         date        NOT NULL,
    ends_on         date,
    starts_at       time,
    venue           text,
    description     text,
    -- Whether families see it at all. A draft event with the photographs half
    -- uploaded is the commonest reason a school wants this, and without it the
    -- only way to prepare one is to keep it out of the system until the day.
    is_published    boolean     NOT NULL DEFAULT false,
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT school_events_kind CHECK (kind IN (
        'event', 'sports_day', 'annual_day', 'concert', 'exhibition',
        'competition', 'field_trip', 'assembly', 'fete')),
    CONSTRAINT school_events_span CHECK (ends_on IS NULL OR ends_on >= on_date),
    CONSTRAINT school_events_name CHECK (nullif(btrim(name), '') IS NOT NULL)
);

CREATE INDEX school_events_calendar
    ON school_events (institution_id, on_date DESC) WHERE is_published;

/* A photograph or a video from an event.

   The bytes live in files, like every other object the school stores, and are
   referenced rather than duplicated — a gallery with its own upload path would
   be the one place in the product where a file is not in the file table, and
   the retention job would miss it.

   published_at is separate from the event's is_published because a school
   uploads three hundred photographs and then removes the four with somebody
   else's child in frame. Withdrawing one picture must not withdraw the album. */
CREATE TABLE event_media (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    event_id        uuid        NOT NULL REFERENCES school_events(id) ON DELETE CASCADE,
    file_id         uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    media_kind      text        NOT NULL DEFAULT 'photo',
    caption         text,
    sort_order      integer     NOT NULL DEFAULT 0,
    published_at    timestamptz,
    uploaded_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT event_media_kind CHECK (media_kind IN ('photo', 'video'))
);

-- The same file attached to the same album twice is the album showing a
-- duplicate, which is what a double-tapped upload produces.
CREATE UNIQUE INDEX event_media_one_per_file
    ON event_media (event_id, file_id);

CREATE INDEX event_media_album
    ON event_media (institution_id, event_id, sort_order, created_at);

/* The family's seats at an event held in a hall.

   Schools allocate rows to classes and then a family turns up with four people
   for two chairs. The pass is the school's answer in advance: this many seats,
   in this row, from this number.

   code is what is presented at the door, and it is unique for the life of the
   institution rather than per event — a code that once admitted somebody must
   never be reissued, because the second holder's entry is indistinguishable
   from the first's in the log. Same reasoning as the pickup code in 00032.

   Verification is a staff act. There is no column a parent can set to mark
   their own pass as used, for the same reason they cannot release their own
   child: the record of somebody having walked in belongs to whoever let them. */
CREATE TABLE event_seat_passes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    event_id        uuid        NOT NULL REFERENCES school_events(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- 'C' in "row C, seats 12-13". Text because halls label rows with letters.
    row_label       text,
    seat_from       integer,
    seats           integer     NOT NULL DEFAULT 2,
    code            text        NOT NULL,
    note            text,
    issued_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    admitted_at     timestamptz,
    admitted_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    revoked_at      timestamptz,
    CONSTRAINT event_seat_passes_code_format CHECK (code ~ '^[0-9]{8}$'),
    CONSTRAINT event_seat_passes_seats CHECK (seats BETWEEN 1 AND 20),
    CONSTRAINT event_seat_passes_seat_from CHECK (seat_from IS NULL OR seat_from > 0),
    -- An admitted pass names who admitted it. Half of that record is worse than
    -- none: it reads as an audited entry and cannot be traced to anybody.
    CONSTRAINT event_seat_passes_admission_complete
        CHECK ((admitted_at IS NULL) = (admitted_by IS NULL)),
    -- Revoking a pass after its holder is already inside is a fiction.
    CONSTRAINT event_seat_passes_not_both
        CHECK (admitted_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX event_seat_passes_code
    ON event_seat_passes (institution_id, code);

-- One live pass per child per event. A parent refreshing the screen must not
-- put a second admitting code into circulation; the first would still open the
-- door after the second was spent.
CREATE UNIQUE INDEX event_seat_passes_one_live
    ON event_seat_passes (event_id, student_id)
 WHERE revoked_at IS NULL;

CREATE INDEX event_seat_passes_child
    ON event_seat_passes (student_id, issued_at DESC);

/* A measurable goal inside a child's support plan.

   student_support_plans (00019) holds the concern and the accommodations — the
   sentence a substitute teacher reads on the morning. What it cannot express is
   "reads 40 words a minute by March, from 22 today", and without that a review
   meeting argues about whether the plan is working from memory.

   The goal holds only the two fixed numbers: where the child started and where
   the plan is aiming. Today's number is NOT stored here. It is the most recent
   row in student_support_goal_updates, because a current_value column and an
   observation log are two records of the same fact, and the column is the one
   that goes stale when an observation is corrected.

   visible_to_family follows ptm_notes: most of a plan is written with the
   parent in the room and should be theirs to read, but a goal recorded from a
   clinical referral is not always the school's to disclose. Default true, so
   withholding is a decision somebody made rather than the way it arrives. */
CREATE TABLE student_support_goals (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    plan_id         uuid        NOT NULL REFERENCES student_support_plans(id) ON DELETE CASCADE,
    title           text        NOT NULL,
    domain          text        NOT NULL DEFAULT 'academic',
    -- Where the child was when the goal was written, and where it is aiming.
    -- Both nullable because a goal can be qualitative ("initiates a greeting
    -- unprompted"), and a school forced to invent numbers records fiction.
    baseline_value  numeric(10,2),
    target_value    numeric(10,2),
    -- 'words per minute', 'prompts needed', 'sessions attended'.
    unit            text,
    -- Whether progress means the number going up. A goal to reduce prompting
    -- succeeds as the figure falls, and a progress bar that does not know this
    -- shows a child improving as though they were deteriorating.
    higher_is_better boolean    NOT NULL DEFAULT true,
    starts_on       date        NOT NULL DEFAULT CURRENT_DATE,
    target_on       date,
    status          text        NOT NULL DEFAULT 'active',
    visible_to_family boolean   NOT NULL DEFAULT true,
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_support_goals_status
        CHECK (status IN ('active', 'met', 'paused', 'withdrawn')),
    CONSTRAINT student_support_goals_domain CHECK (domain IN (
        'academic', 'communication', 'motor', 'behaviour', 'social',
        'self_help', 'therapy', 'attendance')),
    CONSTRAINT student_support_goals_title
        CHECK (nullif(btrim(title), '') IS NOT NULL),
    -- A target date before the goal was written is a typing error that renders
    -- as a goal permanently overdue.
    CONSTRAINT student_support_goals_dates
        CHECK (target_on IS NULL OR target_on >= starts_on),
    -- A measurable goal needs somewhere to measure to. Both numbers or neither:
    -- a baseline with no target cannot be drawn as progress, and a target with
    -- no baseline cannot say how far the child has come.
    CONSTRAINT student_support_goals_measurable
        CHECK ((baseline_value IS NULL) = (target_value IS NULL)),
    -- Identical endpoints make the progress fraction divide by zero, and the
    -- goal is met before it is written.
    CONSTRAINT student_support_goals_span
        CHECK (baseline_value IS NULL OR baseline_value <> target_value)
);

CREATE INDEX student_support_goals_plan
    ON student_support_goals (institution_id, plan_id, status);

/* One dated observation of a goal.

   This is the progress bar's only source. The tracker draws the newest row per
   goal against baseline and target, so correcting a mistyped observation
   corrects the bar, with no second field to remember to update. */
CREATE TABLE student_support_goal_updates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    goal_id         uuid        NOT NULL REFERENCES student_support_goals(id) ON DELETE CASCADE,
    on_date         date        NOT NULL DEFAULT CURRENT_DATE,
    value           numeric(10,2),
    note            text,
    recorded_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- An observation with neither a number nor a sentence records that somebody
    -- opened the form.
    CONSTRAINT student_support_goal_updates_has_content
        CHECK (value IS NOT NULL OR nullif(btrim(coalesce(note, '')), '') IS NOT NULL)
);

-- One observation per goal per day. A therapist saving the form twice would
-- otherwise put two readings on the same date, and "the newest row" then
-- depends on insertion order rather than on the date anybody recorded.
CREATE UNIQUE INDEX student_support_goal_updates_one_per_day
    ON student_support_goal_updates (goal_id, on_date);

CREATE INDEX student_support_goal_updates_recent
    ON student_support_goal_updates (goal_id, on_date DESC);

/* What a child bought at the canteen counter.

   Nothing in the schema holds this. mdm_registers (00008) counts mid-day meals
   served for the state return and is an aggregate per day; invoices bill a fee
   head. Neither can answer the question a parent actually asks, which is what
   their nine-year-old ate at eleven o'clock.

   Money is paise, like everywhere else. total_paise is stored rather than
   summed from the lines because it is what the counter's till printed and what
   the family was charged; a rounding rule changed later must not silently
   restate last term's receipts. The lines are checked against it on write. */
CREATE TABLE cafeteria_purchases (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- The timestamp is the point of the feature. A date alone cannot show that
    -- the child bought a fizzy drink twice before lunch.
    purchased_at    timestamptz NOT NULL DEFAULT now(),
    counter         text,
    total_paise     bigint      NOT NULL,
    mode            text        NOT NULL DEFAULT 'wallet',
    reference_no    text,
    recorded_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cafeteria_purchases_mode
        CHECK (mode IN ('wallet', 'cash', 'card', 'upi', 'subsidy')),
    -- A zero-value purchase is a till error; a negative one is a refund, which
    -- the counter records as its own reversal rather than as a sale.
    CONSTRAINT cafeteria_purchases_total CHECK (total_paise > 0)
);

CREATE INDEX cafeteria_purchases_child_day
    ON cafeteria_purchases (student_id, purchased_at DESC);

CREATE INDEX cafeteria_purchases_day
    ON cafeteria_purchases (institution_id, purchased_at DESC);

/* One line on the canteen receipt.

   Item names are free text and not a catalogue foreign key. A school canteen's
   menu changes weekly and is often run by a contractor; making the parent's
   receipt depend on a maintained item master means the receipt breaks when the
   contractor is changed, and the historic line then renders as a blank.

   kcal and the allergen note are what makes this more than a bill. A parent
   whose child is allergic to peanuts is the reason this screen gets opened. */
CREATE TABLE cafeteria_purchase_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    purchase_id     uuid        NOT NULL REFERENCES cafeteria_purchases(id) ON DELETE CASCADE,
    item_name       text        NOT NULL,
    category        text        NOT NULL DEFAULT 'other',
    quantity        integer     NOT NULL DEFAULT 1,
    unit_paise      bigint      NOT NULL,
    -- Held rather than computed as quantity * unit_paise, because a counter
    -- applies a two-for-one and the line the family was charged is the truth.
    line_paise      bigint      NOT NULL,
    kcal            integer,
    is_vegetarian   boolean,
    allergens       text,
    CONSTRAINT cafeteria_purchase_items_category CHECK (category IN (
        'meal', 'snack', 'beverage', 'dessert', 'fruit', 'stationery', 'other')),
    CONSTRAINT cafeteria_purchase_items_quantity CHECK (quantity > 0),
    CONSTRAINT cafeteria_purchase_items_money
        CHECK (unit_paise >= 0 AND line_paise >= 0),
    CONSTRAINT cafeteria_purchase_items_name
        CHECK (nullif(btrim(item_name), '') IS NOT NULL),
    CONSTRAINT cafeteria_purchase_items_kcal
        CHECK (kcal IS NULL OR kcal BETWEEN 0 AND 5000)
);

CREATE INDEX cafeteria_purchase_items_receipt
    ON cafeteria_purchase_items (purchase_id);

/* The identity a parent or a child shows at the gate.

   The card itself is rendered from students and users — the name, the class,
   the photograph and the guardian's telephone number are already held and are
   not copied here. What is held is the secret behind the code.

   The displayed code is not stored. It is HMAC(secret, serial + time window),
   recomputed by the holder's screen and by the gate, so the number on the
   phone changes every few minutes and a screenshot forwarded to somebody else
   stops working before they reach the school. Storing the current code would
   defeat the whole point: a leaked table would then be a set of working passes,
   which is exactly what a static printed card already is.

   serial is the stable part, quoted in the log and readable when the phone is
   flat. It identifies; it does not admit.

   One holder per row, and exactly one: a card belongs to a parent or to a
   child, never both, because the gate's log has to name a person. */
CREATE TABLE campus_entry_passes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    user_id         uuid        REFERENCES users(id) ON DELETE CASCADE,
    student_id      uuid        REFERENCES students(id) ON DELETE CASCADE,
    serial          text        NOT NULL,
    -- Random per card, never reused. Rotating it (by revoking and reissuing)
    -- is how a parent whose phone was stolen is made safe within a minute.
    secret          bytea       NOT NULL,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    CONSTRAINT campus_entry_passes_one_holder
        CHECK ((user_id IS NULL) <> (student_id IS NULL)),
    CONSTRAINT campus_entry_passes_serial
        CHECK (serial ~ '^[A-Z]{2}-[0-9A-Z]{8}$')
);

/* One live card per holder.

   user_id and student_id are each null on half the rows, and a nullable column
   inside a unique index disables it silently: Postgres treats two nulls as
   distinct, so every parent card would compare unequal to every other and the
   index would permit unlimited duplicates while appearing to prevent them.
   COALESCE to the nil uuid gives both halves a concrete value to collide on.

   The predicate is what makes it "live" — a revoked card does not block the
   replacement issued to a parent who lost their phone. */
CREATE UNIQUE INDEX campus_entry_passes_one_live
    ON campus_entry_passes (
        institution_id,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX campus_entry_passes_serial_unique
    ON campus_entry_passes (institution_id, serial);

/* Where a notification came from.

   notifications has existed since the baseline and nothing has ever written to
   it, because there was no way to deliver an alert twice safely. A loop that
   turns "invoice 4471 is overdue" into a row has to be able to ask whether it
   already did, and title text is not an identity — the wording changes and the
   parent gets the same alert again under a new sentence.

   source_id is nullable, because an alert can be about a fact with no row of
   its own ("three absences this fortnight"). That nullability is precisely why
   the uniqueness below cannot key on it bare. */
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS source_kind text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS source_id uuid;

/* Deliver each fact to each person once.

   The COALESCE is load-bearing and not defensive tidiness. With source_id bare,
   every summary alert — the ones whose source_id is null — would be unique
   against every other, so the delivery loop would insert a fresh "fees overdue"
   row on every single poll and the parent's feed would fill with copies of one
   sentence. The nil uuid gives those rows something to collide on, and the
   partial predicate keeps the index off the rows that predate this column. */
CREATE UNIQUE INDEX notifications_one_per_source
    ON notifications (
        user_id, kind,
        COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE source_kind IS NOT NULL;

-- The feed's own query: this user's alerts, newest first.
CREATE INDEX notifications_feed
    ON notifications (institution_id, user_id, created_at DESC);

CREATE INDEX notifications_unread
    ON notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE ptm_slots                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ptm_slots                    FORCE  ROW LEVEL SECURITY;
ALTER TABLE school_events                ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_events                FORCE  ROW LEVEL SECURITY;
ALTER TABLE event_media                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_media                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE event_seat_passes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_seat_passes            FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_support_goals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_support_goals        FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_support_goal_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_support_goal_updates FORCE  ROW LEVEL SECURITY;
ALTER TABLE cafeteria_purchases          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafeteria_purchases          FORCE  ROW LEVEL SECURITY;
ALTER TABLE cafeteria_purchase_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafeteria_purchase_items     FORCE  ROW LEVEL SECURITY;
ALTER TABLE campus_entry_passes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus_entry_passes          FORCE  ROW LEVEL SECURITY;

CREATE POLICY ptm_slots_tenant ON ptm_slots
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY school_events_tenant ON school_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY event_media_tenant ON event_media
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY event_seat_passes_tenant ON event_seat_passes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY student_support_goals_tenant ON student_support_goals
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY student_support_goal_updates_tenant ON student_support_goal_updates
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY cafeteria_purchases_tenant ON cafeteria_purchases
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY cafeteria_purchase_items_tenant ON cafeteria_purchase_items
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY campus_entry_passes_tenant ON campus_entry_passes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP INDEX IF EXISTS notifications_unread;
DROP INDEX IF EXISTS notifications_feed;
DROP INDEX IF EXISTS notifications_one_per_source;
ALTER TABLE notifications DROP COLUMN IF EXISTS source_id;
ALTER TABLE notifications DROP COLUMN IF EXISTS source_kind;
DROP TABLE IF EXISTS campus_entry_passes;
DROP TABLE IF EXISTS cafeteria_purchase_items;
DROP TABLE IF EXISTS cafeteria_purchases;
DROP TABLE IF EXISTS student_support_goal_updates;
DROP TABLE IF EXISTS student_support_goals;
DROP TABLE IF EXISTS event_seat_passes;
DROP TABLE IF EXISTS event_media;
DROP TABLE IF EXISTS school_events;
DROP TABLE IF EXISTS ptm_slots;
