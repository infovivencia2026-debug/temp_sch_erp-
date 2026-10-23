-- How a pay component is usually worked out (Yajur, 2026-10-14: "show how
-- each is calculated in a table, and if we add one more it will be there
-- with % or money"). percent_of already says BASIC; it may now also say
-- GROSS. default_value is the usual figure: a percent when is_percent, else
-- rupees a month. A salary form opens with it filled in, and each person's
-- figure can still differ.
-- Forward-only: once applied anywhere this file must not change.
ALTER TABLE salary_components ADD COLUMN default_value REAL;
