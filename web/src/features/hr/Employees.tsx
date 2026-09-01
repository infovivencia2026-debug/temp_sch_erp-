import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Search, Phone, Mail, Printer } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Loading, ErrorState,
} from '@/components/ui'
import IDCards from './IDCards'
import StaffRecord from './StaffRecord'
import { StatusPill } from '@/components/NeedsAttention'
import { useCan } from '@/lib/session'
import AddStaff from './AddStaff'
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
 *
 * Four menu entries used to open this one screen — Employee master, Employee
 * documents, Employee document expiry alerts, Staff ID card printing — and
 * three of them were a lie: you clicked "Print ID cards" and were dropped on a
 * staff list with no printing anywhere on it. A menu that promises four things
 * and delivers the same thing four times is worse than a menu with one entry,
 * because the reader learns not to trust any of it.
 *
 * One entry now, and the three jobs are tabs, so the promise is made where it
 * can be kept. ID card printing was the one that had no implementation behind
 * it at all; it does now.
 */

interface StaffLogin {
  employee_code: string
  full_name: string
  sign_in_as: string
  password: string
  note: string
}

/* The handset PIN, mirrored on the password flow beside it.

   A driver signs the bus-tracker app in with a phone number and this PIN, and
   POST /setup/employees/{id}/pin was the one issuing route no screen called --
   so the endpoint existed, the app demanded a PIN, and there was nowhere in
   the product to make one. A paired handset could never start a run. */
interface StaffPIN {
  full_name: string
  phone: string
  pin: string
}

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

type Tab = 'staff' | 'documents' | 'ids'
const TABS: { key: Tab; label: string }[] = [
  { key: 'staff', label: 'Staff directory' },
  { key: 'documents', label: 'Document expiry tracker' },
  { key: 'ids', label: 'Batch ID card printing' },
]

