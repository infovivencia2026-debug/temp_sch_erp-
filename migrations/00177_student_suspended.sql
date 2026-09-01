-- +goose Up

/* Suspension is not leaving.
 *
 * students_status_check allowed active, inactive, withdrawn, transferred,
 * graduated and alumni — every one of which means the child is gone. A child
 * suspended for a fortnight is still enrolled, still owes fees, still has a
 * seat in 7-A and comes back; there was nowhere to say so, so schools either
 * marked them withdrawn (which closes the enrolment and takes them off the
 * register) or recorded it nowhere.
 *
 * The distinction matters to the register above all. A withdrawn child should
 * stop being expected; a suspended one is expected back, and the days between
 * are absences the school itself caused and must be able to account for.
 */
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_status_check;

ALTER TABLE students
    ADD CONSTRAINT students_status_check CHECK (status = ANY (ARRAY[
        'active'::text, 'suspended'::text, 'inactive'::text, 'withdrawn'::text,
        'transferred'::text, 'graduated'::text, 'alumni'::text]));

-- +goose Down
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_status_check;
ALTER TABLE students
    ADD CONSTRAINT students_status_check CHECK (status = ANY (ARRAY[
        'active'::text, 'inactive'::text, 'withdrawn'::text,
        'transferred'::text, 'graduated'::text, 'alumni'::text]));
