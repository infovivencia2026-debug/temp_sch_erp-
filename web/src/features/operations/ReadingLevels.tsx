import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Input, Button, Field, FormGrid,
  Loading, ErrorState, FormNotice, Dialog,
} from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'

/* Reading levels: each child's measured level, who is overdue for one, and
   what the library holds at each level. The level is whatever label the
   school uses; the product keeps the measurement and the date. */

interface Row { student_id: string; student_name: string; admission_no: string; class_name: string; class_level: number | null; expected_level: string | null; level: string | null; measured_on: string | null; note: string | null; books_read: number }
interface Band { class_level: number; label: string; note?: string }
interface Answer { items: Row[]; titles_by_level: { level: string; titles: number }[]; bands: Band[]; summary: { students: number; measured: number; never_measured: number; stale: number } }
interface History { id: string; level: string; measured_on: string; note?: string; measured_by?: string }

const today = () => new Date().toISOString().slice(0, 10)
/** Below the band when both labels carry a number and the child's is smaller (600L against 800L). Words compare by equality only. */
function belowBand(level: string, expected: string): boolean {
  const a = parseFloat(level), b = parseFloat(expected)
  return Number.isFinite(a) && Number.isFinite(b) ? a < b : false
}
const sixMonthsAgo = () => new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10)

