-- +goose Up
-- Renumbered 00055 -> 00057 at integration: the appraisal weight-tolerance fix
-- took 00056 while this was in flight, and goose refuses a migration numbered
-- below the current version.
-- Communication: the grievance queue, the achievements showcase, and a
-- counselling channel that is actually private.
--
-- Numbered 00055 at authoring time; 00054 was claimed by another worker in
-- flight. Renumber freely at integration -- nothing here depends on the number.
--
-- Four features, and only three of them need storage:
--
--   parent_feedback_grievance_hub    extends support_tickets, which already is
--                                    the parent's complaint. A second table
--                                    would give the office two queues that
--                                    disagree about whether a case is shut.
--   school_achievements_showcase     extends student_achievements, which has
--                                    existed since the baseline with no write
--                                    path in Go at all. What was missing was
--                                    the writing, the publishing and the
--                                    photographs -- not the record.
--   private_counselor_chat_channel   genuinely new. Nothing in the schema
--                                    models a conversation whose readership is
--                                    a list rather than a role.
--   ptm_appointment_reminder_alert   NO storage. message_trigger_rules (00044)
--                                    is the rule and appointments (00035) is
--                                    the booking; the feature is one emit at
--                                    the moment a slot is booked. A ptm
--                                    reminders table would be a third diary.

-- ==========================================================
-- 1. Grievances: the school side of a complaint already filed
-- ==========================================================

/* Who the complaint is ABOUT, when it is about a person.

   The load-bearing column in this whole file. A parent complaining that a
   teacher shouted at their child must not have that complaint routed to, read
   by, or assigned to that teacher -- and "we will remember not to" is not a
   control. With the subject named on the row, every staff-facing query can
   exclude it, and the exclusion is one predicate rather than a convention.

   Nullable because most grievances are about the bus, the canteen or a bill,
   and forcing a name onto those would make the column meaningless. */
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS subject_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

-- The department that owns the case. Text rather than a foreign key to
-- departments: transport, canteen and the front desk are owners a school
-- names in this queue but does not carry as academic departments.
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS owner_department text;

-- When the school promised an answer, and when the case must be shut.
-- Stamped from grievance_sla_policies at triage rather than computed on read,
-- because a school that shortens its SLA in March must not retrospectively
-- make every case it closed in February look late.
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS respond_due_at timestamptz;
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS resolve_due_at timestamptz;

-- The first time a human said anything back. Distinct from resolved_at: the
-- complaint most families give up on is the one nobody acknowledged, and a
-- queue that measures only closure cannot see it.
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

-- Raised above the assigned owner, and to whom. Recorded on the ticket
-- because "who escalated this and when" is the first question at a board
-- meeting.
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS escalated_to uuid REFERENCES users(id) ON DELETE SET NULL;

-- resolved_at existed; who resolved it did not.
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- What the family thought of the answer. 1-5 with a comment; recorded on the
-- ticket because a satisfaction table joined one-to-one is the same row with
-- an extra join.
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS satisfaction integer;
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS satisfaction_note text;
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS satisfaction_at timestamptz;

ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS support_tickets_satisfaction_range;
ALTER TABLE support_tickets
    ADD CONSTRAINT support_tickets_satisfaction_range
        CHECK (satisfaction IS NULL OR satisfaction BETWEEN 1 AND 5);

/* A complaint about a person is a school matter, never a vendor one.

   audience='vendor' rows are the school raising a fault with us, and the
   00038 constraint already forbids them naming a child. Naming an employee on
   one would put a member of the school's staff into the platform operator's
   support queue. */
ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS support_tickets_vendor_never_names_staff;
ALTER TABLE support_tickets
    ADD CONSTRAINT support_tickets_vendor_never_names_staff
        CHECK (audience = 'school' OR subject_employee_id IS NULL);

-- The office's own queue: open school-side cases, most overdue first. Partial
-- on audience so the vendor queue's index (00038) stays untouched.
CREATE INDEX IF NOT EXISTS support_tickets_school_queue
    ON support_tickets (institution_id, status, resolve_due_at)
 WHERE audience = 'school';

