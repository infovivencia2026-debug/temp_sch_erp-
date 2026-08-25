-- +goose Up
-- +goose StatementBegin

/* When the staff were told.

   Publishing payslips deliberately does not add a fifth status: the run stays
   'paid', because paying is what happened to the money and publishing is what
   happened to the people. That reasoning holds — but nothing recorded the
   second event at all, so once the page was reloaded the month looked exactly
   like one that had never been published. The panel read "Paid" over a
   "Publish payslips" button, and the only way to know the staff had already
   been notified was to remember doing it.

   Which is how twelve people get told twice. A timestamp, not a state: it
   answers "have they been told, and when", and leaves the status column
   meaning what it always meant. */
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS published_at timestamptz;

COMMENT ON COLUMN payroll_runs.published_at IS
    'When staff were notified their payslip was ready. NULL means not yet told.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS published_at;
-- +goose StatementEnd
