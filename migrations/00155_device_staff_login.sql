-- +goose Up
-- +goose StatementBegin

/* A person on a handset, not just a handset.

   Both Android apps authenticate a *device* and nothing else: a pair code is
   claimed once, a bearer token comes back, and every trip and every message
   afterwards records which phone did the work. Nobody is in that story. After
   an incident the transport office can say bus 12 was moving at 7:40 and cannot
   say who was driving it, which is the first question anybody asks.

   So a staff member signs in on the handset, on top of the device credential
   rather than instead of it. The two facts are different -- which phone, and
   which person -- and a school needs both.

   --------------------------------------------------------------------------
   WHY A PIN AND A PHONE NUMBER, AND NOT AN EMAIL AND A PASSWORD

   Drivers in these schools have phone numbers and do not have email addresses.
   Asking the office to invent one per driver produces driver1@school.in with
   the password written on a sticker in the cab, which is worse than no
   authentication because it looks like some. A phone number is the identity
   people here already have and already know by heart.

   A PIN is weaker than a password and is chosen deliberately. It is typed in a
   bus cab at 6am in the cold by somebody wearing gloves, and a credential that
   is hard to type is a credential that gets written on the dashboard. The
   weakness is answered by lockout below rather than by length: five wrong
   tries and the account stops answering for fifteen minutes, which makes
   guessing a four-digit PIN a job measured in weeks rather than seconds.

   Hashed with the same Argon2id helper and the same pepper as every password
   in this database, not a second scheme of its own. */

ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_set_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_set_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Lockout state. Counted on the row rather than in Redis: a lockout that
-- evaporates when the cache restarts is not a lockout, and this is the one
-- credential in the product short enough to be worth guessing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_failed integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz;

/* A phone number that signs in must identify exactly one person, everywhere.

   Not per institution: the SMS gateway enrols by signing in *before* it
   belongs to any school, so at the moment of login there is no tenant to scope
   the lookup to. The number is what tells the server which school this is.

   Only among PIN holders, which is what keeps this from colliding with the
   thousands of parents who share a household number and never sign in on a
   handset. A school with two staff on one number can give the PIN to one of
   them; the index will refuse the second, which is the correct answer rather
   than an inconvenience -- two people behind one credential is exactly what
   this feature exists to stop.

   Matched on the last ten digits so that 9876543210, 09876543210 and
   +91 98765 43210 are one number. Everybody writes it differently and no
   school is going to normalise its own data first. */
CREATE UNIQUE INDEX IF NOT EXISTS users_pin_phone_unique
    ON users (right(regexp_replace(phone, '\D', '', 'g'), 10))
    WHERE pin_hash IS NOT NULL AND phone IS NOT NULL;

/* What a signed-in session on a handset is.

   Separate from web sessions, which are a signed cookie: a phone holds no
   cookie jar, its token has to survive the app being killed by Doze, and it
   must be revocable one handset at a time from the office without signing
   that person out of the browser they are also using.

   Sealed rather than hashed, following vehicle_trackers and
   sms_gateway_devices exactly: AES-GCM with a random nonce is not
   deterministic and cannot be an index key, so the token the app presents
   carries this row's id in front of the secret. Inventing a second at-rest
   scheme beside the one the device tokens already use would be the only thing
   worse than either. */
CREATE TABLE IF NOT EXISTS device_staff_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Which app, and which handset inside it. The device row is not a foreign
    -- key to one table because there are two -- vehicle_trackers and
    -- sms_gateway_devices -- and a session is meaningless without its app.
    app             text NOT NULL,
    device_id       uuid NOT NULL,

    token_sealed    bytea NOT NULL,

    started_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    -- Signed out, or revoked from the office. Kept rather than deleted: which
    -- driver was signed in when a trip ran is the audit trail the whole
    -- feature exists to produce, and vehicle_trips points at this row.
    ended_at        timestamptz,
    ended_reason    text,

    CONSTRAINT device_staff_sessions_app
        CHECK (app IN ('bus_tracker', 'sms_gateway')),
    CONSTRAINT device_staff_sessions_ended_is_explained
        CHECK ((ended_at IS NULL) = (ended_reason IS NULL)),
    CONSTRAINT device_staff_sessions_ended_reason
        CHECK (ended_reason IS NULL
               OR ended_reason IN ('signed_out', 'expired', 'revoked', 'superseded'))
);

