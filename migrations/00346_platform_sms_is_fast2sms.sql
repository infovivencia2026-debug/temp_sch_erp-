-- +goose Up
/* The platform's SMS vendor is Fast2SMS, not MSG91.

   The owner already holds a Fast2SMS account, so the channel shaped by
   00345 is reshaped to Fast2SMS's DLT manual route, which takes the text,
   the DLT template id and the entity id with each message. The header and
   the entity are kept as they are; the key is still typed on the screen
   and the channel stays disabled until then. A key already stored is not
   touched, and a channel someone has since pointed elsewhere by hand
   (a different endpoint with a key) is left alone. */
SET LOCAL app.is_platform_admin = 'on';

UPDATE integrations
   SET config = config || jsonb_build_object(
         'endpoint', 'https://www.fast2sms.com/dev/bulkV2',
         'method', 'POST',
         'encoding', 'form',
         'params', jsonb_build_object(
            'authorization', '{key}', 'route', 'dlt_manual',
            'sender_id', '{sender}', 'message', '{text}',
            'template_id', '{dlt}', 'entity_id', '{entity}',
            'numbers', '{to}', 'flash', '0'))
 WHERE institution_id IS NULL AND provider = 'sms' AND kind = 'messaging'
   AND (credentials IS NULL OR config->>'endpoint' LIKE '%msg91%');

-- +goose Down
SELECT 1;
