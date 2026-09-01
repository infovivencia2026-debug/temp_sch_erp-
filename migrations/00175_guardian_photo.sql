-- +goose Up

/* A photograph of the father and the mother, where the school wants one.
 *
 * The child has had photo_file_id since the baseline and the guardian never
 * had anywhere to put a face at all — so the gate register, the ID card issued
 * to a parent and every "is this the person collecting the child" question was
 * answered from a name and a phone number.
 *
 * OPTIONAL, and it stays optional. A school that photographs parents at
 * admission fills it; a school that does not is not nagged, and nothing
 * downstream may treat a blank as incomplete. That is why it is a nullable
 * column with no default rather than a required step in a wizard.
 */
ALTER TABLE guardians
    ADD COLUMN IF NOT EXISTS photo_file_id uuid REFERENCES files(id) ON DELETE SET NULL;

COMMENT ON COLUMN guardians.photo_file_id IS
    'Optional photograph of this parent or guardian. Null is an ordinary '
    'answer, not missing data.';

-- +goose Down
ALTER TABLE guardians DROP COLUMN IF EXISTS photo_file_id;
