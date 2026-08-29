-- +goose Up

/* A signature belongs to a person, not to a document.
 *
 * A report card carries two: the class teacher's, added when they send the set
 * up, and the head's, added when they release it. Both are the same fact —
 * "this person put their name to this" — and the report card already records
 * who those two people were, in submitted_by and decided_by.
 *
 * So nothing is stamped onto the card. The signature is rendered from the
 * person who signed, which means a head who replaces a scanned signature with
 * a better scan does not leave a term's cards showing the old one, and a card
 * that was never approved cannot show a head's signature at all — there is no
 * decided_by to read it from.
 *
 * One per person, and their own: setting it is on the profile, not on a screen
 * where somebody could set somebody else's.
 */
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS signature_file_id uuid REFERENCES files(id) ON DELETE SET NULL;

COMMENT ON COLUMN users.signature_file_id IS
    'The person''s signature, as an uploaded image. Printed on documents they '
    'sign — read through submitted_by/decided_by rather than copied onto each '
    'document, so replacing it corrects every future rendering.';

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS signature_file_id;
