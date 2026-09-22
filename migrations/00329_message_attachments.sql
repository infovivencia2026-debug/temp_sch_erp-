-- +goose Up
/* Attachments on messages.

   A photo of the homework, the fee receipt, a PDF from the counsellor: every
   chat in the product was text only, and a parent sent the picture on
   WhatsApp instead, where the school cannot see it. Each message now
   carries a list of files -- id, name, size, type -- pointing at rows in
   files, which is where uploads already land (POST /api/v1/files). The
   list is jsonb rather than a join table because it is read with the
   message and never queried on its own. */
ALTER TABLE staff_messages          ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE parent_teacher_messages ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE counselor_messages      ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A message may be a file with no words: the body check on each table
-- required words. Relax it to "words or a file".
ALTER TABLE staff_messages DROP CONSTRAINT IF EXISTS staff_messages_body_present;
ALTER TABLE staff_messages ADD CONSTRAINT staff_messages_body_present
    CHECK (nullif(btrim(body), '') IS NOT NULL OR jsonb_array_length(attachments) > 0);
ALTER TABLE parent_teacher_messages DROP CONSTRAINT IF EXISTS parent_teacher_messages_body;
ALTER TABLE parent_teacher_messages ADD CONSTRAINT parent_teacher_messages_body
    CHECK (nullif(btrim(body), '') IS NOT NULL OR jsonb_array_length(attachments) > 0);
ALTER TABLE counselor_messages DROP CONSTRAINT IF EXISTS counselor_messages_body;
ALTER TABLE counselor_messages ADD CONSTRAINT counselor_messages_body
    CHECK (nullif(btrim(body), '') IS NOT NULL OR jsonb_array_length(attachments) > 0);

-- The interaction log reads these three by time across the school.
CREATE INDEX IF NOT EXISTS staff_messages_inst_time_idx ON staff_messages (institution_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS parent_teacher_messages_inst_time_idx ON parent_teacher_messages (institution_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS counselor_messages_inst_time_idx ON counselor_messages (institution_id, created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS counselor_messages_inst_time_idx;
DROP INDEX IF EXISTS parent_teacher_messages_inst_time_idx;
DROP INDEX IF EXISTS staff_messages_inst_time_idx;
ALTER TABLE counselor_messages DROP CONSTRAINT IF EXISTS counselor_messages_body;
ALTER TABLE counselor_messages ADD CONSTRAINT counselor_messages_body CHECK (nullif(btrim(body), '') IS NOT NULL);
ALTER TABLE parent_teacher_messages DROP CONSTRAINT IF EXISTS parent_teacher_messages_body;
ALTER TABLE parent_teacher_messages ADD CONSTRAINT parent_teacher_messages_body CHECK (nullif(btrim(body), '') IS NOT NULL);
ALTER TABLE staff_messages DROP CONSTRAINT IF EXISTS staff_messages_body_present;
ALTER TABLE staff_messages ADD CONSTRAINT staff_messages_body_present CHECK (nullif(btrim(body), '') IS NOT NULL);
ALTER TABLE counselor_messages DROP COLUMN IF EXISTS attachments;
ALTER TABLE parent_teacher_messages DROP COLUMN IF EXISTS attachments;
ALTER TABLE staff_messages DROP COLUMN IF EXISTS attachments;
