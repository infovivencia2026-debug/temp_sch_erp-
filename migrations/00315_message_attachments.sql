-- +goose Up
-- Attachments for an outbound message, so a send can carry files.
--
-- message_log has always been a single body of text: a subject and a body, and
-- nothing a reader could open. The scheduled report digest needs more than
-- that -- it wants to hand the people who steer the school a PDF summary and
-- the underlying data as CSV files, attached to the email the digest already
-- sends. Rather than teach message_log about files (most messages have none),
-- the files live in their own table, one row per attachment, tied to the
-- message they ride on.
--
-- Email only, by convention rather than by constraint: the dispatcher loads
-- these onto the OutboundMessage only for the email channel, because SMS,
-- WhatsApp and in-app have no envelope to put a file in. The bytes are stored
-- inline (bytea) because a digest's PDF and a handful of CSVs are small and
-- keeping them in the same tenant-isolated table as the message is simpler than
-- a blob store this deployment does not have.
CREATE TABLE IF NOT EXISTS message_attachments (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL,
    -- The message this file rides on. ON DELETE CASCADE so purging a message
    -- log row takes its attachments with it rather than leaving orphans.
    message_log_id uuid        NOT NULL REFERENCES message_log(id) ON DELETE CASCADE,
    filename       text        NOT NULL,
    content_type   text        NOT NULL,
    bytes          bytea       NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE message_attachments IS
    'Files attached to an outbound message, loaded onto the OutboundMessage by the dispatcher for the email channel only. Written by QueueMessage when an email SendRequest carries attachments; used today by the scheduled report digest (a PDF summary plus CSV data files).';

-- Loaded by message: the dispatcher reads every attachment for one message_log
-- row before it sends.
CREATE INDEX IF NOT EXISTS message_attachments_message_log_id_idx
    ON message_attachments (message_log_id);

ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attachments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_attachments_tenant ON message_attachments;
CREATE POLICY message_attachments_tenant ON message_attachments
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON message_attachments TO app_user;

-- +goose Down
DROP TABLE IF EXISTS message_attachments;
