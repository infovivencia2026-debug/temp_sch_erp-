-- Number claimed at 00122; may be renumbered at integration.
-- +goose Up
--
-- Live vehicle tracking, where the tracker is the driver's phone.
--
-- The catalogue has carried eight transport features that were deferred on one
-- sentence: "GPS tracker fitted to each vehicle". Fitting fifty trackers is a
-- procurement project a school does not start in August. A driver already
-- carries a phone with a better GNSS chip than most fleet units, and this
-- codebase already turns a spare handset into a school SMS gateway (00102), so
-- the pattern and its wire contract exist and are proven.
--
-- What that does NOT unblock, named here so nobody reads this file as more
-- than it is:
--
--   fuel level        needs a sensor in the tank. A phone cannot infer it.
--   cabin video       needs cameras.
--   AIS-140           is a certification of a specific device, not a shape of
--                     data. A phone is not one, and software claiming the
--                     compliance would be a false statement to a transport
--                     authority rather than an empty screen.
--
-- Two properties shape every table below.
--
-- POSITIONS ARE THE HIGHEST-VOLUME ROWS IN THIS PRODUCT. Twenty buses pinging
-- every ten seconds for a ten-hour day is 72,000 rows a day, 13 million in a
-- school year. Every other table here is small. So the history is written
-- append-only and never read by the live map: vehicle_last_position holds one
-- row per vehicle and is what the map, every parent poll and every ETA read.
-- The alternative -- ORDER BY recorded_at DESC LIMIT 1 per vehicle on every
-- poll -- is the query that looks fine on a demo and collapses in March.
--
-- A BUS DOES NOT STOP EXISTING WHEN THE RUN ENDS, AND NEITHER DOES THE DRIVER.
-- The phone is the driver's own, in the driver's pocket, and it does not know
-- the difference between the afternoon run and the drive home. So position is
-- bound to a trip: the app reports continuously, the server files a position
-- against an open trip, and nothing outside an open trip is visible to a
-- parent. A live map that shows a school employee at their own front door at
-- nine in the evening is workplace surveillance that happens to be spelled
-- "transport feature", and it is the reason trip_id is NOT NULL on the
-- visible path rather than a filter somebody remembers to apply.

-- --------------------------------------------------------------------------
-- The paired phone
-- --------------------------------------------------------------------------

CREATE TABLE vehicle_tracker_pair_codes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- Which bus this code will bind the phone to. Chosen when the code is
    -- generated, not by the phone: a driver typing a registration number into
    -- a handset is a driver mis-typing a registration number, and the wrong
    -- bus on the map is worse than no bus.
    vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,

    -- Only the hash is stored, so a database read does not yield a working
    -- code. Deterministic, unlike the sealed token below, because this one has
    -- to be looked up by.
    code_hash       bytea NOT NULL,
    expires_at      timestamptz NOT NULL,
    claimed_at      timestamptz,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vehicle_tracker_pair_codes_by_hash
    ON vehicle_tracker_pair_codes (code_hash);

CREATE INDEX vehicle_tracker_pair_codes_live
    ON vehicle_tracker_pair_codes (institution_id, expires_at)
    WHERE claimed_at IS NULL;

CREATE TABLE vehicle_trackers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,

    -- What the office calls this handset. "Ravi's phone" is what somebody
    -- needs to read when TS07 has stopped reporting, not "SM-A146B".
    name            text NOT NULL,
    device_model    text,
    android_version text,
    app_version     text,

    -- The phone's only credential, sealed with the same AES-GCM helper that
    -- protects the SMTP password and the SMS gateway token (sealSecret in
    -- internal/api/messaging.go). Sealed rather than hashed, and never looked
    -- up by: AES-GCM's nonce is random, so the ciphertext cannot be an index
    -- key. The presented token carries this row's id in front of the secret.
    token_sealed    bytea NOT NULL,

    -- NOT NULL and UNIQUE below, which is what makes a pair code single-use
    -- structurally instead of by a handler remembering to check.
    pair_code_id    uuid NOT NULL REFERENCES vehicle_tracker_pair_codes(id) ON DELETE RESTRICT,

    paired_at       timestamptz NOT NULL DEFAULT now(),
    paired_by       uuid REFERENCES users(id) ON DELETE SET NULL,

    -- Revocation is a column, not a DELETE: the position history is the record
    -- of where the school's bus actually went, and deleting the tracker would
    -- orphan it. A driver who leaves is revoked, not erased.
    revoked_at      timestamptz,
    revoked_reason  text,

    -- --- what the phone reports ------------------------------------------
    last_seen_at    timestamptz,
    battery_pct     integer,
    charging        boolean,
    -- Whether the driver has location permission and the OS is actually
    -- giving fixes. A phone that is online, charged and reporting
    -- location_ok = false is the exact failure the office must be shown:
    -- everything looks healthy and the bus is not on the map.
    location_ok     boolean,

    -- --- what the server tells the phone ----------------------------------
    -- The phone obeys rather than deciding. Battery is the school's to trade
    -- against freshness, and a handset choosing its own interval is a handset
    -- that flattens by two o'clock.
    ping_seconds    integer NOT NULL DEFAULT 15,
    paused          boolean NOT NULL DEFAULT false,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vehicle_trackers_ping_sane
        CHECK (ping_seconds BETWEEN 5 AND 300),
    CONSTRAINT vehicle_trackers_battery_pct
        CHECK (battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100),
    CONSTRAINT vehicle_trackers_revoked_is_explained
        CHECK (revoked_at IS NULL OR nullif(btrim(revoked_reason), '') IS NOT NULL)
);