-- "Show me everything filed against me" -- the query the exclusion is built
-- from, and the one an auditor runs.
CREATE INDEX IF NOT EXISTS support_tickets_subject_employee
    ON support_tickets (institution_id, subject_employee_id)
 WHERE subject_employee_id IS NOT NULL;

COMMENT ON COLUMN support_tickets.subject_employee_id IS
    'The member of staff this grievance is about. Every staff-facing query must exclude rows where this equals the caller''s own employee id, and assignment to that employee is refused.';
COMMENT ON COLUMN support_tickets.respond_due_at IS
    'When the school promised a first response. Stamped from grievance_sla_policies at triage, not computed on read.';

/* How long the school gives itself, per category.

   A row rather than a constant because "safety within four hours, fees within
   three days" is a policy a school sets and revises, and every revision that
   needs a deployment is a revision that does not happen.

   No priority limb. A per-(category, priority) grid is thirty-six rows an
   office will not maintain, and the first one left blank silently means no
   SLA at all. */
CREATE TABLE grievance_sla_policies (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- Matches support_tickets.category, whose vocabulary lives in
    -- concernCategories in internal/api/portal_requests.go. Not a foreign key
    -- and not a CHECK list: duplicating that list here means the two drift,
    -- and the category with no policy is the one nobody notices.
    category          text NOT NULL,
    -- Who picks it up. Free text for the same reason owner_department is.
    owner_department  text,
    -- The default owner for this category. A grievance naming a member of
    -- staff overrides this in the handler -- routing a complaint to the head
    -- of department who is its subject is the failure this feature exists to
    -- prevent.
    default_owner_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    respond_hours     integer NOT NULL DEFAULT 24,
    resolve_hours     integer NOT NULL DEFAULT 168,
    -- Complaints in this category are about people by default, and are held
    -- to the narrow readership even when no employee is named.
    is_sensitive      boolean NOT NULL DEFAULT false,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT grievance_sla_category_present CHECK (btrim(category) <> ''),
    CONSTRAINT grievance_sla_respond_hours CHECK (respond_hours BETWEEN 1 AND 720),
    CONSTRAINT grievance_sla_resolve_hours CHECK (resolve_hours BETWEEN 1 AND 8760),
    CONSTRAINT grievance_sla_order CHECK (resolve_hours >= respond_hours)
);

-- One policy per category per school. Both columns are NOT NULL, so a plain
-- unique index is honest here and needs no COALESCE.
CREATE UNIQUE INDEX grievance_sla_one_per_category
    ON grievance_sla_policies (institution_id, lower(category));

/* Everything that has happened to a grievance since it was filed.

   Two audiences on one timeline, separated by a flag rather than by two
   tables. The office writes "chased the transport manager, no reply" and the
   parent is shown "we are chasing this with transport" -- same case, same
   ordering. Two tables would let the two fall out of order on the screen that
   matters.

   visible_to_parent defaults FALSE. A default of true would mean the first
   internal note somebody forgot to flag is the one quoted back at them. */
CREATE TABLE grievance_updates (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    ticket_id         uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    -- What kind of event this is, so the parent's screen can render a status
    -- change differently from somebody typing a reply.
    kind              text NOT NULL DEFAULT 'note',
    body              text NOT NULL,
    -- Where it moved to, for kind='status'. Denormalised deliberately: the
    -- ticket carries only its current status, and "when did this become
    -- in_progress" is unanswerable without it.
    new_status        text,
    visible_to_parent boolean NOT NULL DEFAULT false,
    author_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT grievance_updates_kind CHECK (kind IN (
        'note', 'reply', 'status', 'assignment', 'escalation', 'resolution')),
    CONSTRAINT grievance_updates_body CHECK (btrim(body) <> ''),
    CONSTRAINT grievance_updates_status_value CHECK (new_status IS NULL OR new_status IN (
        'open', 'in_progress', 'waiting', 'resolved', 'closed'))
);

