-- +goose Up

/* THE GUARDIAN IS THE ACCOUNT HOLDER, NOT THE CHILD AND NOT THE FORM.
 *
 * guardians is institution-scoped and carries no student_id: a parent exists in
 * their own right and student_guardians links them to children afterwards. An
 * application had no way of saying which parent it belongs to -- only
 * parent_name, parent_phone and parent_email, three strings that cannot be
 * joined on -- so the family portal could only find an admission through the
 * enquiry it grew out of. An application taken at the counter with no enquiry
 * behind it was invisible to the very family it was about.
 *
 * One column, pointing at the person. It is what the portal reads to answer
 * "which admissions are mine", and what the second child's application reuses
 * so a family keeps the one login they already have rather than being issued a
 * second that quietly replaces it.
 *
 * ON DELETE SET NULL: the application is the school's record of its own
 * season and outlives the account.
 */
ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS guardian_id uuid REFERENCES guardians(id) ON DELETE SET NULL;

-- Read on every portal page load by the parent. Partial: most historical
-- applications carry no guardian and indexing them is paying for rows no query
-- asks for.
CREATE INDEX IF NOT EXISTS applications_guardian_idx
    ON applications (guardian_id) WHERE guardian_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS applications_guardian_idx;
ALTER TABLE applications DROP COLUMN IF EXISTS guardian_id;
