-- +goose Up

/* The permanent address, and who to ring when nobody answers.
 *
 * PERMANENT ADDRESS. The record held one address. For a boarding school, for
 * a family posted here on a three-year transfer, and for most of the children
 * of a district with seasonal work, the address a child sleeps at during term
 * is not the address the family belongs to — and it is the second one a
 * transfer certificate and a scholarship form both ask for. Schools kept it in
 * the address box as a second paragraph, which no report could read.
 *
 * EMERGENCY CONTACT. Both parents are at work and their phones are in
 * lockers. Every school keeps a neighbour, an aunt, a family friend for
 * exactly this, and this product had nowhere to put them — so the number was
 * in the class teacher's notebook, which is not in the building at 9pm.
 *
 * Deliberately NOT a guardian row. A guardian can be given a login, receives
 * fee reminders and absence alerts, and appears on the family's app. The
 * neighbour who holds a spare key should get none of that, and modelling them
 * as a guardian to store a phone number would put them on all of it.
 */
ALTER TABLE students
    ADD COLUMN IF NOT EXISTS permanent_address text,
    ADD COLUMN IF NOT EXISTS emergency_contact_name text,
    ADD COLUMN IF NOT EXISTS emergency_contact_phone text,
    ADD COLUMN IF NOT EXISTS emergency_contact_relation text;

COMMENT ON COLUMN students.permanent_address IS
    'The family''s permanent address, where it differs from where the child '
    'lives during term. Blank means it is the same.';
COMMENT ON COLUMN students.emergency_contact_name IS
    'Somebody to ring when no guardian answers. NOT a guardian row: this '
    'person gets no login, no fee reminders and no absence alerts.';

-- +goose Down
ALTER TABLE students
    DROP COLUMN IF EXISTS permanent_address,
    DROP COLUMN IF EXISTS emergency_contact_name,
    DROP COLUMN IF EXISTS emergency_contact_phone,
    DROP COLUMN IF EXISTS emergency_contact_relation;
