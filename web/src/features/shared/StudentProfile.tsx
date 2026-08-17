import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Phone, Mail, ArrowLeft } from 'lucide-react'
import { api, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Input, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise, formatDate, cn } from '@/lib/utils'

interface Profile {
  id: string; admission_no: string; full_name: string; status: string
  class_name?: string; section_name?: string; roll_no?: number
  gender?: string; date_of_birth?: string; medium?: string; blood_group?: string
  mother_tongue?: string; apaar_id?: string; child_info_id?: string
  primary_phone?: string; city?: string; prior_school?: string
  is_rte: boolean; is_cwsn: boolean; admission_date: string
  attendance: { present: number; total: number; percent: number; below_threshold: boolean }
  fees: { outstanding_paise: number; paid_paise: number }
  guardians: { full_name: string; relation: string; phone: string; email: string; is_primary: boolean }[]
  recent_attendance: { date: string; status: string }[]
  results: { exam: string; percentage: string; grade: string; rank: string }[]
  invoices: { date: string; invoice_no: string; net_paise: number; paid_paise: number; status: string }[]
  documents: { serial_no: string; type: string; issued_on: string }[]
}

const DOT: Record<string, string> = {
  present: 'bg-success', late: 'bg-warning', absent: 'bg-destructive',
  half_day: 'bg-warning/60', leave: 'bg-muted-foreground/40', holiday: 'bg-border',
}

/**
 * Student 360 — the screen a school opens most often, usually with a parent on
 * the phone. It answers the questions actually asked in that moment: which
 * class, who do we call, are they attending, what do they owe, how are they
 * doing.
 */
