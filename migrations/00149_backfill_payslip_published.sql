-- +goose Up
-- +goose StatementBegin

/* The months that were already published.

   00148 added published_at, which fixes this going forward and leaves every
   month published before it looking untouched — so the payroll office reopens
   August, sees "Paid" over a Publish button, and tells twelve people a second
   time. The migration that adds a fact should carry the facts already known.

   Publishing writes one notification per member of staff, titled "Your payslip
   for <Month> is ready" and stamped with the moment it was sent. That is the
   event itself, recorded at the time, so the earliest such notice for a month
   is when the staff were told. Nothing else in the schema writes that kind.

   Deliberately the earliest rather than the latest: a month published once and
   emailed again later was told on the first occasion. */
UPDATE payroll_runs pr
   SET published_at = ev.first_told
  FROM (
      SELECT n.institution_id,
             to_char(min(n.created_at), 'YYYY')::int AS notice_year,
             n.title,
             min(n.created_at) AS first_told
        FROM notifications n
       WHERE n.kind = 'payslip'
       GROUP BY n.institution_id, n.title
  ) ev
 WHERE pr.institution_id = ev.institution_id
   AND pr.published_at IS NULL
   AND pr.status = 'paid'
   AND ev.title = 'Your payslip for '
                  || to_char(make_date(pr.period_year, pr.period_month, 1), 'FMMonth')
                  || ' is ready';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Nothing to undo: 00148's own down drops the column this filled.
SELECT 1;
-- +goose StatementEnd