-- One pair code produces one tracker, ever.
CREATE UNIQUE INDEX vehicle_trackers_one_per_pair_code
    ON vehicle_trackers (pair_code_id);

-- One live tracker per vehicle. COALESCE, not a plain UNIQUE on
-- (vehicle_id, revoked_at): a NULL is distinct from every other NULL, so the
-- plain form would permit any number of live trackers on one bus while looking
-- like it forbade them. This codebase has been bitten by that eight times.
CREATE UNIQUE INDEX vehicle_trackers_one_live_per_vehicle
    ON vehicle_trackers (vehicle_id, COALESCE(revoked_at, 'epoch'::timestamptz));

CREATE INDEX vehicle_trackers_live
    ON vehicle_trackers (institution_id, last_seen_at DESC)
    WHERE revoked_at IS NULL;

-- --------------------------------------------------------------------------
-- A run of a route
-- --------------------------------------------------------------------------

CREATE TABLE vehicle_trips (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    route_id        uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    tracker_id      uuid REFERENCES vehicle_trackers(id) ON DELETE SET NULL,

    -- Which way round the stop sequence runs. The morning run visits stop 1
    -- first and the school last; the afternoon reverses it, and an ETA
    -- computed against the wrong direction is worse than no ETA.
    direction       text NOT NULL,

    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    -- How the trip ended, because "the driver pressed End" and "nothing was
    -- heard for twenty minutes and the server closed it" are different facts
    -- and only one of them means the children were dropped off.
    ended_reason    text,

    started_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vehicle_trips_direction
        CHECK (direction IN ('pickup','drop')),
    CONSTRAINT vehicle_trips_ended_reason
        CHECK (ended_reason IS NULL
               OR ended_reason IN ('driver','timeout','admin','superseded')),
    CONSTRAINT vehicle_trips_ended_is_explained
        CHECK ((ended_at IS NULL) = (ended_reason IS NULL)),
    CONSTRAINT vehicle_trips_period
        CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- One open trip per vehicle. Same COALESCE reason as above: without it a
-- driver who starts a run twice puts two open trips on one bus and every
-- parent poll picks whichever the planner returns first.
CREATE UNIQUE INDEX vehicle_trips_one_open_per_vehicle
    ON vehicle_trips (vehicle_id, COALESCE(ended_at, 'epoch'::timestamptz));

CREATE INDEX vehicle_trips_by_route
    ON vehicle_trips (institution_id, route_id, started_at DESC);

CREATE INDEX vehicle_trips_open
    ON vehicle_trips (institution_id, started_at DESC)
    WHERE ended_at IS NULL;

-- --------------------------------------------------------------------------
-- Position: the history, and the one row anybody reads
-- --------------------------------------------------------------------------

CREATE TABLE vehicle_positions (
    id              bigserial PRIMARY KEY,
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    trip_id         uuid NOT NULL REFERENCES vehicle_trips(id) ON DELETE CASCADE,
    vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,

    -- When the phone took the fix, not when the server received it. A bus
    -- through a cellular dead zone uploads twenty minutes of buffered fixes at
    -- once, and filing them all at the receive time would draw a straight line
    -- from the dead zone to wherever it came out.
    recorded_at     timestamptz NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),

    latitude        numeric(9,6) NOT NULL,
    longitude       numeric(9,6) NOT NULL,
    -- From the GNSS chip's own Doppler rather than differentiated from
    -- successive fixes, which is noisy enough at low speed to raise a speeding
    -- alert on a stationary bus.
    speed_kmph      numeric(5,1),
    heading_deg     integer,
    accuracy_m      numeric(6,1),

    CONSTRAINT vehicle_positions_latitude  CHECK (latitude  BETWEEN  -90 AND  90),
    CONSTRAINT vehicle_positions_longitude CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT vehicle_positions_speed     CHECK (speed_kmph IS NULL OR speed_kmph >= 0),
    CONSTRAINT vehicle_positions_heading
        CHECK (heading_deg IS NULL OR heading_deg BETWEEN 0 AND 359)
);

