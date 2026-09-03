-- +goose Up
-- A school asking for more messages, and the record of who granted it.
--
-- Credits are added by hand: no money moves through this product, and the
-- school's payment happens somewhere this system does not watch. What was
-- missing was the other half of that — the school had no way to ASK. A head
-- teacher whose reminders had stopped could see a balance of zero and a
-- top-up form they have no permission to use, and the next step was a phone
-- call nobody recorded.
--
-- So the request is a row. It gives the school a button that does something,
-- gives the seller a queue rather than a memory of a conversation, and leaves
-- an audit trail joining "they asked for ten thousand" to "we granted eight".
--
-- DELIBERATELY NOT A PAYMENT. There is no gateway here and no price on this
-- table. The amount is a number of MESSAGES, because that is the only unit
-- both sides can check against the same evidence; what it cost, and whether it
-- was paid, live in whatever the seller invoices with.

CREATE TABLE IF NOT EXISTS message_credit_requests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    channel        text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),

    -- How many messages were asked for. Positive: a request to remove credits
    -- is not a thing anybody does, and allowing it here would make this table
    -- a second way to change a balance.
    messages integer NOT NULL CHECK (messages > 0),

    -- pending | granted | declined | cancelled.
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'granted', 'declined', 'cancelled')),

    -- What the school said, and what the seller said back. Both optional and
    -- both free text: this is a conversation, and forcing it into codes would
    -- lose the only part anybody rereads.
    note     text,
    response text,

    requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),

    -- How many were actually granted, which is not always how many were asked
    -- for. Stored rather than assumed equal to `messages`, so a partial grant
    -- is legible a year later.
    granted    integer CHECK (granted IS NULL OR granted >= 0),
    decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at timestamptz
);

-- One open request per channel, so a school that presses the button twice does
-- not produce two grants for one need. Partial, because settled requests are
-- history and there may be any number of them.
CREATE UNIQUE INDEX IF NOT EXISTS message_credit_requests_one_open
    ON message_credit_requests (institution_id, channel)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS message_credit_requests_pending
    ON message_credit_requests (requested_at) WHERE status = 'pending';

ALTER TABLE message_credit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_credit_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY message_credit_requests_tenant ON message_credit_requests
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON message_credit_requests TO app_user;

-- +goose Down
DROP TABLE IF EXISTS message_credit_requests;
