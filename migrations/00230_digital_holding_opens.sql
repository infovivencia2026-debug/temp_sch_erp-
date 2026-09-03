-- +goose Up

-- Every time somebody opens a digital holding through this product.
--
-- The librarian's question is whether the e-books and journals the school
-- pays for are being read, and until now nothing in the building could answer
-- it: an open was a redirect and nothing more. This is the one row an open
-- leaves behind. It counts opens made through the catalogue here; a vendor
-- platform's own statistics are the vendor's and are not invented from this.
CREATE TABLE digital_holding_opens (
    id              bigserial PRIMARY KEY,
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    holding_id      uuid NOT NULL REFERENCES digital_holdings(id) ON DELETE CASCADE,
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    opened_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX digital_holding_opens_by_month
    ON digital_holding_opens (institution_id, opened_at DESC);
CREATE INDEX digital_holding_opens_by_holding
    ON digital_holding_opens (holding_id, opened_at DESC);

ALTER TABLE digital_holding_opens ENABLE ROW LEVEL SECURITY;
ALTER TABLE digital_holding_opens FORCE  ROW LEVEL SECURITY;
CREATE POLICY digital_holding_opens_tenant ON digital_holding_opens
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON digital_holding_opens TO app_user;
GRANT USAGE, SELECT ON SEQUENCE digital_holding_opens_id_seq TO app_user;

-- +goose Down

DROP TABLE IF EXISTS digital_holding_opens;
