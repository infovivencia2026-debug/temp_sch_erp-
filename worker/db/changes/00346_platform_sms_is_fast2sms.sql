-- 00346_platform_sms_is_fast2sms (tenant D1, data only; apply to EVERY school
-- database after 00345). Reshapes the platform SMS row to Fast2SMS dlt_manual.
UPDATE integrations
   SET config = json_set(config,
         '$.endpoint', 'https://www.fast2sms.com/dev/bulkV2',
         '$.method', 'POST',
         '$.encoding', 'form',
         '$.params', json_object('authorization', '{key}', 'route', 'dlt_manual',
            'sender_id', '{sender}', 'message', '{text}',
            'template_id', '{dlt}', 'entity_id', '{entity}',
            'numbers', '{to}', 'flash', '0'))
 WHERE institution_id IS NULL AND provider = 'sms' AND kind = 'messaging'
   AND (credentials IS NULL OR json_extract(config, '$.endpoint') LIKE '%msg91%');
