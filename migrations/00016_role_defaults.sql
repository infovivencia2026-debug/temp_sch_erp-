-- +goose Up
-- Which roles a new school opens with.
--
-- Twenty-two seeded roles is the right vocabulary for a 3,000-child group with
-- a separate examination controller, hostel warden and discipline officer. It
-- is the wrong opening position for the school this product actually sells to,
-- where one senior teacher is all three and the person doing the setup has no
-- way to tell which of the twenty-two matter to them.
--
-- The fix is a default set, not a smaller set. Every role stays in the
-- product; the optional ones are installed on request instead of arriving
-- unasked. Schools already running are untouched by design — this migration
-- only labels existing rows, and rbac.SeedInstitution re-seeds any role a
-- school already has regardless of its label, so nothing loses a grant and no
-- user loses an assignment.

ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN roles.is_default IS
    'Seeded into newly provisioned schools. False = available as a preset. '
    'Purely advisory to the seeder; it never removes a role a school already has.';

-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

-- The label matches rbac.optionalRoles. Kept in step by
-- TestOptionalRolesMatchMigration, which fails if the two lists drift.
UPDATE roles SET is_default = false
 WHERE is_system
   AND key IN (
        'support_admin', 'vice_principal', 'hod', 'it_admin',
        'exam_controller', 'front_office', 'operations',
        'librarian', 'transport_manager', 'hostel_warden',
        'driver', 'counsellor', 'nurse',
        'discipline_officer', 'activity_coord');

-- A custom role a school built for itself is by definition not part of the
-- default set, and labelling it otherwise would offer it to every new tenant.
UPDATE roles SET is_default = false WHERE NOT is_system;

-- +goose Down
ALTER TABLE roles DROP COLUMN IF EXISTS is_default;
