import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Input, Loading, ErrorState,
} from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'
import { formatDate, formatPaise } from '@/lib/utils'

interface Cert {
  serial_no: string; type: string; student_name: string
  issued_on: string; status: string
  snapshot: Record<string, unknown>
}

const TYPES = [
  { value: 'BONAFIDE', label: 'Bonafide certificate' },
  { value: 'CONDUCT', label: 'Character certificate' },
  { value: 'TC', label: 'Transfer certificate' },
]

/** Certificates freeze a snapshot of the student at issue time, so an old TC
    keeps showing the class and dues it was issued with. */
export default function Certificates() {
  const nav = useRouteFeature()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [studentId, setStudentId] = useState('')
  const [type, setType] = useState('BONAFIDE')
  const [reason, setReason] = useState('')

  const results = useQuery({
    queryKey: ['cert-search', search],
    queryFn: () => api.get<Page<Student>>(`/api/v1/students?q=${encodeURIComponent(search)}&limit=10`),
    enabled: search.trim().length >= 2,
    placeholderData: keepPreviousData,
  })
  const list = useQuery({
    queryKey: ['certificates'],
    queryFn: () => api.get<List<Cert>>('/api/v1/lifecycle/certificates'),
  })
  const issue = useMutation({
    mutationFn: () => api.post<{ serial_no: string }>('/api/v1/lifecycle/certificates', {
      student_id: studentId, type_code: type, reason,
    }),
    onSuccess: () => {
      setStudentId(''); setSearch(''); setReason('')
      qc.invalidateQueries({ queryKey: ['certificates'] })
    },
  })

  const rows = list.data?.items ?? []

  return (
    <>
      {/* The name in the menu, not a second name invented here.

          A principal clicked "Certificates & transfers" under Students and
          arrived at "Administration / Certificates" — a different section and
          a different title, so nothing on the page confirmed they had landed
          where they aimed. The catalogue is what the menu, the command
          palette and search all read, which makes it the name that has to
          win. Read per route rather than hard-coded, because this screen is
          also reached from the registrar's own section under another name. */}
      <PageHead
        eyebrow={nav.section?.name ?? 'Students'}
        title={nav.feature?.name ?? 'Certificates & transfers'}
        description="Issue bonafide, character and transfer certificates with a numbered serial and a frozen record snapshot."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Issued" value={rows.length} />
          <Stat label="Transfer certificates" value={rows.filter((r) => r.type.includes('Transfer')).length}
            hint="Each one exits a student" />
          <Stat label="This month"
            value={rows.filter((r) => r.issued_on.slice(0, 7) === new Date().toISOString().slice(0, 7)).length} />
        </CellGrid>

        <Card>
          <CardHeader title="Issue a certificate" />
          <div className="space-y-3 p-5">
            <Input value={search} onChange={setSearch} placeholder="Search student by name or admission no." className="w-full" />
            {search.trim().length >= 2 && (
              <div className="flex flex-wrap gap-1.5">
                {(results.data?.items ?? []).map((s) => (
                  <button
                    key={s.id} type="button" onClick={() => setStudentId(s.id)}
                    className={`rounded-md border px-2 py-1 text-[13px] ${
                      studentId === s.id ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                    }`}
                  >
                    {s.full_name} · {s.admission_no}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <Select value={type} onChange={setType} options={TYPES} />
              <Input value={reason} onChange={setReason} placeholder="Reason (optional)" />
              <Button disabled={!studentId || issue.isPending} onClick={() => issue.mutate()}>
                {issue.isPending ? 'Issuing…' : 'Issue certificate'}
              </Button>
            </div>
            {type === 'TC' && (
              <p className="text-[13px] text-warning">
                A transfer certificate exits the student and closes their enrolment.
              </p>
            )}
            {issue.isError && (
              <p className="text-[13px] text-destructive">
                {issue.error instanceof Error ? issue.error.message : 'Could not issue'}
              </p>
            )}
            {issue.isSuccess && (
              <p className="text-[13px] text-success">Issued {issue.data.serial_no}.</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Register" description="Every certificate issued, with its frozen snapshot" />
          {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
            <Table head={['Serial', 'Type', 'Student', 'Class at issue', 'Dues at issue', 'Issued', 'Status']}
              empty={!rows.length} emptyLabel="No certificates issued yet.">
              {rows.map((c) => (
                <tr key={c.serial_no}>
                  <Td className="font-mono text-[12px]">{c.serial_no}</Td>
                  <Td className="font-medium">{c.type}</Td>
                  <Td>{c.student_name}</Td>
                  <Td>{String(c.snapshot?.class ?? '—')}</Td>
                  <Td>{formatPaise(Number(c.snapshot?.dues_paise ?? 0))}</Td>
                  <Td className="text-muted-foreground">{formatDate(c.issued_on)}</Td>
                  <Td><Badge tone="success">{c.status}</Badge></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
