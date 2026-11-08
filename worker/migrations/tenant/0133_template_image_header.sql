-- 0133_template_image_header (tenant: every school database).
-- Whether a WhatsApp template was approved with a picture header. Only such a
-- template may carry a header picture; every template defaults to none.
--
-- Forward-only: once applied anywhere this file must not change.
ALTER TABLE message_templates ADD COLUMN has_image_header INTEGER NOT NULL DEFAULT 0;
