-- +goose Up

/* Who handed it in.
 *
 * Turning homework in was the child's alone, on the grounds that doing it for
 * them is not a convenience — it is the one part of homework that only means
 * anything if the child did it. That reasoning is sound and it is not the whole
 * picture: a nine-year-old has no login, a phone in the house belongs to a
 * parent, and a family photographing a worked page at eight in the evening is
 * the ordinary case rather than the suspicious one.
 *
 * So a guardian may hand work in, and the row says they did. The teacher marking
 * it can see the difference, which is what the original rule was protecting —
 * not who pressed the button, but whether anybody could tell.
 *
 * Null on every row written before this, and on any row the child submitted
 * themselves: absence means the child, which is what it meant for the whole of
 * the product's life so far.
 */
ALTER TABLE homework_submissions
    ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE homework_submissions DROP COLUMN IF EXISTS submitted_by;
