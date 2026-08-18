-- +goose Up
-- Which tax regime an employee chose, for which year.
--
-- Since FY 2023-24 the new regime is the default and the old one is an
-- election, and the two compute so differently that no amount of investment
-- declarations can imply which is in force. The choice is per employee per
-- year — an employee may switch — so it cannot live on the employee record,
-- and it is not a property of any one declaration either.

CREATE TABLE employee_tax_elections (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- The financial year as its starting calendar year: 2026 means the year
    -- running April 2026 to March 2027.
    fy_start_year   integer NOT NULL,
    regime          text NOT NULL DEFAULT 'new',
    -- Whether the employee has actually said so, as against the default being
    -- applied because nobody asked. An office chasing declarations needs to
    -- know which of its staff have simply not answered.
    elected_on      date,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT employee_tax_elections_regime CHECK (regime IN ('old','new'))
);

CREATE UNIQUE INDEX employee_tax_elections_one_per_year
    ON employee_tax_elections (employee_id, fy_start_year);

ALTER TABLE employee_tax_elections ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_tax_elections FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_tax_elections_tenant ON employee_tax_elections
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS employee_tax_elections;
