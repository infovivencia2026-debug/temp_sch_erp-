-- +goose Up
-- A head of department stops being optional.
--
-- 00016 labelled hod as a preset a school could install if it wanted one, on
-- the reasoning that a small school has no departments and should not be shown
-- a role it will never fill. That was defensible while the role did nothing a
-- principal could not do.
--
-- It stopped being defensible when timetable assignment, cover allocation,
-- faculty allocation and departmental leave approval were moved to that desk.
-- A workflow whose owning role has to be created first is a workflow nobody
-- finds: eight of the nine schools on this installation had no hod row at all,
-- so those four screens existed and were reachable by nobody.
--
-- Seeding a role does not staff it. A school with no departments gets an empty
-- role in a list, which costs one line; the alternative cost them the feature.

-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

UPDATE roles SET is_default = true WHERE is_system AND key = 'hod';

-- +goose Down
-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd
UPDATE roles SET is_default = false WHERE is_system AND key = 'hod';
