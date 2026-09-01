-- +goose Up

/* Every school gets the departments a leaver is signed out of.
 *
 * 00031 raised these eight rows in a loop over `institutions` — the schools
 * that existed at the moment it ran. Nothing has seeded them since: there is
 * no create endpoint, and provisionSchool never wrote the table. So every
 * school opened after 00031 has none, permanently.
 *
 * The consequence is not a blank panel. Both gates count what is unsigned:
 *
 *     SELECT count(*) FROM exit_clearances
 *      WHERE exit_id = $1 AND status <> 'cleared'
 *
 * With no departments the exit has no clearance rows, the count is zero, and
 * the rule that exists to stop a settlement outrunning the library reads as
 * "nothing outstanding" and lets it through. A school could pay a final
 * settlement to somebody still holding its laptop, and the screen would say
 * `0 of 0` as though that were a completed checklist.
 *
 * So: backfill the schools that have none. ON CONFLICT DO NOTHING is not
 * enough on its own here — a school that has deliberately renamed or disabled
 * a department must not have the original re-inserted underneath it, and code
 * is the conflict target, so the NOT EXISTS guard skips any institution that
 * has already been asked the question at all.
 */
-- +goose StatementBegin
DO $$
DECLARE inst uuid;
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);
    FOR inst IN
        SELECT i.id FROM institutions i
         WHERE NOT EXISTS (SELECT 1 FROM clearance_departments c
                            WHERE c.institution_id = i.id)
    LOOP
        INSERT INTO clearance_departments (institution_id, code, name, sequence)
        VALUES (inst, 'library',   'Library',              10),
               (inst, 'lab',       'Science laboratories', 20),
               (inst, 'it',        'IT and devices',       30),
               (inst, 'stores',    'Stores and stationery',40),
               (inst, 'hostel',    'Hostel',               50),
               (inst, 'transport', 'Transport',            60),
               (inst, 'finance',   'Accounts',             70),
               (inst, 'hr',        'HR and records',       80);
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
-- Deliberately empty. Removing a department would orphan the exit_clearances
-- rows raised against it, and those are the record of who signed what.
SELECT 1;
