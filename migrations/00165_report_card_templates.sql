-- +goose Up

/* The school's own report card, not this product's.
 *
 * A report card is the one document a family keeps. Every school has a design
 * for it — the crest, the motto, the grade scale printed down the side, the
 * two signature lines — and a school that cannot print its own is a school
 * that keeps using the stationer's and types the marks in twice.
 *
 * So the layout is a row here, not a component in the front end: an HTML body
 * with {{placeholders}}, the same shape certificate_types already uses for
 * transfer and bonafide certificates. One per institution, because a school
 * has one report card. Changing it changes what prints next; until somebody
 * changes it, every card generated uses the one that is here.
 *
 * WHY THERE IS NO ROW SEEDED HERE
 *
 * The built-in design lives in Go (internal/api/report_card_templates.go) and
 * is served whenever this table is empty. A seeded copy would be a fork the
 * day the built-in is improved: schools that never touched their template
 * would be pinned to whatever this migration wrote, and the improvement would
 * reach nobody. Empty means "the current default", which is a live answer.
 */
CREATE TABLE IF NOT EXISTS report_card_templates (
    institution_id uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    -- What the school calls it. Shown on the screen so somebody who imported
    -- two files in a week can tell which one is live.
    name          text NOT NULL DEFAULT 'School report card',
    template_html text NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE report_card_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_card_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON report_card_templates;
CREATE POLICY tenant_isolation ON report_card_templates
    USING (app_is_platform_admin() OR institution_id = app_current_institution());

/* Who the published card went to, and how.
 *
 * "The parents were told" is a claim a school has to be able to stand behind
 * when a family says they never heard. The notification table records the
 * in-app alert; this records the choice the head made — students, guardians or
 * both, over which channels — so the answer to "who was told" survives the
 * term. */
ALTER TABLE report_cards
    ADD COLUMN IF NOT EXISTS published_to       text,
    ADD COLUMN IF NOT EXISTS published_channels text;

-- +goose Down
ALTER TABLE report_cards
    DROP COLUMN IF EXISTS published_channels,
    DROP COLUMN IF EXISTS published_to;
DROP TABLE IF EXISTS report_card_templates;
