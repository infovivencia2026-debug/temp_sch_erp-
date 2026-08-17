import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Button, Loading, ErrorState,
} from '@/components/ui'

/* Everything this account may take out of the system, in one place.
 *
 * The export endpoint is permission-filtered server-side: it returns only the
 * datasets the caller's grants allow, so a class teacher sees students and a
 * finance clerk sees the fee ledger, from the same screen and the same URL.
 * That is why this is one page rather than a download button hidden on each
 * module -- the answer to "what can I get out of this" should not require
 * visiting eleven screens to discover.
 *
 * Downloads go straight to the CSV endpoint rather than through fetch: the
 * browser handles the file, the session cookie goes with it, and nothing has
 * to buffer a large export in memory to hand it back as a blob.
 */

interface ExportSpec {
  name: string
  url: string
  columns: string[]
}

/** The catalogue names datasets by key; these are what a school calls them. */
const LABELS: Record<string, { title: string; blurb: string }> = {
  students: { title: 'Students', blurb: 'Every student with class, section and guardian contact.' },
  attendance: { title: 'Attendance', blurb: 'Daily marks per student, for the selected period.' },
  invoices: { title: 'Invoices', blurb: 'Raised, paid and outstanding, per student.' },
  payments: { title: 'Payments', blurb: 'Receipts with mode, date and collector.' },
  employees: { title: 'Employees', blurb: 'Staff records with department and designation.' },
  marks: { title: 'Marks', blurb: 'Exam marks per student per paper.' },
  enquiries: { title: 'Enquiries', blurb: 'Admission leads with source and status.' },
}

export default function Exports() {
  const q = useQuery({
    queryKey: ['exports'],
    queryFn: () => api.get<List<ExportSpec>>('/api/v1/export'),
  })

  const items = q.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Reports"
        title="Data exports"
        description="Download any dataset your role permits as CSV. The list below is filtered to what you may take out."
      />
      <PageBody width="form">
        <Card>
          <CardHeader
            title="Available exports"
            description={items.length ? `${items.length} datasets` : undefined}
          />
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            <Table
              head={['Dataset', 'Columns', '']}
              empty={!items.length}
              emptyLabel="Your role does not permit any export."
            >
              {items.map((x) => {
                const label = LABELS[x.name] ?? { title: x.name, blurb: '' }
                return (
                  <tr key={x.name}>
                    <Td className="font-medium">
                      {label.title}
                      {label.blurb && (
                        <span className="block text-[12.5px] font-normal text-muted-foreground">
                          {label.blurb}
                        </span>
                      )}
                    </Td>
                    <Td className="text-[12.5px] text-muted-foreground">
                      {x.columns.length} columns
                      <span className="block max-w-[42ch] truncate">{x.columns.join(', ')}</span>
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          window.location.href = x.url
                        }}
                      >
                        <Download className="h-3.5 w-3.5" /> CSV
                      </Button>
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
        </Card>

        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          Exports carry the same scope as the screens: a teacher's student export contains their own
          sections, an administrator's contains the school. Every download is recorded in the audit
          log against your account.
        </p>
      </PageBody>
    </>
  )
}
