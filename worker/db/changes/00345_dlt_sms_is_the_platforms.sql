-- 00345_dlt_sms_is_the_platforms (tenant D1, data only; apply to EVERY school
-- database, since each holds a copy of the platform's institution_id NULL rows).
-- SQLite's UNIQUE(institution_id, provider) never conflicts on NULL, so the
-- platform row is inserted if absent, then updated.

INSERT INTO integrations (institution_id, provider, kind, config, credentials, enabled)
SELECT NULL, 'sms', 'messaging',
       json_object('endpoint', 'https://api.msg91.com/api/sendhttp.php', 'method', 'GET', 'encoding', 'form',
         'sender_id', 'YAJURS', 'dlt_entity_id', '1701172544496584296',
         'dlt_entity_name', 'MEGHAA EDUCATIONAL SOCIETY',
         'params', json_object('authkey', '{key}', 'mobiles', '{to}', 'message', '{text}',
            'sender', '{sender}', 'route', '4', 'country', '91', 'DLT_TE_ID', '{dlt}')),
       NULL, 0
 WHERE NOT EXISTS (SELECT 1 FROM integrations WHERE institution_id IS NULL AND provider = 'sms');

UPDATE integrations
   SET config = json_set(config,
         '$.dlt_entity_id', '1701172544496584296',
         '$.dlt_entity_name', 'MEGHAA EDUCATIONAL SOCIETY',
         '$.sender_id', CASE WHEN COALESCE(json_extract(config, '$.sender_id'), '') = ''
                             THEN 'YAJURS' ELSE json_extract(config, '$.sender_id') END)
 WHERE institution_id IS NULL AND provider = 'sms';

DELETE FROM integrations
 WHERE institution_id IN (SELECT id FROM institutions WHERE name LIKE 'yajur public school%')
   AND provider = 'sms' AND kind = 'messaging'
   AND credentials IS NULL
   AND json_extract(config, '$.dlt_entity_id') = '1701172544496584296';

DELETE FROM message_routing
 WHERE institution_id IN (SELECT id FROM institutions WHERE name LIKE 'yajur public school%')
   AND channel = 'sms';