-- A phone that uploads a batch, loses the network before the response and
-- retries must not double the history. The natural key is the trip and the
-- instant the fix was taken.
CREATE UNIQUE INDEX vehicle_positions_one_per_fix
    ON vehicle_positions (trip_id, recorded_at);

CREATE INDEX vehicle_positions_replay
    ON vehicle_positions (trip_id, recorded_at);

-- The retention boundary. Positions older than this are the school's to keep
-- or drop; the index exists so the sweep is cheap rather than a table scan.
CREATE INDEX vehicle_positions_age
    ON vehicle_positions (institution_id, recorded_at);

/* One row per vehicle, overwritten in place.

   This is what the live map, every parent poll and every ETA read. Separated
   from the history because those two have opposite shapes: the history is
   append-only and never queried per-vehicle-latest, and the live read is
   per-vehicle-latest and never scanned. Keeping them in one table means every
   parent refresh runs a DISTINCT ON over a table growing by 72,000 rows a day.
*/
CREATE TABLE vehicle_last_position (
    vehicle_id      uuid PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    trip_id         uuid REFERENCES vehicle_trips(id) ON DELETE SET NULL,
    recorded_at     timestamptz NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    latitude        numeric(9,6) NOT NULL,
    longitude       numeric(9,6) NOT NULL,
    speed_kmph      numeric(5,1),
    heading_deg     integer,
    accuracy_m      numeric(6,1),
    -- Denormalised so the map can colour a stale marker without joining the
    -- tracker. A marker that looks live and is forty minutes old is the single
    -- worst thing this feature can do.
    tracker_id      uuid REFERENCES vehicle_trackers(id) ON DELETE SET NULL
);

CREATE INDEX vehicle_last_position_fresh
    ON vehicle_last_position (institution_id, recorded_at DESC);

-- --------------------------------------------------------------------------
-- Geofencing, and what the school considers unsafe
-- --------------------------------------------------------------------------

-- Stops already carry latitude and longitude from 00001. What they lacked was
-- a radius. Nullable, falling back to the institution default below, because a
-- stop on a wide junction and a stop in a lane need different circles and most
-- need neither decided individually.
ALTER TABLE route_stops ADD COLUMN IF NOT EXISTS geofence_m integer;

ALTER TABLE route_stops ADD CONSTRAINT route_stops_geofence_m
    CHECK (geofence_m IS NULL OR geofence_m BETWEEN 30 AND 2000);

