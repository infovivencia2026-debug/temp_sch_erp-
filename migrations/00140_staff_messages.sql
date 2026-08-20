-- +goose Up
-- A principal talking to their own staff.
--
-- The product had three messaging channels and none of them was this one. A
-- parent can write to their child's teacher, a counsellor has a private
-- thread, and a class has a homework forum — but a principal wanting to ask
-- one head of department about Thursday had nowhere to do it, and the
-- catalogue entry that claimed otherwise opened the circular composer, which
-- broadcasts to the school.
--
-- Deliberately not a copy of parent_teacher_messages. That table stores a
-- triple — parent, teacher, and the child it is about — because a parent does
-- not message a teacher in the abstract. Two members of staff do: the subject
-- is the school, and forcing a child onto the row would mean inventing one.
--
-- Both ends are stored on every row rather than derived from the sender, so
-- reading one side of a conversation does not depend on knowing which side
-- sent each message.

CREATE TABLE IF NOT EXISTS staff_messages (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- The two people in the conversation, in a stable order so a thread is one
    -- pair and not two: the lower uuid first. Without it, A-to-B and B-to-A
    -- are different threads and each person sees half a conversation.
    party_a        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    party_b        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    sender_user_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body           text        NOT NULL,
    sent_at        timestamptz NOT NULL DEFAULT now(),
    read_at        timestamptz,

    CONSTRAINT staff_messages_body_present
        CHECK (nullif(btrim(body), '') IS NOT NULL),
    -- The sender has to be one of the two. Without this a third party's id
    -- renders as though one of them had said it.
    CONSTRAINT staff_messages_sender_in_thread
        CHECK (sender_user_id IN (party_a, party_b)),
    -- Ordered, so the pair is the thread key.
    CONSTRAINT staff_messages_party_order CHECK (party_a < party_b)
);

CREATE INDEX IF NOT EXISTS staff_messages_thread
    ON staff_messages (institution_id, party_a, party_b, sent_at);

-- The unread count reads this.
CREATE INDEX IF NOT EXISTS staff_messages_unread
    ON staff_messages (institution_id, party_b, party_a)
 WHERE read_at IS NULL;

ALTER TABLE staff_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_messages FORCE ROW LEVEL SECURITY;

-- Tenant isolation only. Which of a school's threads a given person may read
-- is the handler's business, because it depends on whether they are one of the
-- two people in it.
CREATE POLICY staff_messages_tenant ON staff_messages
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS staff_messages;
