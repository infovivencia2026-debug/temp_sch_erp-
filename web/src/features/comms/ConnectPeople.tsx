import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, apiPath } from '@/lib/api'
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Select, Table, Td, SEG_BAR, segClass } from '@/components/ui'
import { ExportRows, SearchBox, type Column } from '@/components/rows'

/* Students & parents (worker/src/routes/comms/yajur_connect_people.ts):
   every active student with each parent's number, straight from the ERP.
   "Has a number" means a number that can be read; the ERP does not know who
   is on WhatsApp. */

type Status = 'has_number' | 'no_number' | 'opted_out'
interface PersonRow {
  student_id: string; student_name: string; admission_no: string | null; class_id: string | null; class_name: string | null; section_name: string | null
  guardian_id: string | null; guardian_name: string | null; relation: string | null; phone: string | null; status: Status
}
interface PeopleList { items: PersonRow[]; classes: { id: string; name: string }[]; truncated: boolean }

const STATUS_LABEL: Record<Status, string> = { has_number: 'Has a number', no_number: 'No number', opted_out: 'Opted out' }
const STATUS_TONE: Record<Status, 'success' | 'neutral' | 'danger'> = { has_number: 'success', no_number: 'neutral', opted_out: 'danger' }
const SEGS: { value: '' | Status; label: string }[] = [{ value: '', label: 'All' }, ...(Object.keys(STATUS_LABEL) as Status[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))]
const classOf = (p: PersonRow) => [p.class_name, p.section_name].filter(Boolean).join(' ')
const parentOf = (p: PersonRow) => (p.guardian_name ? `${p.guardian_name}${p.relation ? ` (${p.relation})` : ''}` : '')

const EXPORT: Column<PersonRow>[] = [
  { header: 'Student', value: (p) => p.student_name },
  { header: 'Admission no', value: (p) => p.admission_no },
  { header: 'Class', value: classOf },
  { header: 'Parent', value: (p) => p.guardian_name },
  { header: 'Relation', value: (p) => p.relation },
  { header: 'Number', value: (p) => p.phone },
  { header: 'Status', value: (p) => STATUS_LABEL[p.status] },
]

export default function ConnectPeople({ onMessage }: { onMessage: (guardianId: string, studentId: string) => void }) {
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [classId, setClassId] = useState('')
  const [status, setStatus] = useState<'' | Status>('')
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(h) }, [q])
  const query = { q: term || undefined, class_id: classId || undefined, status: status || undefined }
  const list = useQuery({
    queryKey: ['connect', 'people', query],
    queryFn: () => api.get<PeopleList>(apiPath('GET /comms/yajur-connect/people', undefined, query)),
    placeholderData: keepPreviousData,
  })
  const d = list.data
  const items = d?.items ?? []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold sm:text-[22px]">Students &amp; parents</h1>
          <p className="text-[14px] text-muted-foreground">Every parent's number, from the student records.</p>
        </div>
        <ExportRows rows={items} columns={EXPORT} name="students-and-parents" />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchBox value={q} onChange={setQ} placeholder="Search name, admission no or number" className="w-full sm:w-72" />
        <div className="w-full sm:w-52">
          <Select value={classId} onChange={setClassId} placeholder="All classes"
            options={[{ value: '', label: 'All classes' }, ...(d?.classes ?? []).map((k) => ({ value: k.id, label: k.name }))]} />
        </div>
        <div className={SEG_BAR} role="tablist">
          {SEGS.map((s) => (
            <button key={s.value || 'all'} type="button" role="tab" aria-selected={status === s.value} className={segClass(status === s.value)} onClick={() => setStatus(s.value)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : items.length === 0 ? (
        <Card><EmptyState title="No students match." body="Students and parents come from the student records. Change the search or filters." /></Card>
      ) : (
        <>
          <Table head={['Student', 'Class', 'Parent', 'Number', 'Status', '']} noExport>
            {items.map((p) => (
              <tr key={`${p.student_id}:${p.guardian_id ?? ''}`}>
                <Td label="Student" className="max-w-[220px] truncate font-medium">{p.student_name}</Td>
                <Td label="Class" className="whitespace-nowrap">{classOf(p)}</Td>
                <Td label="Parent" className="max-w-[240px] truncate">{parentOf(p)}</Td>
                <Td label="Number" className="whitespace-nowrap tabular-nums">{p.phone ?? ''}</Td>
                <Td label="Status"><Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge></Td>
                <Td label="">
                  {p.status === 'has_number' && p.guardian_id && (
                    <Button size="sm" variant="secondary" onClick={() => onMessage(p.guardian_id!, p.student_id)}>Message</Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          {d?.truncated && <p className="text-[14px] text-muted-foreground">Showing the first 3000 rows. Search or choose a class to see the rest.</p>}
        </>
      )}
    </div>
  )
}