CREATE TABLE transport_tracking_policy (
    institution_id      uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,

    -- The circle a stop gets when it has not been given one. 120m is a
    -- deliberate default: tight enough that a bus on the far side of a
    -- junction does not count as arrived, loose enough to survive the ±30m a
    -- phone reports in a built-up street.
    default_geofence_m  integer NOT NULL DEFAULT 120,

    -- What the school calls speeding. Not a legal limit -- the road's limit is
    -- the road's -- but the number above which the office wants to be told,
    -- which for a school bus is usually well below what the law allows.
    speed_limit_kmph    integer NOT NULL DEFAULT 50,
    -- Sustained, not instantaneous. One GNSS fix reading 3 km/h high on a
    -- bridge is not rash driving, and an alert per bridge is an alert nobody
    -- reads by the second week.
    speeding_hold_secs  integer NOT NULL DEFAULT 20,

    -- How long a trip may go unheard before the server closes it. The phone
    -- died, the bus finished, the driver forgot -- from the server's side
    -- these look identical, and leaving the trip open leaves a stale marker on
    -- a parent's map that says the bus is still coming.
    trip_timeout_mins   integer NOT NULL DEFAULT 20,

    ping_seconds        integer NOT NULL DEFAULT 15,

    -- Whether parents see the bus at all. On by default is the wrong default
    -- for a feature that publishes a vehicle's position to several hundred
    -- families; a school turns this on when it has told them it will.
    parents_may_watch   boolean NOT NULL DEFAULT false,
    -- Minutes before the scheduled pickup that the map opens to a family, so
    -- watching starts when it is useful rather than all day.
    watch_window_mins   integer NOT NULL DEFAULT 45,

    -- How long the breadcrumb history is kept. An incident enquiry needs
    -- weeks; nobody needs years, and 13 million rows a year is the reason to
    -- have an answer rather than a default of "forever".
    retain_days         integer NOT NULL DEFAULT 90,

    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT transport_tracking_policy_geofence
        CHECK (default_geofence_m BETWEEN 30 AND 2000),
    CONSTRAINT transport_tracking_policy_speed
        CHECK (speed_limit_kmph BETWEEN 10 AND 120),
    CONSTRAINT transport_tracking_policy_hold
        CHECK (speeding_hold_secs BETWEEN 5 AND 300),
    CONSTRAINT transport_tracking_policy_timeout
        CHECK (trip_timeout_mins BETWEEN 5 AND 240),
    CONSTRAINT transport_tracking_policy_ping
        CHECK (ping_seconds BETWEEN 5 AND 300),
    CONSTRAINT transport_tracking_policy_window
        CHECK (watch_window_mins BETWEEN 5 AND 240),
    CONSTRAINT transport_tracking_policy_retain
        CHECK (retain_days BETWEEN 7 AND 3650)
);

/* Arrival and departure at a stop.

   One row per trip per stop per kind, enforced by the index rather than by the
   evaluator remembering. The bus that idles on the edge of a geofence crosses
   it eleven times in four minutes, and eleven "your child's bus has arrived"
   messages is how a school switches the feature off.
*/
CREATE TABLE transport_stop_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    trip_id         uuid NOT NULL REFERENCES vehicle_trips(id) ON DELETE CASCADE,
    stop_id         uuid NOT NULL REFERENCES route_stops(id) ON DELETE CASCADE,
    kind            text NOT NULL,
    occurred_at     timestamptz NOT NULL,
    -- Where the bus actually was when the circle was crossed, kept because
    -- "the geofence fired and the bus was 300m away" is a question that gets
    -- asked and cannot be answered from the event alone.
    latitude        numeric(9,6),
    longitude       numeric(9,6),
    -- Minutes early (negative) or late (positive) against route_stops'
    -- scheduled time, computed once here so the delay report and the parent's
    -- screen cannot disagree about it.
    deviation_mins  integer,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT transport_stop_events_kind CHECK (kind IN ('arrived','departed'))
);

CREATE UNIQUE INDEX transport_stop_events_one_per_occurrence
    ON transport_stop_events (trip_id, stop_id, kind);

CREATE INDEX transport_stop_events_by_stop
    ON transport_stop_events (institution_id, stop_id, occurred_at DESC);

/* Speeding and harsh driving.

   Kept apart from stop events because they are read by different people for
   different reasons: a stop event is a parent's "where is the bus", a safety
   event is the transport manager's conversation with a driver on Friday.
*/
CREATE TABLE transport_safety_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    trip_id         uuid NOT NULL REFERENCES vehicle_trips(id) ON DELETE CASCADE,
    vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    kind            text NOT NULL,

    started_at      timestamptz NOT NULL,
    ended_at        timestamptz,
    peak_kmph       numeric(5,1),
    limit_kmph      integer,
    latitude        numeric(9,6),
    longitude       numeric(9,6),

    -- Acknowledged by a human, with what was said. An alert list nobody closes
    -- is a list nobody reads.
    reviewed_at     timestamptz,
    reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    review_note     text,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT transport_safety_events_kind
        CHECK (kind IN ('speeding','harsh_brake','harsh_accel','harsh_turn')),
    CONSTRAINT transport_safety_events_period
        CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- One open episode of a kind per trip: a bus over the limit for two minutes is
-- one speeding event that ends, not twelve.
CREATE UNIQUE INDEX transport_safety_events_one_open
    ON transport_safety_events (trip_id, kind, COALESCE(ended_at, 'epoch'::timestamptz));

