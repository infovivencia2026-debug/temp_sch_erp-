-- ESI for one person (Yajur, 2026-10-15: "from now on all the payrolls should
-- be match" their own sheet, where some staff under the ESI wage limit pay no
-- ESI). 1 follows the school's ESI rule, exactly as before; 0 takes no ESI from
-- or for this person. Forward-only: once applied anywhere this file must not change.
ALTER TABLE employees ADD COLUMN esi_applies INTEGER NOT NULL DEFAULT 1;