export default function Employees() {
  const [openStaff, setOpenStaff] = useState<string | null>(null)
  const can = useCan()
  const [params, setParams] = useSearchParams()
  // An unknown tab falls back to the list rather than a blank page: an old
  // bookmark should still land somewhere sensible.
  const tab: Tab = (TABS.find((t) => t.key === params.get('view'))?.key ?? 'staff')
  const openTab = (key: Tab) => {
    const next = new URLSearchParams(params)
    next.set('view', key)
    setParams(next, { replace: true })
  }
  const [issuing, setIssuing] = useState<string | null>(null)
  const [handover, setHandover] = useState<StaffLogin | null>(null)

  /* Issuing a password is the last step of appointing somebody, so it lives on
     the row rather than behind a separate screen. The result is shown once and
     never stored — a password the system can show you twice is one it is
     keeping somewhere a third party can read. */
  const issue = useMutation({
    mutationFn: (e: Employee) => {
      setIssuing(e.id)
      return api.post<StaffLogin>(`/api/v1/setup/employees/${e.id}/login`, {})
    },
    onSuccess: (h) => { setHandover(h); staff.refetch() },
    onSettled: () => setIssuing(null),
  })

  // The PIN, issued the same way and handed over the same way. Separate state
  // so the two never share a card: a password and a PIN are two credentials.
  const [pinning, setPinning] = useState<string | null>(null)
  const [pinHandover, setPinHandover] = useState<StaffPIN | null>(null)
  const issuePin = useMutation({
    mutationFn: (e: Employee) => {
      setPinning(e.id)
      return api.post<StaffPIN>(`/api/v1/setup/employees/${e.id}/pin`, {})
    },
    onSuccess: (h) => { setPinHandover(h); staff.refetch() },
    onSettled: () => setPinning(null),
  })
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
      {openStaff && (
        <StaffRecord employeeID={openStaff} onClose={() => setOpenStaff(null)} />
      )}
      <PageHead
        eyebrow="Employees"
        title="Staff records"
        description="Manage active staff, track which of their documents are running out, and print ID cards."
      />
      <PageBody>
        <div className="no-print flex flex-wrap items-center gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-current={t.key === tab ? 'page' : undefined}
              onClick={() => openTab(t.key)}
              className={cn(
                'rounded-t-md px-3 py-2 text-[13.5px] font-medium transition-colors',
                t.key === tab
                  ? 'border-b-2 border-primary text-foreground'
                  : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'ids' && <IDCards staff={all.filter((e) => e.status !== 'exited')} />}

        {/* Above the form, not below it.

            The password is shown once and stored nowhere, and it was
            rendering under a form long enough to push it off the screen —
            so the one thing that cannot be looked up again was the one
            thing somebody had to scroll to find. */}
        {/* The one moment the password exists in readable form. It is not in
            the employee record, not in the audit trail and not retrievable —
            so the card says so, and stays until it is dismissed rather than
            disappearing on the next render. */}
        {handover && (
          <div className="mb-5 rounded-lg border-2 border-primary bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[15px] font-semibold">
                  Sign-in details for {handover.full_name}
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">{handover.note}</p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setHandover(null)}>Done</Button>
            </div>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-[12px] text-muted-foreground">Sign in at</dt>
                <dd className="font-mono text-[14px]">/login</dd>
              </div>
              <div>
                <dt className="text-[12px] text-muted-foreground">Employee</dt>
                <dd className="font-mono text-[14px]">{handover.employee_code}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-muted-foreground">Username</dt>
                <dd className="select-all font-mono text-[17px] font-semibold">{handover.sign_in_as}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-muted-foreground">Password</dt>
                <dd className="select-all font-mono text-[17px] font-semibold">{handover.password}</dd>
              </div>
            </dl>
          </div>
        )}

        {/* The PIN, its own card and its own one-time reveal. Not folded into
            the password card above: they are issued by two different buttons,
            often on two different days, and a driver needs the PIN without the
            website password ever being in the room. */}
        {pinHandover && (
          <div className="mb-5 rounded-lg border-2 border-primary bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[15px] font-semibold">
                  Handset PIN for {pinHandover.full_name}
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  For the bus tracker and other handset apps. Shown once and stored nowhere —
                  write it down before pressing Done. Issuing it again replaces this one.
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setPinHandover(null)}>Done</Button>
            </div>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-[12px] text-muted-foreground">Mobile number</dt>
                <dd className="select-all font-mono text-[17px] font-semibold">{pinHandover.phone}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-muted-foreground">PIN</dt>
                <dd className="select-all font-mono text-[17px] font-semibold tracking-[0.3em]">{pinHandover.pin}</dd>
              </div>
            </dl>
          </div>
        )}

        {/* The screen HR lands on to look somebody up is the screen they land
            on to add somebody. Holding hr.employees.write and finding nothing
            that writes reads as "the product cannot do that" rather than "that
            form is somewhere else". */}
        {tab === 'staff' && can('hr.employees.write') && (
          <AddStaff onDone={() => staff.refetch()} />
        )}

        {tab === 'documents' && (
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
        )}

        {tab === 'documents' && (
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
        )}

        {tab === 'staff' && (
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
              head={['Code', 'Name', 'Designation', 'Department', 'Contact', 'Joined', 'Status', '']}
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
                  <Td>
                    {/* THE RECORD, which the directory did not have.

                        Everything past a name and a department lived on
                        another screen — what they teach, which class they are
                        teacher of, their qualifications — so "what does she
                        teach and can she take another class" meant opening
                        three pages and remembering. */}
                    <Button size="sm" variant="secondary"
                      onClick={() => setOpenStaff(e.id)}>
                      Open
                    </Button>
                    {/* One card, for the person standing at the desk. The
                        bulk tab is for September; this is for the replacement
                        somebody lost on Tuesday. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      title={`Print ${e.full_name}'s ID card`}
                      onClick={() => openTab('ids')}
                    >
                      <Printer className="h-3.5 w-3.5" />
                    </Button>
                    {can('hr.employees.write') && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={issuing === e.id}
                        onClick={() => issue.mutate(e)}
                      >
                        {issuing === e.id ? 'Issuing…' : e.status === 'invited' ? 'Issue login' : 'Reset password'}
                      </Button>
                    )}
                    {/* Only where a PIN can actually be used: it needs an
                        account to sign in as (issue the login first) and a
                        10-digit mobile the app matches on. Offered once the
                        person has both, so a driver is not sent to a button
                        that returns "issue their login first". */}
                    {can('hr.employees.write') && e.status !== 'invited' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pinning === e.id}
                        title="A 4-digit PIN for the bus tracker and other handset apps"
                        onClick={() => issuePin.mutate(e)}
                      >
                        {pinning === e.id ? 'PIN…' : 'Handset PIN'}
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        )}
      </PageBody>
    </>
  )
}
