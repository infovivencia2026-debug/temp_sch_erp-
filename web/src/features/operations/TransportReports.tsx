import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Button, Select,
  Loading, ErrorState, EmptyState, PrintButton,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* THE SHEETS A TRANSPORT OFFICE IS ASKED FOR, READY MADE.

   The honest version of a reports page is short. A list of eleven buttons
   where three of them are the same rows grouped differently is not eleven
   reports, it is three reports and eight ways to pick the wrong one -- and
   the office then exports all of them to be safe.

   So: five, each answering a question somebody actually asks, each built
   from the endpoint that already serves the screen it belongs to. Nothing
   new is computed here, which is the point: a report that disagrees with the
   screen it came from is worse than no report. Print uses the shared paper,
   and Export writes the same rows to a spreadsheet. */

/** Paise as the counter writes them. Local, as on the other transport screens. */
const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })

type Row = Record<string, unknown>
interface Column { key: string; label: string; money?: boolean }

interface Report {
  key: string
  name: string
  blurb: string
  url: string
  columns: Column[]
}

const REPORTS: Report[] = [
  {
    key: 'riders',
    name: 'Who rides what',
    blurb: 'Every child with a live allocation, their route, stop and fare. The list a new term is planned from.',
    url: '/api/v1/ops/transport/allocations',
    columns: [
      { key: 'admission_no', label: 'Admission no' },
      { key: 'full_name', label: 'Child' },
      { key: 'class_name', label: 'Class' },
      { key: 'route', label: 'Route' },
      { key: 'pickup_stop', label: 'Stop' },
      { key: 'pickup_time', label: 'Time' },
      { key: 'fare_paise', label: 'Fare', money: true },
    ],
  },
  {
    key: 'fleet',
    name: 'The fleet and its papers',
    blurb: 'Every bus with capacity and the dates its permit, insurance and fitness run out.',
    url: '/api/v1/ops/transport/vehicles',
    columns: [
      { key: 'registration_no', label: 'Bus' },
      { key: 'model', label: 'Model' },
      { key: 'capacity', label: 'Seats' },
      { key: 'permit_expiry', label: 'Permit' },
      { key: 'insurance_expiry', label: 'Insurance' },
      { key: 'fitness_expiry', label: 'Fitness' },
      { key: 'status', label: 'Status' },
    ],
  },
  {
    key: 'staff',
    name: 'Drivers and attendants',
    blurb: 'Who drives, with licence and verification, and how long each has left to run.',
    url: '/api/v1/ops/transport/staff',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'role', label: 'Role' },
      { key: 'licence_no', label: 'Licence' },
      { key: 'licence_expiry', label: 'Expires' },
      { key: 'days_to_lapse', label: 'Days left' },
    ],
  },
  {
    key: 'checks',
    name: 'Safety checks',
    blurb: 'A fortnight of pre-trip checks, and what failed where it did.',
    url: '/api/v1/ops/transport/checks',
    columns: [
      { key: 'on_date', label: 'Date' },
      { key: 'leg', label: 'Leg' },
      { key: 'vehicle', label: 'Bus' },
      { key: 'driver', label: 'Driver' },
      { key: 'failed_items', label: 'Failed' },
      { key: 'checked_by', label: 'Signed by' },
    ],
  },
  {
    key: 'incidents',
    name: 'Delays and incidents',
    blurb: 'What went wrong this month, and whether it was closed.',
    url: '/api/v1/ops/transport/incidents?period=this_month',
    columns: [
      { key: 'occurred_at', label: 'When' },
      { key: 'route', label: 'Route' },
      { key: 'vehicle', label: 'Bus' },
      { key: 'kind', label: 'Kind' },
      { key: 'notes', label: 'What happened' },
      { key: 'resolved_at', label: 'Closed' },
    ],
  },
]

/** A cell as text: the one place arrays and paise become readable. */
function text(row: Row, col: Column): string {
  const v = row[col.key]
  if (v === null || v === undefined || v === '') return '-'
  if (Array.isArray(v)) return v.length ? v.join(', ') : '-'
  if (col.money) return `₹${rupees(Number(v))}`
  return String(v)
}

/* A spreadsheet of exactly what is on screen. Quoted properly, because a
   child called "Rao, Priya" otherwise moves everything one column right and
   nobody notices until the fees are wrong. */
function toCSV(rows: Row[], columns: Column[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const head = columns.map((c) => esc(c.label)).join(',')
  const body = rows.map((r) => columns.map((c) => esc(text(r, c))).join(','))
  return [head, ...body].join('\n')
}

function download(name: string, csv: string) {
  /* A BOM, so Excel opens Telugu names as Telugu rather than mojibake. */
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 0)
}

/* `wide` on the table, deliberately.

   Seven columns sits under the threshold that turns the roomy layout on by
   itself, and these seven still outgrew the card by about thirty pixels --
   a route named "Route 1 - Kompally to school" is most of a column on its
   own, and the rows ran past the card's right edge. Roomy puts the table in
   the container that scrolls rather than over the edge of the card. */
export default function TransportReports() {
  const [key, setKey] = useState(REPORTS[0].key)
  const report = REPORTS.find((r) => r.key === key) ?? REPORTS[0]

  const q = useQuery({
    queryKey: ['transport-report', report.key],
    queryFn: () => api.get<List<Row>>(report.url),
  })
  const rows = q.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title="Transport reports"
        description="Built from the same endpoints the screens use, so a report never disagrees with the screen it came from."
        actions={
          <div className="flex gap-2">
            <PrintButton label="Print" title={report.name} />
            <Button
              variant="secondary"
              size="sm"
              disabled={!rows.length}
              onClick={() => download(`${report.key}.csv`, toCSV(rows, report.columns))}
            >
              Export
            </Button>
          </div>
        }
      />
      <PageBody>
        <Card>
          <CardHeader title="Which sheet" description="Pick one. Each prints and exports as it stands." />
          <div className="flex flex-col gap-2 p-4 pt-0">
            {/* Buttons on a desk, a dropdown on a phone: five choices is a
                row at a desk and a scroll on a handset. */}
            <div className="hidden flex-wrap gap-2 sm:flex">
              {REPORTS.map((r) => (
                <Button
                  key={r.key}
                  variant={r.key === key ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setKey(r.key)}
                >
                  {r.name}
                </Button>
              ))}
            </div>
            <div className="sm:hidden">
              <Select
                value={key}
                onChange={setKey}
                options={REPORTS.map((r) => ({ value: r.key, label: r.name }))}
              />
            </div>
            <p className={cn('text-[13px] text-muted-foreground')}>{report.blurb}</p>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={report.name}
            description={q.isLoading ? undefined : `${rows.length} row${rows.length === 1 ? '' : 's'}`}
          />
          {q.isLoading ? (
            <Loading label="Building the sheet…" />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : rows.length === 0 ? (
            <EmptyState title="Nothing to report" body="There are no rows for this sheet yet." />
          ) : (
            <Table wide head={report.columns.map((c) => ({ label: c.label }))}>
              {rows.map((row, i) => (
                <tr key={String(row.id ?? i)}>
                  {report.columns.map((c) => (
                    <Td key={c.key}>{text(row, c)}</Td>
                  ))}
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
