-- +goose Up
-- Whose vendor account this school's SMS and WhatsApp actually leave through.
--
-- Two routes, and until now the answer was implied rather than stored. A school
-- either had its own provider configured, in which case it sent by that, or it
-- did not, in which case it sent by nothing at all.
--
--   'own'       the school's linked vendor. It holds the contract and the DLT
--               registration and pays that vendor. Only the top pack may
--               choose this; nothing here meters it unless somebody sets a
--               ceiling deliberately.
--
--   'edu_cloud' our account. We hold the vendor relationship and the bill, and
--               the school pays with credits. Always metered, because the
--               money is ours.
--
-- The top pack may pick either, per channel: a school can perfectly well hold
-- its own SMS contract, which is the one that needs a DLT registration and
-- weeks of paperwork, while letting WhatsApp go through us. Storing this per
-- channel rather than per school is what makes that possible, and it costs one
-- extra column.
--
-- The lower packs have no choice to store: they are edu_cloud whatever this
-- table says, enforced where it is read rather than by a constraint here, so
-- that a school moving up a pack keeps a choice it made earlier.

CREATE TABLE IF NOT EXISTS message_routing (
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    channel        text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
    route          text NOT NULL CHECK (route IN ('own', 'edu_cloud')),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (institution_id, channel)
);

ALTER TABLE message_routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_routing FORCE ROW LEVEL SECURITY;
CREATE POLICY message_routing_tenant ON message_routing
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON message_routing TO app_user;

-- +goose Down
DROP TABLE IF EXISTS message_routing;
