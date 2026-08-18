-- +goose Up
-- The two things a family needs that nothing in the schema already holds.
--
-- Most of the parent portal is a narrower view of tables that already exist:
-- leave_requests carries student leave and same-day absence, support_tickets
-- carries a grievance, issued_certificates carries a bonafide request,
-- student_documents carries the file, payments carries the receipt. Those are
-- reused rather than copied — a second table holding the same fact is only ever
-- the one that disagrees.
--
-- What is genuinely absent is a delegated pickup and a two-way conversation.

/* Somebody other than the parent, allowed to collect a child once.

   The paper version of this is a phone call to the front desk — "my driver is
   coming instead today" — and it is the single most abused channel a school
   has, because the person at the desk cannot tell a driver from a stranger who
   has learnt a child's name and class.

   Three properties make this safer than the phone call, and each is a column
   rather than a convention:

     the code      the collector must produce a number the school never told
                   them; only the parent's app did
     valid_on      a pass that never expires is a permanent key to a child, so
                   there is no open-ended option, not even a nullable one
     used_at       once the child has been released the pass is spent, and a
                   second person producing the same code is refused

   revoked_at is separate from used_at because "I have changed my mind" and
   "the child has gone" must not be recorded as the same event when a custody
   dispute later asks which happened. */
CREATE TABLE emergency_pickup_authorisations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- The guardian who delegated. Not nullable: an authorisation nobody owns is
    -- exactly the record that cannot be defended afterwards.
    authorised_by   uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    full_name       text        NOT NULL,
    phone           text        NOT NULL,
    relation        text        NOT NULL,
    id_type         text,
    id_last4        text,
    -- What the collector recites at the gate. Unique for the life of the
    -- institution, not merely among live passes, so a code that once released a
    -- child is never handed to a second person.
    code            text        NOT NULL,
    valid_on        date        NOT NULL,
    reason          text        NOT NULL,
    used_at         timestamptz,
    -- The staff member who released the child, kept even after the pass is
    -- spent. "Who let them go" is the first question asked when it was wrong.
    released_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT emergency_pickup_code_format CHECK (code ~ '^[0-9]{6}$'),
    -- A released pass names who released it; a pass with a releaser and no time
    -- is a half-written record of a child leaving.
    CONSTRAINT emergency_pickup_release_complete
        CHECK ((used_at IS NULL) = (released_by IS NULL)),
    -- Revoking after the child has gone is not a revocation, it is a fiction.
    CONSTRAINT emergency_pickup_not_both
        CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX emergency_pickup_code
    ON emergency_pickup_authorisations (institution_id, code);

/* One live pass per person per child per day.

   A parent tapping the button twice must not put two valid codes for the same
   driver into circulation — the second would still open the gate after the
   first was spent. id_last4 is nullable and would silently void this index if
   it were part of the key, which is why the identity is the name and the day.

   The predicate is what makes it "live": yesterday's spent pass does not block
   today's, and a revoked one does not block its replacement. */
CREATE UNIQUE INDEX emergency_pickup_one_live
    ON emergency_pickup_authorisations
       (institution_id, student_id, lower(full_name), valid_on)
 WHERE used_at IS NULL AND revoked_at IS NULL;

-- The gate's question: which passes are good today.
CREATE INDEX emergency_pickup_today
    ON emergency_pickup_authorisations (institution_id, valid_on)
 WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX emergency_pickup_child
    ON emergency_pickup_authorisations (student_id, valid_on DESC);

/* A message between one guardian and one teacher about one child.

   announcements broadcast to a section and message_log records an SMS the
   system sent; neither is a conversation, and a parent replying to either has
   nowhere to put the reply.

   There is no thread table. A thread is every row sharing the same
   (student, parent, teacher) triple, which is the only way these three
   identities can be paired — a parent does not message a teacher in the
   abstract, they message them about a child. A separate threads table would
   add a join and a second place for the triple to be wrong.

   read_at is the recipient's, and it is why a teacher can tell an unanswered
   message from an unread one. */
CREATE TABLE parent_teacher_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- The two ends of the thread, stored on every row rather than derived from
    -- the sender, so that reading one end's messages does not depend on knowing
    -- which end sent them.
    parent_user_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    teacher_user_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_user_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            text        NOT NULL,
    sent_at         timestamptz NOT NULL DEFAULT now(),
    read_at         timestamptz,
    CONSTRAINT parent_teacher_messages_body
        CHECK (nullif(btrim(body), '') IS NOT NULL),
    -- The sender has to be one of the two people in the thread. Without this a
    -- third party's id in sender_user_id would render as though the teacher or
    -- the parent had said it.
    CONSTRAINT parent_teacher_messages_sender_in_thread
        CHECK (sender_user_id IN (parent_user_id, teacher_user_id))
);

-- The thread, newest last. Also the index the unread count reads.
CREATE INDEX parent_teacher_messages_thread
    ON parent_teacher_messages
       (institution_id, student_id, parent_user_id, teacher_user_id, sent_at);

CREATE INDEX parent_teacher_messages_unread
    ON parent_teacher_messages (institution_id, teacher_user_id)
 WHERE read_at IS NULL;

ALTER TABLE emergency_pickup_authorisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_pickup_authorisations FORCE ROW LEVEL SECURITY;
ALTER TABLE parent_teacher_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_teacher_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY emergency_pickup_authorisations_tenant ON emergency_pickup_authorisations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY parent_teacher_messages_tenant ON parent_teacher_messages
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS parent_teacher_messages;
DROP TABLE IF EXISTS emergency_pickup_authorisations;
