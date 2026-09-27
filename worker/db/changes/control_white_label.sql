-- control_white_label (CONTROL D1 only). Each school looks like its own
-- product: its sign-in page at /<country>/<slug>, or on its own domain, with
-- its own logo, colours and words. Set by the seller in Tenants → Branding.
ALTER TABLE institutions ADD COLUMN country TEXT NOT NULL DEFAULT 'in';
ALTER TABLE institutions ADD COLUMN accent_color TEXT;
ALTER TABLE institutions ADD COLUMN tagline TEXT;
ALTER TABLE institutions ADD COLUMN login_headline TEXT;
ALTER TABLE institutions ADD COLUMN login_message TEXT;
ALTER TABLE institutions ADD COLUMN support_email TEXT;
ALTER TABLE institutions ADD COLUMN support_phone TEXT;
ALTER TABLE institutions ADD COLUMN custom_domain TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS institutions_custom_domain ON institutions (custom_domain COLLATE NOCASE) WHERE custom_domain IS NOT NULL;