CREATE INDEX grievance_updates_timeline
    ON grievance_updates (ticket_id, created_at DESC);

-- The parent's own read: their case, the entries meant for them.
CREATE INDEX grievance_updates_parent_visible
    ON grievance_updates (ticket_id, created_at DESC) WHERE visible_to_parent;

COMMENT ON TABLE grievance_updates IS
    'The timeline of one grievance. visible_to_parent=false is an internal note and must never reach the portal; the parent-facing query filters on the flag, not on the caller.';

-- ==========================================================
-- 2. Achievements: the write path, publication, and pictures
-- ==========================================================

/* Whether families and students see it.

   student_achievements has existed since the baseline and has been written by
   nothing; it is read once, by getPortfolio. Adding the write path without a
   publication flag would put every provisional entry -- including the one
   typed against the wrong child -- straight onto the parent portal. */
ALTER TABLE student_achievements
    ADD COLUMN IF NOT EXISTS is_published boolean NOT NULL DEFAULT false;
ALTER TABLE student_achievements
    ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE student_achievements
    ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- The showcase blurb. description is the internal record of what was won;
-- this is the sentence the school is willing to print.
ALTER TABLE student_achievements
    ADD COLUMN IF NOT EXISTS showcase_note text;

/* Permission to publish this child's name and photograph, per achievement.

   There is no media-consent flag anywhere in this schema -- the only consent
   columns are students.aadhaar_consent, admission_applications.aadhaar_consent,
   hostel_outpasses.guardian_consent_* and student_bank_accounts.dbt_consent_on,
   and event_media.published_at is per-photograph withdrawal, not per-child
   permission. Rather than invent students.photo_consent and have every other
   feature quietly start trusting a column nobody ever filled in, the
   confirmation is recorded here, against the one act it authorises.

   Three columns, all-or-nothing: who confirmed it, when, and on what basis --
   a signed form, a portal tick, or a call the office minuted. Without the
   basis the record says a confirmation exists but not that it can be
   produced, which is the half that matters when a parent objects. */
ALTER TABLE student_achievements
    ADD COLUMN IF NOT EXISTS consent_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE student_achievements
    ADD COLUMN IF NOT EXISTS consent_confirmed_at timestamptz;
ALTER TABLE student_achievements
    ADD COLUMN IF NOT EXISTS consent_basis text;

ALTER TABLE student_achievements
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE student_achievements
    DROP CONSTRAINT IF EXISTS student_achievements_consent_complete;
ALTER TABLE student_achievements
    ADD CONSTRAINT student_achievements_consent_complete
        CHECK (num_nulls(consent_confirmed_by, consent_confirmed_at, consent_basis) IN (0, 3));

ALTER TABLE student_achievements
    DROP CONSTRAINT IF EXISTS student_achievements_consent_basis_value;
ALTER TABLE student_achievements
    ADD CONSTRAINT student_achievements_consent_basis_value
        CHECK (consent_basis IS NULL OR consent_basis IN (
            'admission_form', 'signed_consent_form', 'portal_confirmation',
            'recorded_verbal', 'staff_child'));

/* Published means published_at is set, and the reverse.

   Two flags for one fact is how a row ends up published with no publication
   date, which makes "when did this go live" unanswerable in exactly the case
   -- a parent objecting -- where it is asked. */
ALTER TABLE student_achievements
    DROP CONSTRAINT IF EXISTS student_achievements_published_pair;
ALTER TABLE student_achievements
    ADD CONSTRAINT student_achievements_published_pair
        CHECK (is_published = (published_at IS NOT NULL));

/* No publication of a named child without a recorded confirmation.

   Enforced in the database and not only in the handler, because the handler
   is one of several things that could set this flag over the product's life,
   and the constraint is the one that survives the next one being written. */
ALTER TABLE student_achievements
    DROP CONSTRAINT IF EXISTS student_achievements_publish_needs_consent;
