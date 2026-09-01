-- +goose Up

-- A discount for paying the whole year at once.
--
-- fee_concessions.kind allowed scholarship, sibling, staff_ward, rte, merit
-- and other. Every one of those is about WHO the family is. None of them is
-- about HOW they pay -- and the commonest discount an Indian school actually
-- gives is the one for settling all three terms in a single instalment,
-- because it is worth real money to the school: no chasing, no reminders, no
-- late fines to argue about in February.
--
-- Filed under 'other' it was invisible: a school could not answer "how much
-- did we give away for early settlement this year", which is the one question
-- that decides whether to go on offering it.

ALTER TABLE fee_concessions DROP CONSTRAINT IF EXISTS fee_concessions_kind_check;

ALTER TABLE fee_concessions
    ADD CONSTRAINT fee_concessions_kind_check CHECK (kind = ANY (ARRAY[
        'scholarship', 'sibling', 'staff_ward', 'rte', 'merit',
        'full_payment', 'other']));

COMMENT ON COLUMN fee_concessions.kind IS
    'Why the waiver was given. full_payment is the discount for settling the '
    'whole year in one instalment: unlike the others it is about how the '
    'family pays rather than who they are.';

-- +goose Down
ALTER TABLE fee_concessions DROP CONSTRAINT IF EXISTS fee_concessions_kind_check;
ALTER TABLE fee_concessions
    ADD CONSTRAINT fee_concessions_kind_check CHECK (kind = ANY (ARRAY[
        'scholarship', 'sibling', 'staff_ward', 'rte', 'merit', 'other']));
