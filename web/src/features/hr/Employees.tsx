import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Phone, Mail, Printer, Camera } from 'lucide-react'
import StudentAvatar from '@/components/StudentAvatar'
import { SearchBox } from '@/components/rows'
import { api, type List } from '@/lib/api'
import { useEmployeeRoster } from '@/lib/rosters'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, SkeletonTable, ErrorState, FormNotice,
} from '@/components/ui'
import { ImportButton, ExportButton } from '@/components/DataPortActions'
import CardViewer from '@/components/CardViewer'
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
  photo_file_id?: string
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
  /* Which row the card is about, kept beside the card so that a reset can be
     asked for from the card itself. The server only replaces a working
     password when told to in as many words (?reset=true); the row's button
     never said so, and "Reset password" answered with a card that had no
     password on it. */
  const [handoverFor, setHandoverFor] = useState<Employee | null>(null)
  const issue = useMutation({
    mutationFn: ({ e, reset }: { e: Employee; reset?: boolean }) => {
      setIssuing(e.id)
      return api.post<StaffLogin>(
        `/api/v1/setup/employees/${e.id}/login${reset ? '?reset=true' : ''}`,
        {},
      )
    },
    onSuccess: (h, { e }) => { setHandover(h); setHandoverFor(e); staff.refetch() },
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

  /* The whole-staff overview, printed through the report-card viewer — the
     same {html, css} print path a report card uses, so there is one way the
     product turns server-rendered pages into paper. */
  const [staffReport, setStaffReport] = useState<{ html: string; css?: string; name?: string } | null>(null)
  const exportOverview = useMutation({
    mutationFn: () => api.get<{ html: string; css?: string }>('/api/v1/hr/staff/overview/report'),
    onSuccess: (v) => setStaffReport({ ...v, name: 'Staff overview' }),
  })

  // The directory searches client-side, so it must hold the WHOLE staff. A
  // single ?limit=200 came back quietly short for a school past 200 -- a late
  // bus driver's code simply could not be found. useEmployeeRoster walks the
  // endpoint to its end (page by page) and caches under ['employees','roster'],
  // which still clears when a mutation invalidates the ['employees'] prefix.
  const staff = useEmployeeRoster<Employee>()
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
      {staffReport && (
        <CardViewer card={staffReport} onClose={() => setStaffReport(null)} />
      )}
      <PageHead
        eyebrow="Employees"
        title="Staff records"
        description="Manage active staff, track which of their documents are running out, and print ID cards."
        actions={
          <>
            {can('hr.employees.write') && (
              <ImportButton
                entity="staff"
                title="Import staff"
                hint="One row per employee. Nothing is written until the dry run passes; logins can be issued afterwards."
              />
            )}
            <ExportButton name="staff" />
          </>
        }
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
                {handover.password ? (
                  <dd className="select-all font-mono text-[17px] font-semibold">{handover.password}</dd>
                ) : (
                  /* The login already works and the password is not on file.
                     The one thing the office can do about a lost password is
                     issue a new one, and that stops the old one, so it is
                     asked for here in front of the sentence that says so
                     rather than fired from the row. */
                  <dd className="mt-1">
                    <Button
                      size="sm"
                      disabled={issuing != null || !handoverFor}
                      onClick={() => handoverFor && issue.mutate({ e: handoverFor, reset: true })}
                    >
                      {issuing ? 'Resetting…' : 'Reset password'}
                    </Button>
                  </dd>
                )}
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
                  For the bus tracker and other handset apps. Shown once and stored nowhere, 
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
            <SkeletonTable columns={4} />
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
              <div className="flex flex-wrap items-center gap-2">
                <SearchBox value={search} onChange={setSearch} placeholder="Name, code or role" />
                {/* One printout of every teacher's load and results — the term's
                    staff review, off the same overview each record shows. */}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={exportOverview.isPending}
                  onClick={() => exportOverview.mutate()}
                >
                  <Printer className="h-3.5 w-3.5" aria-hidden />
                  {exportOverview.isPending ? 'Preparing…' : 'Export all staff'}
                </Button>
              </div>
            }
          />
          {exportOverview.error && (
            <div className="px-5 pt-4">
              <FormNotice error={exportOverview.error} />
            </div>
          )}
          {staff.isLoading ? (
            <SkeletonTable columns={8} />
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
                  <Td className="font-medium">
                    <span className="flex items-center gap-2.5">
                      <StaffPhoto e={e} editable={can('hr.employees.write')} />
                      <span>{e.full_name}</span>
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{e.designation ?? '-'}</Td>
                  <Td className="text-muted-foreground">{e.department ?? '-'}</Td>
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
                    {!e.phone && !e.email && '-'}
                  </Td>
                  <Td className="text-muted-foreground">
                    {e.joined_on ? formatDate(e.joined_on) : '-'}
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
                    {/* The per-row "print this ID card" button was removed to
                        unclutter a row that had four actions and overflowed: the
                        IDs tab prints one card or the whole school from one
                        place, so nothing is lost. */}
                    {can('hr.employees.write') && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={issuing === e.id}
                        onClick={() => issue.mutate({ e })}
                      >
                        {issuing === e.id ? 'Issuing…' : e.status === 'invited' ? 'Issue login' : 'Sign-in details'}
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
                        title="A 6-digit PIN for the bus tracker and other handset apps"
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

/* The face on the row, and the way to put it there.

   A staff list read by name alone is where the wrong person gets a login,
   a leave or a salary line. Every row carries the photograph, with initials
   on a colour of the person's own where none is on file. Anyone who may
   edit staff records can tap the picture to upload one: the file goes up
   through the same upload every screen uses, then PUT /employees/{id}/photo
   points the record at it. */
function StaffPhoto({ e, editable }: { e: Employee; editable: boolean }) {
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const pick = async (list: FileList | null) => {
    const f = list?.[0]
    if (!f) return
    setBusy(true)
    setErr(null)
    try {
      const form = new FormData()
      form.append('file', f, f.name)
      const up = await fetch('/api/v1/files', { method: 'POST', credentials: 'same-origin', body: form })
      if (!up.ok) throw new Error('The photo could not be uploaded.')
      const j = (await up.json()) as { file_id: string }
      await api.put(`/api/v1/setup/employees/${e.id}/photo`, { file_id: j.file_id })
      qc.invalidateQueries({ queryKey: ['employees'] })
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'The photo could not be saved.')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  const face = <StudentAvatar name={e.full_name} photoFileId={e.photo_file_id} seed={e.id} size={62} className="!rounded-[10px]" />
  if (!editable) return face
  return (
    <span className="relative inline-block shrink-0">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="user"
        className="hidden"
        onChange={(ev) => void pick(ev.target.files)}
      />
      <button
        type="button"
        className="group relative block rounded-[10px]"
        title={e.photo_file_id ? 'Change the photo' : 'Add a photo'}
        aria-label={e.photo_file_id ? `Change the photo of ${e.full_name}` : `Add a photo of ${e.full_name}`}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {face}
        <span className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full border bg-background text-muted-foreground group-hover:text-primary">
          <Camera className="h-3 w-3" />
        </span>
      </button>
      {err && <span className="absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded bg-destructive px-1.5 py-0.5 text-[11px] text-white">{err}</span>}
    </span>
  )
}