ALTER TABLE student_achievements
    ADD CONSTRAINT student_achievements_publish_needs_consent
        CHECK (is_published = false OR consent_confirmed_at IS NOT NULL);

DROP TRIGGER IF EXISTS student_achievements_touch ON student_achievements;
CREATE TRIGGER student_achievements_touch BEFORE UPDATE ON student_achievements
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The showcase's own read: what is live, newest first.
CREATE INDEX IF NOT EXISTS student_achievements_published
    ON student_achievements (institution_id, awarded_on DESC) WHERE is_published;

COMMENT ON COLUMN student_achievements.consent_basis IS
    'How permission to publish this child''s name and photograph was obtained. NULL only while unpublished; student_achievements_publish_needs_consent refuses publication without it.';

/* A photograph of the win.

   Shaped on event_media (00035) and sqaa_evidence (00048): the bytes live in
   files like everything else the school stores, and external_url is the
   fallback for this deployment, where object storage is unconfigured and
   POST /api/v1/files/presign answers 503. Without the fallback the picture
   half of the feature would be unusable in production while looking done.

   files.owner_type / owner_id are deliberately not used. Nothing in this
   codebase writes them. */
CREATE TABLE achievement_media (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    achievement_id  uuid NOT NULL REFERENCES student_achievements(id) ON DELETE CASCADE,
    file_id         uuid REFERENCES files(id) ON DELETE CASCADE,
    external_url    text,
    caption         text,
    sort_order      integer NOT NULL DEFAULT 0,
    added_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Exactly one. A row with both is two pictures pretending to be one, and
    -- a row with neither is a caption with nothing under it.
    CONSTRAINT achievement_media_one_source
        CHECK (num_nonnulls(file_id, nullif(btrim(external_url), '')) = 1)
);

/* The same picture attached twice is a duplicate on the showcase.

   Both source columns are nullable by design -- exactly one is set -- so the
   COALESCE is not tidiness. A bare (achievement_id, file_id, external_url)
   index would treat every NULL as distinct from every other and enforce
   nothing at all, which is the trap this codebase has fallen into six times.

   The empty-string and nil-uuid sentinels are safe: the CHECK above already
   refuses a blank external_url, and files has no nil-uuid row for a file_id
   to collide with. */
