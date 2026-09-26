-- +goose Up
/* The DLT account and the MSG91 account are WISEN's, for every school.

   00344 shaped the SMS channel on Yajur's own row and routed the school to
   its own account. That was the wrong owner: the entity, the header and the
   MSG91 account are held by WISEN and send on behalf of every school, which
   is the 'edu_cloud' route that already exists, metered by credits. So the
   channel moves to the platform's row (institution_id NULL), Yajur's copy is
   removed unless somebody has already typed a key into it, and the school's
   'own' choice is withdrawn so it falls back to ours.

   The templates seeded by 00344 stay where they are: they are the school's
   wording, approved under this entity, and the route does not change which
   template a message is rendered from. */
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO integrations (institution_id, provider, kind, config, credentials, enabled)
VALUES (NULL, 'sms', 'messaging',
        jsonb_build_object(
          'endpoint', 'https://api.msg91.com/api/sendhttp.php',
          'method', 'GET',
          'encoding', 'form',
          'sender_id', 'YAJURS',
          'dlt_entity_id', '1701172544496584296',
          'dlt_entity_name', 'MEGHAA EDUCATIONAL SOCIETY',
          'params', jsonb_build_object(
             'authkey', '{key}', 'mobiles', '{to}', 'message', '{text}',
             'sender', '{sender}', 'route', '4', 'country', '91',
             'DLT_TE_ID', '{dlt}')),
        NULL, false)
ON CONFLICT (provider) WHERE institution_id IS NULL DO UPDATE
   SET config = integrations.config
                || jsonb_build_object('dlt_entity_id', '1701172544496584296',
                                      'dlt_entity_name', 'MEGHAA EDUCATIONAL SOCIETY')
                || CASE WHEN COALESCE(integrations.config->>'sender_id', '') = ''
                        THEN jsonb_build_object('sender_id', 'YAJURS') ELSE '{}'::jsonb END;

DELETE FROM integrations i
 USING institutions s
 WHERE i.institution_id = s.id AND s.name ILIKE 'yajur public school%'
   AND i.provider = 'sms' AND i.kind = 'messaging'
   AND i.credentials IS NULL
   AND i.config->>'dlt_entity_id' = '1701172544496584296';

DELETE FROM message_routing r
 USING institutions s
 WHERE r.institution_id = s.id AND s.name ILIKE 'yajur public school%'
   AND r.channel = 'sms';

-- +goose Down
SELECT 1;