-- One live session per handset. A second sign-in supersedes the first rather
-- than running beside it: two people cannot both be driving one bus, and a
-- shared office handset that accumulates sessions makes "who sent this"
-- unanswerable, which is the question this table exists to answer.
CREATE UNIQUE INDEX IF NOT EXISTS device_staff_sessions_one_live_per_device
    ON device_staff_sessions (app, device_id)
    WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS device_staff_sessions_by_user
    ON device_staff_sessions (institution_id, user_id, started_at DESC);

ALTER TABLE device_staff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_staff_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY device_staff_sessions_tenant ON device_staff_sessions
    USING (institution_id = app_current_institution())
    WITH CHECK (institution_id = app_current_institution());

/* Who was driving.

   vehicle_trips.started_by has existed since the table was created and has
   been null on every row a handset ever produced, because a handset had no
   user to name. It is the column this feature was missing rather than a new
   one, so the driver's session fills it and nothing downstream changes shape.

   driver_session_id is the stronger fact: started_by survives the session
   being deleted and answers "who", while this answers "under which sign-in",
   which is what distinguishes a driver who signed in at 6am from the same
   driver's phone left signed in for a week. */
ALTER TABLE vehicle_trips ADD COLUMN IF NOT EXISTS driver_session_id uuid
    REFERENCES device_staff_sessions(id) ON DELETE SET NULL;

/* The SMS gateway enrols by signing in, rather than by claiming a code.

   The pair-code flow asked an administrator to generate a code in the console
   and somebody else to type it into a handset within ten minutes, which is two
   people and a stopwatch. In a school with a two-person office they are the
   same person, walking between two screens.

   Now the office signs in on the handset and the phone appears in the admin
   portal by itself. What it does NOT do is start sending: an enrolled device
   is pending until somebody with integrations.write approves it, because
   anybody holding a staff PIN could otherwise turn their own phone into the
   school's SMS sender with no administrator in the loop.

   The one exception is the person who could have approved it anyway. If the
   staff member signing in already holds integrations.write, the device is
   approved as it is created -- making them walk to another screen to permit
   what they just did is ceremony, not control. That is also the common case
   here: the principal installs it themselves. */
ALTER TABLE sms_gateway_devices ALTER COLUMN pair_code_id DROP NOT NULL;

ALTER TABLE sms_gateway_devices ADD COLUMN IF NOT EXISTS enrolled_by uuid
    REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sms_gateway_devices ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE sms_gateway_devices ADD COLUMN IF NOT EXISTS approved_by uuid
    REFERENCES users(id) ON DELETE SET NULL;

-- Every device arrived one way or the other, never both and never neither.
-- This replaces the NOT NULL that pair_code_id used to carry: dropping that
-- without putting something in its place would leave a device that belongs to
-- no enrolment at all, and nothing would notice.
ALTER TABLE sms_gateway_devices DROP CONSTRAINT IF EXISTS sms_gateway_devices_enrolment;
ALTER TABLE sms_gateway_devices ADD CONSTRAINT sms_gateway_devices_enrolment
    CHECK (num_nonnulls(pair_code_id, enrolled_by) = 1);

-- Every device that exists today came through a pair code an administrator
-- generated, which is an approval by any reading. Backfilled to when it was
-- paired rather than to now, so the column means the same thing on old rows as
-- on new ones.
UPDATE sms_gateway_devices SET approved_at = paired_at WHERE approved_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE sms_gateway_devices DROP CONSTRAINT IF EXISTS sms_gateway_devices_enrolment;
ALTER TABLE sms_gateway_devices DROP COLUMN IF EXISTS approved_by;
ALTER TABLE sms_gateway_devices DROP COLUMN IF EXISTS approved_at;
ALTER TABLE sms_gateway_devices DROP COLUMN IF EXISTS enrolled_by;

ALTER TABLE vehicle_trips DROP COLUMN IF EXISTS driver_session_id;

DROP TABLE IF EXISTS device_staff_sessions;

DROP INDEX IF EXISTS users_pin_phone_unique;
ALTER TABLE users DROP COLUMN IF EXISTS pin_locked_until;
ALTER TABLE users DROP COLUMN IF EXISTS pin_failed;
ALTER TABLE users DROP COLUMN IF EXISTS pin_set_by;
ALTER TABLE users DROP COLUMN IF EXISTS pin_set_at;
ALTER TABLE users DROP COLUMN IF EXISTS pin_hash;

-- +goose StatementEnd