CREATE UNIQUE INDEX achievement_media_one_per_source
    ON achievement_media (
        achievement_id,
        COALESCE(file_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(btrim(external_url), ''));

CREATE INDEX achievement_media_gallery
    ON achievement_media (achievement_id, sort_order, created_at);

-- ==========================================================
-- 3. The counselling channel
-- ==========================================================

/* A confidential conversation about one child.

   The point of this table is what it does NOT have: a role. Readership is not
   "counsellors", because a permission grant a future administrator makes for
   an unrelated reason would then silently widen a conversation a mother had
   about her marriage. Readership is a list -- counselor_thread_participants --
   and membership of that list is the only key. A class teacher, a head of
   department and a principal are not members by virtue of being those things.

   Deliberately NOT reused:

     parent_teacher_messages (00032) is a thread with the child's teacher, and
     its whole design is that the teacher of the section can read it. That is
     the opposite requirement.

     the admissions counsellor assignment is a sales counsellor working a
     prospect. A different job with the same word.

     support_tickets is a case with an outcome, worked by a queue. A queue is
     a readership that changes with the rota, which is what must not happen
     here. */
CREATE TABLE counselor_threads (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id        uuid REFERENCES campuses(id) ON DELETE SET NULL,
    -- The child the conversation concerns. NOT NULL: a counselling thread
    -- with no child is a staff welfare matter, which is a different product
    -- with a different readership, and allowing it here would give the
    -- child-ownership check a null case to fall through.
    student_id       uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    opened_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    subject          text NOT NULL,
    status           text NOT NULL DEFAULT 'open',
    -- Kept for the counsellor's triage. Not a permission input: a 'routine'
    -- thread is exactly as private as an 'urgent' one.
    urgency          text NOT NULL DEFAULT 'normal',
    -- Denormalised so the list screen can order threads without a correlated
    -- subquery over every message in the school.
    last_message_at  timestamptz,
    closed_at        timestamptz,
    closed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT counselor_threads_subject CHECK (btrim(subject) <> ''),
    CONSTRAINT counselor_threads_status CHECK (status IN ('open', 'closed')),
    CONSTRAINT counselor_threads_urgency CHECK (urgency IN ('routine', 'normal', 'urgent')),
    CONSTRAINT counselor_threads_closed_pair
        CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX counselor_threads_student
    ON counselor_threads (institution_id, student_id, created_at DESC);

/* Who may read this thread. The whole access control, as rows.

   A row here is the only thing that grants sight of a message. Not a
   permission, not a role, not being the child's class teacher. The handler
   checks for a live row and nothing else, so widening access is an INSERT
   somebody has to make deliberately and which is visible on the screen to
   every other participant.

   removed_at rather than DELETE. A counsellor who left the thread in March
   read what was written before March, and deleting the row would make the
   record say they never had access -- the exact question asked when a family
   complains that something was repeated.

   added_reason is required for anyone brought in as an observer. It is the
   audit trail for the deliberate, narrow exception the design allows, and
   nothing else is allowed. */
CREATE TABLE counselor_thread_participants (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    thread_id      uuid NOT NULL REFERENCES counselor_threads(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- What they are in this conversation. 'observer' is the deliberate
    -- exception -- a safeguarding lead brought in on a disclosure -- and is
    -- the only role that may not write.
    role_in_thread text NOT NULL,
    added_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    added_reason   text,
    added_at       timestamptz NOT NULL DEFAULT now(),
    removed_at     timestamptz,
    removed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    -- Read receipts belong on the participant, not in a per-message table:
    -- the only question a screen asks is "anything new for me since I last
    -- looked", and a row per person per message answers it far more dearly.
    last_read_at   timestamptz,
    CONSTRAINT counselor_participants_role
        CHECK (role_in_thread IN ('parent', 'counselor', 'observer')),
    CONSTRAINT counselor_participants_removed_pair
        CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
    -- An observer is an exception and must be justified in writing.
    CONSTRAINT counselor_participants_observer_reason
        CHECK (role_in_thread <> 'observer' OR nullif(btrim(added_reason), '') IS NOT NULL)
);

/* One live membership per person per thread.

   Partial on removed_at IS NULL so that somebody removed and later brought
   back gets a second row and a second audit entry, rather than a resurrected
   first one that loses the gap in between. Both indexed columns are NOT NULL,
   so no COALESCE is needed. */
CREATE UNIQUE INDEX counselor_participants_one_live
    ON counselor_thread_participants (thread_id, user_id)
 WHERE removed_at IS NULL;

-- "Which threads may I see" -- the first query of every request on this
-- feature, and the one the whole design rests on.
CREATE INDEX counselor_participants_by_user
    ON counselor_thread_participants (institution_id, user_id)
 WHERE removed_at IS NULL;

COMMENT ON TABLE counselor_thread_participants IS
    'The readership of a counselling thread, as an explicit list. A live row here is the ONLY thing that grants sight of counselor_messages. No RBAC permission, role or teaching relationship is an alternative route -- see internal/api/comms.go.';

/* What was said.

   Stored as text the server can read. This is not end-to-end encrypted, and
   the catalogue's word "encrypted" is not delivered literally: doing so would
   need per-user keys the product has no way to hold or recover, and a family
   locked out of their own counselling history by a forgotten password is a
   worse outcome than the one it prevents. What is delivered is confidentiality
   against other users of the school, which is the threat a parent actually
   has. */
CREATE TABLE counselor_messages (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    thread_id      uuid NOT NULL REFERENCES counselor_threads(id) ON DELETE CASCADE,
    -- RESTRICT, not SET NULL: an unattributed message in a confidential
    -- thread is unusable as a record, and deleting a user is not a reason to
    -- rewrite what they said.
    sender_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    body           text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT counselor_messages_body CHECK (btrim(body) <> '')
);

CREATE INDEX counselor_messages_thread
    ON counselor_messages (thread_id, created_at);

/* Every change of readership, kept apart from the rows it describes.

   counselor_thread_participants already carries added_by and removed_by, so
   this is not the record of who is in the thread -- it is the record of the
   attempt, including the ones refused. Somebody who tried to reach a thread
   they are not in leaves nothing behind in the participants table at all, and
   that attempt is precisely what an investigation asks about. */
CREATE TABLE counselor_access_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    thread_id      uuid NOT NULL REFERENCES counselor_threads(id) ON DELETE CASCADE,
    actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    -- The person the action was about, where it was about somebody.
    target_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    action         text NOT NULL,
    reason         text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT counselor_access_events_action CHECK (action IN (
        'opened', 'participant_added', 'participant_removed',
        'access_refused', 'thread_closed', 'thread_reopened'))
);

CREATE INDEX counselor_access_events_thread
    ON counselor_access_events (thread_id, created_at DESC);

CREATE INDEX counselor_access_events_actor
    ON counselor_access_events (institution_id, actor_id, created_at DESC);

-- ==========================================================
-- 4. Tenancy
-- ==========================================================

-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'grievance_sla_policies', 'grievance_updates',
        'achievement_media',
        'counselor_threads', 'counselor_thread_participants',
        'counselor_messages', 'counselor_access_events'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (app_is_platform_admin() '
            'OR institution_id = app_current_institution()) WITH CHECK '
            '(app_is_platform_admin() OR institution_id = app_current_institution())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS counselor_access_events;
DROP TABLE IF EXISTS counselor_messages;
DROP TABLE IF EXISTS counselor_thread_participants;
DROP TABLE IF EXISTS counselor_threads;
DROP TABLE IF EXISTS achievement_media;
DROP TABLE IF EXISTS grievance_updates;
DROP TABLE IF EXISTS grievance_sla_policies;

DROP TRIGGER IF EXISTS student_achievements_touch ON student_achievements;
DROP INDEX IF EXISTS student_achievements_published;
ALTER TABLE student_achievements
    DROP CONSTRAINT IF EXISTS student_achievements_publish_needs_consent,
    DROP CONSTRAINT IF EXISTS student_achievements_published_pair,
    DROP CONSTRAINT IF EXISTS student_achievements_consent_basis_value,
    DROP CONSTRAINT IF EXISTS student_achievements_consent_complete,
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS consent_basis,
    DROP COLUMN IF EXISTS consent_confirmed_at,
    DROP COLUMN IF EXISTS consent_confirmed_by,
    DROP COLUMN IF EXISTS showcase_note,
    DROP COLUMN IF EXISTS published_by,
    DROP COLUMN IF EXISTS published_at,
    DROP COLUMN IF EXISTS is_published;

DROP INDEX IF EXISTS support_tickets_subject_employee;
DROP INDEX IF EXISTS support_tickets_school_queue;
ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS support_tickets_vendor_never_names_staff,
    DROP CONSTRAINT IF EXISTS support_tickets_satisfaction_range,
    DROP COLUMN IF EXISTS satisfaction_at,
    DROP COLUMN IF EXISTS satisfaction_note,
    DROP COLUMN IF EXISTS satisfaction,
    DROP COLUMN IF EXISTS resolved_by,
    DROP COLUMN IF EXISTS escalated_to,
    DROP COLUMN IF EXISTS escalated_at,
    DROP COLUMN IF EXISTS acknowledged_at,
    DROP COLUMN IF EXISTS resolve_due_at,
    DROP COLUMN IF EXISTS respond_due_at,
    DROP COLUMN IF EXISTS owner_department,
    DROP COLUMN IF EXISTS subject_employee_id;
