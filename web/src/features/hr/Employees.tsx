import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Phone, Mail } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Loading, ErrorState,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { formatDate, cn } from '@/lib/utils'

/* The staff file, and the papers that lapse.
 *
 * Two things a school keeps employee records for: knowing who works here, and
 * being able to produce a document when an inspector asks. The second is the
 * one that goes wrong quietly — a teaching licence, a medical fitness
 * certificate, a driver's police verification all expire, and nobody notices
 * until the day it matters.
 *
 * So expiry leads. Already-expired first, then soonest; documents that never
 * lapse sort last, because a degree certificate needs nobody's attention.
 */

interface Employee {
  id: string
  employee_code: string
  full_name: string
  designation?: string
  department?: string
  phone?: string
  email?: string
  joined_on?: string
  status: string
  employment_type?: string
}

interface Doc {
  id: string
  employee: string
  employee_code: string
  doc_type: string
  expires_on?: string
  days_left?: number
  uploaded_on: string
}

export default function Employees() {
  const [search, setSearch] = useState('')
  const [expiringOnly, setExpiringOnly] = useState(true)

  const staff = useQuery({
    queryKey: ['employees'],
    queryFn: () => api.get<List<Employee>>('/api/v1/hr/employees'),
  })
  const docs = useQuery({
    queryKey: ['employee-docs', expiringOnly],
    queryFn: () => api.get<List<Doc>>(`/api/v1/hr/documents?expiring=${expiringOnly}`),
  })

  const all = staff.data?.items ?? []
  const rows = search.trim()
    ? all.filter((e) =>
        `${e.full_name} ${e.employee_code} ${e.designation ?? ''}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : all

  const ds = docs.data?.items ?? []
  const expired = ds.filter((d) => d.days_left != null && d.days_left < 0)
  const soon = ds.filter((d) => d.days_left != null && d.days_left >= 0 && d.days_left <= 60)
  const departments = [...new Set(all.map((e) => e.department).filter(Boolean))]

  return (
    <>
      <PageHead
        eyebrow="Employees"
        title="Staff records"
        description="Who works here, and which of their papers are about to lapse."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Active staff" value={all.filter((e) => e.status === 'active').length} />
          <Stat label="Departments" value={departments.length} />
          <Stat
            label="Documents expired"
            value={expired.length}
            hint={expired.length ? 'Renew now' : 'None lapsed'}
          />
          <Stat label="Expiring in 60 days" value={soon.length} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Documents"
            description="Expired first, then soonest to lapse"
            action={
              <Button
                size="sm"
                variant={expiringOnly ? 'primary' : 'secondary'}
                onClick={() => setExpiringOnly((v) => !v)}
              >
                {expiringOnly ? 'Showing expiring only' : 'Show all documents'}
              </Button>
            }
          />
          {docs.isLoading ? (
            <Loading />
          ) : docs.error ? (
            <ErrorState error={docs.error} />
          ) : (
            <Table
              head={['Employee', 'Document', 'Expires', 'Uploaded']}
              empty={!ds.length}
              emptyLabel={
                expiringOnly
                  ? 'Nothing lapses in the next 60 days.'
                  : 'No documents on file yet.'
              }
            >
              {ds.map((d) => (
                <tr key={d.id}>
                  <Td className="font-medium">
                    {d.employee}
                    <span className="block font-mono text-[11.5px] font-normal text-muted-foreground">
                      {d.employee_code}
                    </span>
                  </Td>
                  <Td className="capitalize">{d.doc_type?.replace(/_/g, ' ')}</Td>
                  <Td>
                    {d.expires_on ? (
                      <span
                        className={cn(
                          'tabular-nums',
                          d.days_left != null && d.days_left < 0 && 'font-medium text-destructive',
                          d.days_left != null && d.days_left >= 0 && d.days_left <= 30 &&
                            'font-medium text-[hsl(var(--warning))]',
                        )}
                      >
                        {formatDate(d.expires_on)}
                        {d.days_left != null && (
                          <span className="block text-[11.5px]">
                            {d.days_left < 0 ? `expired ${-d.days_left}d ago` : `${d.days_left}d left`}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">does not expire</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(d.uploaded_on)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Directory"
            description={`${rows.length} of ${all.length}`}
            action={
              <span className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <span className="[&_input]:pl-8">
                  <Input value={search} onChange={setSearch} placeholder="Name, code or role" />
                </span>
              </span>
            }
          />
          {staff.isLoading ? (
            <Loading />
          ) : staff.error ? (
            <ErrorState error={staff.error} />
          ) : (
            <Table
              head={['Code', 'Name', 'Designation', 'Department', 'Contact', 'Joined', 'Status']}
              empty={!rows.length}
              emptyLabel={search ? 'Nobody matches that.' : 'No employees on file.'}
            >
              {rows.map((e) => (
                <tr key={e.id}>
                  <Td className="font-mono text-[12px]">{e.employee_code}</Td>
                  <Td className="font-medium">{e.full_name}</Td>
                  <Td className="text-muted-foreground">{e.designation ?? '—'}</Td>
                  <Td className="text-muted-foreground">{e.department ?? '—'}</Td>
                  <Td className="text-[13px]">
                    {e.phone && (
                      <a href={`tel:${e.phone}`} className="flex items-center gap-1 text-primary">
                        <Phone className="h-3 w-3" />{e.phone}
                      </a>
                    )}
                    {e.email && (
                      <a href={`mailto:${e.email}`} className="flex items-center gap-1 text-muted-foreground">
                        <Mail className="h-3 w-3" />email
                      </a>
                    )}
                    {!e.phone && !e.email && '—'}
                  </Td>
                  <Td className="text-muted-foreground">
                    {e.joined_on ? formatDate(e.joined_on) : '—'}
                  </Td>
                  <Td><StatusPill status={e.status} /></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
