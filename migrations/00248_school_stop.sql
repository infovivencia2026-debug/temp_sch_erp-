-- +goose Up

-- The school is where every run ends, and the product had no idea where it was.
--
-- A route's stops were whatever the office typed, and most ended at the last
-- child's kerb. The bus then drove to the school, the run stayed open, and the
-- one message a parent actually waits for on a pickup morning -- "the bus has
-- reached school" -- had no moment to be sent from, because nothing knew that
-- the gate was a place.
--
-- Two things. The tracking policy carries the school's position and the
-- radius of its gate, set once by the office on the tracker screen. And a
-- route stop can be flagged as the school: a real row in route_stops rather
-- than a virtual point, so the geofence walk, the stop events, the driver's
-- list and the parent's map all treat it as they treat every other stop. The
-- server pins one such stop to the end of every route whenever the policy or
-- a route is saved; the afternoon run reads the sequence backwards, so the
-- same row is the origin of a drop.
--
-- One per route, by partial unique index, which is also what lets the pinning
-- be a single INSERT ... ON CONFLICT.

ALTER TABLE transport_tracking_policy
    ADD COLUMN IF NOT EXISTS school_latitude   numeric(9,6),
    ADD COLUMN IF NOT EXISTS school_longitude  numeric(9,6),
    ADD COLUMN IF NOT EXISTS school_geofence_m integer;

ALTER TABLE transport_tracking_policy
    DROP CONSTRAINT IF EXISTS transport_tracking_policy_school_geofence;
ALTER TABLE transport_tracking_policy
    ADD CONSTRAINT transport_tracking_policy_school_geofence
    CHECK (school_geofence_m IS NULL OR school_geofence_m BETWEEN 30 AND 2000);

ALTER TABLE route_stops
    ADD COLUMN IF NOT EXISTS is_school boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS route_stops_one_school
    ON route_stops (route_id) WHERE is_school;

COMMENT ON COLUMN route_stops.is_school IS
    'The school gate, pinned to the end of the route from the tracking policy. One per route; the afternoon run reads the sequence backwards so it is the origin of a drop.';

-- +goose Down

DROP INDEX IF EXISTS route_stops_one_school;
ALTER TABLE route_stops DROP COLUMN IF EXISTS is_school;
ALTER TABLE transport_tracking_policy
    DROP CONSTRAINT IF EXISTS transport_tracking_policy_school_geofence;
ALTER TABLE transport_tracking_policy
    DROP COLUMN IF EXISTS school_latitude,
    DROP COLUMN IF EXISTS school_longitude,
    DROP COLUMN IF EXISTS school_geofence_m;