CREATE INDEX transport_safety_events_open
    ON transport_safety_events (institution_id, started_at DESC)
    WHERE reviewed_at IS NULL;

-- --------------------------------------------------------------------------
-- What a family chooses for themselves
-- --------------------------------------------------------------------------

CREATE TABLE transport_watch_prefs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Null means "all my children". A parent with one child never sees this
    -- distinction; a parent with three on two routes does.
    student_id      uuid REFERENCES students(id) ON DELETE CASCADE,

    -- How often the parent's map asks for a new position. Their battery, their
    -- choice -- but bounded, because the server pays for it too.
    refresh_seconds integer NOT NULL DEFAULT 20,
    -- How close the bus must be before they are told it is coming. A family
    -- two minutes from the gate and a family who need ten to walk down the
    -- lane want different numbers, and this is the whole feature.
    proximity_m     integer NOT NULL DEFAULT 800,
    notify_approach boolean NOT NULL DEFAULT true,

    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT transport_watch_prefs_refresh
        CHECK (refresh_seconds BETWEEN 10 AND 300),
    CONSTRAINT transport_watch_prefs_proximity
        CHECK (proximity_m BETWEEN 100 AND 5000)
);

-- One preference row per parent per child. The COALESCE is the nullable-UNIQUE
-- trap again: student_id is null for "all my children", and a plain UNIQUE
-- would let a parent accumulate a new all-children row on every save.
CREATE UNIQUE INDEX transport_watch_prefs_one_per_subject
    ON transport_watch_prefs (user_id,
        COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- --------------------------------------------------------------------------
-- Row level security
-- --------------------------------------------------------------------------
--
-- vehicle_positions and vehicle_last_position are written by a paired handset,
-- which holds no session and therefore no app_current_institution(). The
-- ingest path runs AsPlatform and resolves the institution from the tracker
-- row, exactly as the SMS gateway does; the policies below are what protects
-- every *read* of this data from the SPA.

ALTER TABLE vehicle_tracker_pair_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_tracker_pair_codes FORCE  ROW LEVEL SECURITY;
CREATE POLICY vehicle_tracker_pair_codes_tenant ON vehicle_tracker_pair_codes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE vehicle_trackers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_trackers FORCE  ROW LEVEL SECURITY;
CREATE POLICY vehicle_trackers_tenant ON vehicle_trackers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE vehicle_trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_trips FORCE  ROW LEVEL SECURITY;
CREATE POLICY vehicle_trips_tenant ON vehicle_trips
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE vehicle_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_positions FORCE  ROW LEVEL SECURITY;
CREATE POLICY vehicle_positions_tenant ON vehicle_positions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE vehicle_last_position ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_last_position FORCE  ROW LEVEL SECURITY;
CREATE POLICY vehicle_last_position_tenant ON vehicle_last_position
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE transport_tracking_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_tracking_policy FORCE  ROW LEVEL SECURITY;
CREATE POLICY transport_tracking_policy_tenant ON transport_tracking_policy
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE transport_stop_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_stop_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY transport_stop_events_tenant ON transport_stop_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE transport_safety_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_safety_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY transport_safety_events_tenant ON transport_safety_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE transport_watch_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_watch_prefs FORCE  ROW LEVEL SECURITY;
CREATE POLICY transport_watch_prefs_tenant ON transport_watch_prefs
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON vehicle_tracker_pair_codes  TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicle_trackers            TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicle_trips               TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicle_positions           TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicle_last_position       TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON transport_tracking_policy   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON transport_stop_events       TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON transport_safety_events     TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON transport_watch_prefs       TO app_user;
GRANT USAGE, SELECT ON SEQUENCE vehicle_positions_id_seq            TO app_user;

-- +goose Down

DROP TABLE IF EXISTS transport_watch_prefs;
DROP TABLE IF EXISTS transport_safety_events;
DROP TABLE IF EXISTS transport_stop_events;
DROP TABLE IF EXISTS transport_tracking_policy;
DROP TABLE IF EXISTS vehicle_last_position;
DROP TABLE IF EXISTS vehicle_positions;
DROP TABLE IF EXISTS vehicle_trips;
DROP TABLE IF EXISTS vehicle_trackers;
DROP TABLE IF EXISTS vehicle_tracker_pair_codes;

ALTER TABLE route_stops DROP CONSTRAINT IF EXISTS route_stops_geofence_m;
ALTER TABLE route_stops DROP COLUMN IF EXISTS geofence_m;
