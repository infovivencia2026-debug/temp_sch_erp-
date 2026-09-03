-- +goose Up
-- Email gets the same choice, and only the choice.
--
-- A school can perfectly well want its circulars and receipts to leave from its
-- own mail server — its own domain, its own reputation, its own retention —
-- while letting SMS go through us. That is the same decision message_routing
-- already stores for the paid channels, so it is the same table.
--
-- What email does NOT get is a meter. It costs nothing per message: an SMTP
-- send is a connection, not a unit somebody is billed for. Metering it would
-- mean a school unable to send a fee receipt for want of a credit, which is
-- absurd, and the credits code keeps its own shorter list for exactly that
-- reason.
--
-- So the constraint widens and nothing else changes.

ALTER TABLE message_routing DROP CONSTRAINT IF EXISTS message_routing_channel_check;
ALTER TABLE message_routing
    ADD CONSTRAINT message_routing_channel_check
    CHECK (channel IN ('sms', 'whatsapp', 'email'));

-- +goose Down
ALTER TABLE message_routing DROP CONSTRAINT IF EXISTS message_routing_channel_check;
DELETE FROM message_routing WHERE channel = 'email';
ALTER TABLE message_routing
    ADD CONSTRAINT message_routing_channel_check
    CHECK (channel IN ('sms', 'whatsapp'));