export default function StudentProfile() {
  const [search, setSearch] = useState('')

  /* Which student is open lives in the query string, not in component state.

     Two things follow, and both are asked for daily. The student directory can
     hand a child straight to this screen instead of making the clerk retype a
     name they are already looking at — the directory used to be a dead end,
     rows of text with nowhere to click. And the address bar now identifies a
     child, so "look at this one" is a link rather than a set of instructions.

     Back also works, which it did not: the browser button used to leave the
     feature entirely rather than return to the search. */
  const [params, setParams] = useSearchParams()
  const selected = params.get('student')
  const setSelected = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('student', id)
    else next.delete('student')
    setParams(next, { replace: !id })
  }

  const results = useQuery({
    queryKey: ['profile-search', search],
    queryFn: () => api.get<Page<Student>>(`/api/v1/students?q=${encodeURIComponent(search)}&limit=15`),
    enabled: search.trim().length >= 2 && !selected,
  })

  const profile = useQuery({
    queryKey: ['student-profile', selected],
    queryFn: () => api.get<Profile>(`/api/v1/students/${selected}/profile`),
    enabled: !!selected,
  })

  if (!selected) {
    return (
      <>
        <PageHead
          eyebrow="Student Information"
          title="Student 360"
          description="Search a student to see everything about them on one page."
          actions={<Input value={search} onChange={setSearch} placeholder="Name or admission no." />}
        />
        <PageBody>
          {search.trim().length < 2 ? (
            <EmptyState title="Search for a student" body="Type at least two characters." />
          ) : results.isLoading ? (
            <Loading />
          ) : (
            <Card>
              <Table head={['Admission no.', 'Name', 'Class', 'Status', '']}
                empty={!results.data?.items.length} emptyLabel="No student matches.">
                {(results.data?.items ?? []).map((s) => (
                  <tr key={s.id}>
                    <Td className="font-mono text-[12px]">{s.admission_no}</Td>
                    <Td className="font-medium">{s.full_name}</Td>
                    <Td>{s.class_name ? `${s.class_name}-${s.section_name}` : '—'}</Td>
                    <Td><Badge tone={s.status === 'active' ? 'success' : 'neutral'}>{s.status}</Badge></Td>
                    <Td><Button size="sm" onClick={() => setSelected(s.id)}>Open</Button></Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </PageBody>
      </>
    )
  }

  if (profile.isLoading) return <Loading />
  if (profile.error) return <ErrorState error={profile.error} />
  const p = profile.data!

  return (
    <>
      <PageHead
        eyebrow={`${p.admission_no} · ${p.class_name ?? 'Unplaced'}${p.section_name ? `-${p.section_name}` : ''}`}
        title={p.full_name}
        description={[
          p.gender, p.medium && `${p.medium} medium`,
          p.roll_no && `roll ${p.roll_no}`,
        ].filter(Boolean).join(' · ')}
        actions={
          <Button variant="secondary" onClick={() => { setSelected(null); setSearch('') }}>
            <ArrowLeft className="h-4 w-4" /> Back to search
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Attendance"
            value={`${p.attendance.percent}%`}
            delta={{
              value: `${p.attendance.present}/${p.attendance.total} days`,
              // 75% is the board threshold for exam eligibility.
              positive: !p.attendance.below_threshold,
            }}
          />
          <Stat label="Fees outstanding" value={formatPaise(p.fees.outstanding_paise)}
            hint={p.fees.outstanding_paise ? 'Payable' : 'Settled'} />
          <Stat label="Paid to date" value={formatPaise(p.fees.paid_paise)} />
          <Stat label="Status" value={p.status}
            hint={[p.is_rte && 'RTE', p.is_cwsn && 'CWSN'].filter(Boolean).join(' · ') || undefined} />
        </CellGrid>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader title="Details" />
            <dl className="divide-y text-[14px]">
              <Row k="Admission no." v={p.admission_no} mono />
              <Row k="Admitted on" v={formatDate(p.admission_date)} />
              <Row k="Date of birth" v={formatDate(p.date_of_birth)} />
              <Row k="Blood group" v={p.blood_group ?? '—'} />
              <Row k="Mother tongue" v={p.mother_tongue ?? '—'} />
              <Row k="Medium" v={p.medium ?? '—'} />
              <Row k="APAAR ID" v={p.apaar_id ?? 'not issued'} mono />
              <Row k="Child Info ID" v={p.child_info_id ?? 'not linked'} mono />
              <Row k="Previous school" v={p.prior_school ?? '—'} />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Guardians" description="Primary contact first" />
            {p.guardians.length === 0 ? (
              <div className="p-6">
                <EmptyState title="No guardian on record"
                  body="Nobody can be contacted about this child." />
              </div>
            ) : (
              <ul className="divide-y">
                {p.guardians.map((g) => (
                  <li key={g.full_name + g.phone} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium">
                          {g.full_name}
                          {g.is_primary && <Badge tone="primary">primary</Badge>}
                        </p>
                        <p className="text-[13px] text-muted-foreground">{g.relation}</p>
                      </div>
                      <div className="flex shrink-0 gap-3 text-[13px]">
                        {g.phone && (
                          <a href={`tel:${g.phone}`} className="inline-flex items-center gap-1 text-primary">
                            <Phone className="h-3 w-3" />{g.phone}
                          </a>
                        )}
                        {g.email && (
                          <a href={`mailto:${g.email}`} className="inline-flex items-center gap-1 text-primary">
                            <Mail className="h-3 w-3" />email
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader title="Attendance" description="Last 30 marked days, most recent first" />
          <div className="p-5">
            {p.recent_attendance.length === 0 ? (
              <p className="py-4 text-center text-[14px] text-muted-foreground">Nothing marked yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {p.recent_attendance.map((d) => (
                  <span key={d.date} title={`${d.date} — ${d.status}`}
                    className={cn('h-4 w-4 rounded-sm', DOT[d.status] ?? 'bg-muted')} />
                ))}
              </div>
            )}
          </div>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Results" description="Published report cards" />
            <Table head={['Exam', 'Percentage', 'Grade', 'Rank']} empty={!p.results.length}
              emptyLabel="No published results.">
              {p.results.map((x, i) => (
                <tr key={i}>
                  <Td className="font-medium">{x.exam || '—'}</Td>
                  <Td>{x.percentage ? `${x.percentage}%` : '—'}</Td>
                  <Td>{x.grade ? <Badge tone="primary">{x.grade}</Badge> : '—'}</Td>
                  <Td>{x.rank || '—'}</Td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card>
            <CardHeader title="Fee history" />
            <Table head={['Date', 'Invoice', 'Amount', 'Paid', 'Status']} empty={!p.invoices.length}
              emptyLabel="No invoices raised.">
              {p.invoices.map((x) => (
                <tr key={x.invoice_no}>
                  <Td className="text-muted-foreground">{formatDate(x.date)}</Td>
                  <Td className="font-mono text-[12px]">{x.invoice_no}</Td>
                  <Td>{formatPaise(x.net_paise)}</Td>
                  <Td>{formatPaise(x.paid_paise)}</Td>
                  <Td>
                    <Badge tone={x.status === 'paid' ? 'success' : x.status === 'overdue' ? 'danger' : 'warning'}>
                      {x.status}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>

        {p.documents.length > 0 && (
          <Card>
            <CardHeader title="Certificates issued" />
            <Table head={['Serial', 'Type', 'Issued']} empty={false}>
              {p.documents.map((d) => (
                <tr key={d.serial_no}>
                  <Td className="font-mono text-[12px]">{d.serial_no}</Td>
                  <Td>{d.type}</Td>
                  <Td className="text-muted-foreground">{formatDate(d.issued_on)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 px-5 py-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn('text-right font-medium', mono && 'font-mono text-[12px]')}>{v}</dd>
    </div>
  )
}
