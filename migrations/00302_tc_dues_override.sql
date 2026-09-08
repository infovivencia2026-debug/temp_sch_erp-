-- +goose Up

/* A transfer certificate is refused while fees are owed, unless somebody
 * overrides it and is named for doing so.
 *
 * The snapshot only ever RECORDED the dues; nothing stopped the issue. The
 * staff side blocks settlement in the database until clearance is signed
 * off; a child could leave with a term's fees owing and the school's only
 * record was a number on a paper it had already handed over. The override
 * exists because a head does sometimes let a family go -- a transfer on
 * compassionate grounds, a fee dispute settled by waiver -- and that decision
 * needs a name and a reason against it, not a silent zero. */
ALTER TABLE issued_certificates
    ADD COLUMN IF NOT EXISTS dues_override_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS dues_override_at     timestamptz,
    ADD COLUMN IF NOT EXISTS dues_override_reason text,
    ADD CONSTRAINT issued_certificates_override_reasoned
        CHECK (dues_override_by IS NULL OR btrim(coalesce(dues_override_reason,'')) <> '');

-- +goose Down
ALTER TABLE issued_certificates
    DROP CONSTRAINT IF EXISTS issued_certificates_override_reasoned,
    DROP COLUMN IF EXISTS dues_override_reason,
    DROP COLUMN IF EXISTS dues_override_at,
    DROP COLUMN IF EXISTS dues_override_by;
