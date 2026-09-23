-- +goose Up
-- The school may answer a parent in the teacher's thread.
--
-- A principal reading the All messages desk replied to a parent and got
-- "something went wrong": the thread's check constraint allowed only the
-- parent or the teacher as a sender, written when those were the only two
-- people who could reach the table. The desk now sends replies in the
-- principal's own name, with the sender's name on the bubble and the teacher
-- copied, so a third school-side sender is the feature, not a forgery.
--
-- The rule the constraint protected still holds, now as a trigger because it
-- has to look at another table: nobody but the parent may write as the
-- parent, and a sender who is neither party must be a member of the school's
-- staff -- a user holding a role in this institution. A parent's account
-- holds no staff role, so a parent can never be written into somebody else's
-- thread, which is the forgery the original check was there to stop.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION parent_teacher_messages_sender_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.sender_user_id IN (NEW.parent_user_id, NEW.teacher_user_id) THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        SELECT 1
          FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = NEW.sender_user_id
           AND COALESCE(ur.institution_id, r.institution_id) = NEW.institution_id
           AND r.key <> 'parent'
    ) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'sender % is neither a party to this thread nor school staff', NEW.sender_user_id
        USING ERRCODE = 'check_violation';
END
$$;
-- +goose StatementEnd

ALTER TABLE parent_teacher_messages
    DROP CONSTRAINT IF EXISTS parent_teacher_messages_sender_in_thread;

CREATE TRIGGER parent_teacher_messages_sender_check
    BEFORE INSERT OR UPDATE OF sender_user_id ON parent_teacher_messages
    FOR EACH ROW EXECUTE FUNCTION parent_teacher_messages_sender_check();

-- +goose Down
DROP TRIGGER IF EXISTS parent_teacher_messages_sender_check ON parent_teacher_messages;
DROP FUNCTION IF EXISTS parent_teacher_messages_sender_check();
ALTER TABLE parent_teacher_messages
    ADD CONSTRAINT parent_teacher_messages_sender_in_thread
        CHECK (sender_user_id IN (parent_user_id, teacher_user_id));