export default function ReadingLevels() {
  const qc = useQueryClient()
  const [find, setFind] = useState('')
  const [only, setOnly] = useState<'' | 'never' | 'stale'>('')
  const [open, setOpen] = useState<Row | null>(null)
  const [form, setForm] = useState({ level: '', measured_on: today(), note: '' })
  const [editBands, setEditBands] = useState(false)
  const [bandRows, setBandRows] = useState<Band[] | null>(null)
  const saveBands = useMutation({
    mutationFn: (items: Band[]) => api.put('/api/v1/ops/library/reading-bands', { items }),
    onSuccess: () => { setEditBands(false); setBandRows(null); qc.invalidateQueries({ queryKey: ['reading-levels'] }) },
  })

  const q = useQuery({ queryKey: ['reading-levels'], queryFn: () => api.get<Answer>('/api/v1/ops/library/reading-levels') })
  const history = useQuery({
    queryKey: ['reading-levels', open?.student_id],
    queryFn: () => api.get<{ items: History[] }>(`/api/v1/ops/library/reading-levels/${open!.student_id}`),
    enabled: !!open,
  })
  const record = useMutation({
    mutationFn: () => api.post(`/api/v1/ops/library/reading-levels/${open!.student_id}`, { ...form, note: form.note || undefined }),
    onSuccess: () => {
      setForm({ level: '', measured_on: today(), note: '' })
      qc.invalidateQueries({ queryKey: ['reading-levels'] })
    },
  })

  if (q.isLoading) return <><PageHead eyebrow="Library" title="Reading levels" /><PageBody><Loading /></PageBody></>
  if (q.error) return <><PageHead eyebrow="Library" title="Reading levels" /><PageBody><ErrorState error={q.error} /></PageBody></>
  const d = q.data!
  const cutoff = sixMonthsAgo()
  const needle = find.trim().toLowerCase()
  const rows = d.items
    .filter((r) => only === '' || (only === 'never' ? !r.level : !!r.measured_on && r.measured_on < cutoff))
    .filter((r) => !needle || r.student_name.toLowerCase().includes(needle) || r.class_name.toLowerCase().includes(needle) || (r.level ?? '').toLowerCase().includes(needle))

  return (
    <>
      <PageHead eyebrow="Library" title="Reading levels" />
      <PageBody>
        <div className="space-y-4">
          <CellGrid cols={4}>
            <Stat label="Children" value={d.summary.students} onClick={() => setOnly('')} active={only === ''} />
            <Stat label="Measured" value={d.summary.measured} />
            <Stat label="Never measured" value={d.summary.never_measured} onClick={() => setOnly(only === 'never' ? '' : 'never')} active={only === 'never'} />
            <Stat label="Older than six months" value={d.summary.stale} onClick={() => setOnly(only === 'stale' ? '' : 'stale')} active={only === 'stale'} />
          </CellGrid>
          <Card>
            <CardHeader title="Expected band per class" description="What a child in each class is expected to read at. A child measured below it is marked."
              action={<Button variant="secondary" onClick={() => { setEditBands(!editBands); setBandRows(editBands ? null : (d.bands.length ? d.bands : [{ class_level: 1, label: '' }])) }}>{editBands ? 'Close' : d.bands.length ? 'Change' : 'Set bands'}</Button>} />
            {!editBands && (
              <div className="flex flex-wrap gap-2 px-5 pb-5">
                {d.bands.length === 0 && <p className="text-[13.5px] text-muted-foreground">No bands set. Children are listed without an expected level.</p>}
                {d.bands.map((b) => <span key={b.class_level} className="rounded-full border px-3 py-1 text-[13px]">Class {b.class_level}: {b.label}</span>)}
              </div>
            )}
            {editBands && bandRows && (
              <div className="space-y-2 px-5 pb-5">
                {bandRows.map((b, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Field label="Class level"><Input type="number" className="w-24" value={String(b.class_level)} onChange={(v) => setBandRows(bandRows.map((x, j) => j === i ? { ...x, class_level: Number(v) } : x))} /></Field>
                    <Field label="Band"><Input className="w-40" value={b.label} onChange={(v) => setBandRows(bandRows.map((x, j) => j === i ? { ...x, label: v } : x))} placeholder="600L" /></Field>
                    <Button variant="ghost" onClick={() => setBandRows(bandRows.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setBandRows([...bandRows, { class_level: (bandRows[bandRows.length - 1]?.class_level ?? 0) + 1, label: '' }])}>Add a class</Button>
                  <Button disabled={saveBands.isPending || bandRows.some((b) => !b.label.trim())} onClick={() => saveBands.mutate(bandRows)}>Save bands</Button>
                </div>
                <FormNotice error={saveBands.error} />
              </div>
            )}
          </Card>
          {d.titles_by_level.length > 0 && (
            <Card>
              <CardHeader title="Titles at each level" description="Set on a title in Books & copies." />
              <div className="flex flex-wrap gap-2 px-5 pb-5">
                {d.titles_by_level.map((t) => (
                  <button key={t.level} type="button" onClick={() => setFind(find === t.level ? '' : t.level)}
                    className={cn('rounded-full border px-3 py-1 text-[13px]', find === t.level ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
                    {t.level} · {t.titles}
                  </button>
                ))}
              </div>
            </Card>
          )}
          <Card>
            <CardHeader title="Each child" action={<Input className="w-56" value={find} onChange={setFind} placeholder="Find a child, class or level" />} />
            <Table head={['Student', 'Class', 'Level', 'Measured', { label: 'Books read', align: 'right' }, '']} empty={!rows.length} emptyLabel="No children match.">
              {rows.map((r) => (
                <tr key={r.student_id}>
                  <Td className="font-medium">{r.student_name}<span className="block font-mono text-[11.5px] font-normal text-muted-foreground">{r.admission_no}</span></Td>
                  <Td className="text-muted-foreground">{r.class_name}</Td>
                  <Td>
                    {r.level ?? <span className="text-muted-foreground">Not measured</span>}
                    {r.expected_level && <span className={cn('block text-[11.5px]', r.level && r.level !== r.expected_level && belowBand(r.level, r.expected_level) ? 'text-warning' : 'text-muted-foreground')}>
                      {r.level && belowBand(r.level, r.expected_level) ? `Below the ${r.expected_level} band` : `Expected ${r.expected_level}`}
                    </span>}
                    {r.note && <span className="block max-w-[28ch] truncate text-[11.5px] text-muted-foreground" title={r.note}>{r.note}</span>}
                  </Td>
                  <Td className={cn('text-muted-foreground', r.measured_on && r.measured_on < cutoff && 'text-warning')}>{r.measured_on ? formatDate(r.measured_on) : '-'}</Td>
                  <Td className="text-right tabular-nums">{r.books_read}</Td>
                  <Td><Button size="sm" variant="secondary" onClick={() => setOpen(r)}>Record</Button></Td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      </PageBody>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? `${open.student_name}, ${open.class_name}` : ''} size="md">
        {open && (
          <div className="space-y-4">
            <FormGrid>
              <Field label="Level" required hint="The label your school uses: 600L, Orange, Class 3.">
                <Input value={form.level} onChange={(v) => setForm({ ...form, level: v })} placeholder="600L" />
              </Field>
              <Field label="Measured on" required>
                <Input type="date" value={form.measured_on} onChange={(v) => setForm({ ...form, measured_on: v })} />
              </Field>
            </FormGrid>
            <Field label="Note">
              <Input value={form.note} onChange={(v) => setForm({ ...form, note: v })} placeholder="Reads fluently, stumbles on long words" />
            </Field>
            <FormNotice error={record.error} ok={record.isSuccess ? 'Recorded.' : undefined} />
            <Button disabled={!form.level.trim() || !form.measured_on || record.isPending} onClick={() => record.mutate()}>
              {record.isPending ? 'Saving…' : 'Record this level'}
            </Button>
            <div>
              <p className="eyebrow mb-2">Earlier measurements</p>
              {history.isLoading ? <Loading shape="inline" /> : (
                <Table head={['Level', 'On', 'Note', 'By']} empty={!(history.data?.items ?? []).length} emptyLabel="None yet.">
                  {(history.data?.items ?? []).map((h) => (
                    <tr key={h.id}>
                      <Td className="font-medium">{h.level}</Td>
                      <Td className="text-muted-foreground">{formatDate(h.measured_on)}</Td>
                      <Td className="text-muted-foreground">{h.note ?? '-'}</Td>
                      <Td className="text-muted-foreground">{h.measured_by ?? '-'}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </>
  )
}
