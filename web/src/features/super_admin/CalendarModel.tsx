import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Select, Field, FormGrid, FormNotice, Loading, ErrorState,
} from '@/components/ui'
import {
  usePlatform, usePlatformSave, MONTHS, WEEKDAYS, type CalendarModel as Model,
} from './platform-lib'

/**
 * The school year and the financial year, side by side.
 *
 * They are not the same year and never have been. The school runs June to
 * April; the books run April to March. Admissions, promotions and report cards
 * follow the first, receipts and every statutory return follow the second, and
 * software that assumes one calendar dates a June receipt into the wrong
 * financial year — which the school discovers at audit.
 *
 * The financial year is shown but not editable. April to March is the Income
 * Tax Act's, not the school's, and a field offering to change it would only
 * ever be used by mistake.
 */
export default function CalendarModel() {
  const { data, isLoading, error } = usePlatform<Model>('calendar-model', '/calendar-model')
  const save = usePlatformSave('calendar-model', '/calendar-model')

  const [start, setStart] = useState<string | null>(null)
  const [end, setEnd] = useState<string | null>(null)
  const [terms, setTerms] = useState<string | null>(null)
  const [weekStart, setWeekStart] = useState<string | null>(null)
  const [days, setDays] = useState<string | null>(null)
  const [saturday, setSaturday] = useState<string | null>(null)
  const [required, setRequired] = useState<string | null>(null)

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const v = {
    start: start ?? String(data.school_year_start_month),
    end: end ?? String(data.school_year_end_month),
    terms: terms ?? String(data.term_count),
    weekStart: weekStart ?? String(data.week_start_day),
    days: days ?? String(data.working_days_per_week),
    saturday: saturday ?? data.saturday_pattern,
    required: required ?? String(data.required_working_days),
  }

  const mismatched = data.academic_years.filter((y) => !y.matches_model)
  const termsDisagree = data.current_terms > 0 && data.current_terms !== data.term_count

  return (
    <>
      <PageHead
        eyebrow="Campuses & Academic Year"
        title="Academic calendar model"
        description="The June-to-April school year, configured separately from the April-to-March financial year used for receipts."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="School year now" value={data.school_year_label} hint="Admissions, promotions, report cards" />
          <Stat label="Financial year now" value={data.financial_year_label} hint="Receipts, payroll, statutory returns" />
          <Stat label="Terms configured" value={data.term_count} hint={termsDisagree ? `Current year has ${data.current_terms}` : undefined} />
          <Stat
            label="Instructional days required"
            value={data.required_working_days}
            hint={`${data.working_days_per_week} days a week`}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="The model"
            description="Read by the admissions, promotion and report card screens when they need to know which year a date belongs to"
            action={
              <Button
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    school_year_start_month: Number(v.start),
                    school_year_end_month: Number(v.end),
                    term_count: Number(v.terms),
                    week_start_day: Number(v.weekStart),
                    working_days_per_week: Number(v.days),
                    saturday_pattern: v.saturday,
                    required_working_days: Number(v.required),
                  })
                }
              >
                Save
              </Button>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="School year starts in" hint="June for most of Telangana; April for a CBSE school in the north.">
                <Select value={v.start} onChange={setStart} options={MONTHS} />
              </Field>
              <Field label="School year ends in">
                <Select value={v.end} onChange={setEnd} options={MONTHS} />
              </Field>
              <Field
                label="Financial year starts in"
                hint="Fixed at April by the Income Tax Act. Shown here so the two calendars can be read together."
              >
                <Input value="April" onChange={() => {}} />
              </Field>
              <Field label="Terms in a year">
                <Select
                  value={v.terms}
                  onChange={setTerms}
                  options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: String(n) }))}
                />
              </Field>
              <Field label="Week starts on">
                <Select value={v.weekStart} onChange={setWeekStart} options={WEEKDAYS} />
              </Field>
              <Field label="Working days a week">
                <Select
                  value={v.days}
                  onChange={setDays}
                  options={[5, 6, 7].map((n) => ({ value: String(n), label: String(n) }))}
                />
              </Field>
              <Field label="Saturdays">
                <Select
                  value={v.saturday}
                  onChange={setSaturday}
                  options={[
                    { value: 'all', label: 'Every Saturday is a working day' },
                    { value: 'alternate', label: 'Alternate Saturdays' },
                    { value: 'none', label: 'Saturdays are holidays' },
                  ]}
                />
              </Field>
              <Field
                label="Instructional days required"
                hint="The minimum the board expects. The holiday calendar is measured against it."
              >
                <Input value={v.required} onChange={setRequired} />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice error={save.error} ok={save.isSuccess ? 'Calendar model saved.' : undefined} />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Academic years against the model"
            description={
              mismatched.length
                ? `${mismatched.length} year${mismatched.length > 1 ? 's do' : ' does'} not start in the configured month`
                : 'Every year created so far follows the model'
            }
          />
          <Table
            head={['Year', 'Starts', 'Ends', 'Terms', 'Matches model', '']}
            empty={!data.academic_years.length}
            emptyLabel="No academic year has been created yet."
          >
            {data.academic_years.map((y) => (
              <tr key={y.id}>
                <Td className="font-medium">
                  {y.name}
                  {y.is_current && (
                    <span className="ml-2">
                      <Badge tone="primary" solid>
                        current
                      </Badge>
                    </span>
                  )}
                </Td>
                <Td>{y.starts_on}</Td>
                <Td>{y.ends_on}</Td>
                <Td>
                  {y.terms}
                  {y.is_current && termsDisagree && (
                    <span className="ml-2 text-[12px] text-warning">model says {data.term_count}</span>
                  )}
                </Td>
                <Td>
                  {y.matches_model ? (
                    <Badge tone="success">Yes</Badge>
                  ) : (
                    <Badge tone="warning">Starts in a different month</Badge>
                  )}
                </Td>
                <Td />
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}
