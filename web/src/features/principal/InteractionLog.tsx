import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Paperclip } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Input, Select, SkeletonTable, ErrorState,
} from '@/components/ui'
import { formatDateTime } from '@/lib/utils'

/* Everything that passed between two people, in one list.

   Messages between colleagues, a teacher's exchange with a family, the
   counsellor's thread, a remark written about a child, a fee taken at the
   counter: each lives on its own screen. This reads them together, most
   recent first, filtered by either person, a kind, a window and a search.
   Read-only; every row links to where it lives. See
   internal/api/interactions.go for what counts as an interaction. */

interface Row {
  at: string
  kind: string
  from_id?: string
  from_name: string
  to_id?: string
  to_name: string
  student_name?: string
  summary: string
  files: number
  link?: string
  ref_id: string
}

interface Person {
  id: string
  full_name: string
  side: string
}

const KIND_LABEL: Record<string, string> = {
  staff_message: 'Staff message',
  parent_message: 'Parent ↔ teacher',
  counselor_message: 'Counsellor thread',
  remark: 'Remark on a child',
  payment: 'Fee payment',
}

const KIND_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'primary'> = {
  staff_message: 'neutral',
  parent_message: 'info',
  counselor_message: 'warning',
  remark: 'primary',
  payment: 'success',
}

export default function InteractionLog() {
  const [a, setA] = useState<Person | null>(null)
  const [b, setB] = useState<Person | null>(null)
  const [kind, setKind] = useState('')
  const [days, setDays] = useState('30')
  const [q, setQ] = useState('')

  const params = new URLSearchParams({ days, limit: '500' })
  if (a) params.set('a', a.id)
  if (b) params.set('b', b.id)
  if (kind) params.set('kind', kind)
  if (q.trim()) params.set('q', q.trim())

  const { data, isLoading, error } = useQuery({
    queryKey: ['interactions', params.toString()],
    queryFn: () => api.get<List<Row>>(`/api/v1/admin/interactions?${params}`),
  })
  const rows = data?.items ?? []

  const exportCSV = () => {
    const esc = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
    const lines = ['when,kind,from,to,about,summary,files']
    for (const r of rows) {
      lines.push([r.at, KIND_LABEL[r.kind] ?? r.kind, r.from_name, r.to_name, r.student_name ?? '', r.summary, r.files].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const el = document.createElement('a')
    el.href = URL.createObjectURL(blob)
    el.download = `interactions-${new Date().toISOString().slice(0, 10)}.csv`
    el.click()
    URL.revokeObjectURL(el.href)
  }

  return (
    <>
      <PageHead
        eyebrow="Staff"
        title="Interaction log"
        description="Every message, remark, counselling reply and fee payment between people at this school, in one place. Pick one or two people to narrow it."
        actions={
          <Button variant="secondary" onClick={exportCSV} disabled={!rows.length}>
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        }
      />
      <PageBody>
        <Card>
          <CardHeader title="Who and what" />
          <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-5">
            <PersonPicker label="Person A" value={a} onChange={setA} />
            <PersonPicker label="Person B" value={b} onChange={setB} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Kind</span>
              <Select
                value={kind}
                onChange={setKind}
                options={[
                  { value: '', label: 'Everything' },
                  ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })),
                ]}
              />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Window</span>
              <Select
                value={days}
                onChange={setDays}
                options={[
                  { value: '7', label: 'Last 7 days' },
                  { value: '30', label: 'Last 30 days' },
                  { value: '90', label: 'Last 90 days' },
                  { value: '365', label: 'Last year' },
                ]}
              />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Search the text</span>
              <Input value={q} onChange={setQ} placeholder="A word, a name, a receipt number" />
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={`${rows.length} interaction${rows.length === 1 ? '' : 's'}`}
            description={
              a && b
                ? `Between ${a.full_name} and ${b.full_name}`
                : a
                  ? `Involving ${a.full_name}`
                  : b
                    ? `Involving ${b.full_name}`
                    : 'Across the whole school. Capped at 500; narrow it to see further back.'
            }
          />
          {isLoading ? (
            <SkeletonTable columns={6} />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table head={['When', 'Kind', 'From', 'To', 'About', 'What']} empty={!rows.length} emptyLabel="Nothing in this window.">
              {rows.map((r) => (
                <tr key={r.kind + r.ref_id}>
                  <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.at)}</Td>
                  <Td>
                    <Badge tone={KIND_TONE[r.kind] ?? 'neutral'}>{KIND_LABEL[r.kind] ?? r.kind}</Badge>
                  </Td>
                  <Td className="font-medium">{r.from_name}</Td>
                  <Td className="font-medium">{r.to_name}</Td>
                  <Td className="text-muted-foreground">{r.student_name ?? '-'}</Td>
                  <Td>
                    <span className="line-clamp-2 max-w-[40ch] whitespace-pre-wrap">{r.summary}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-[12px] text-muted-foreground">
                      {r.files > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Paperclip className="h-3 w-3" /> {r.files}
                        </span>
                      )}
                      {r.link && (
                        <Link to={r.link} className="text-primary underline-offset-2 hover:underline">
                          Open
                        </Link>
                      )}
                    </span>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function PersonPicker({ label, value, onChange }: { label: string; value: Person | null; onChange: (p: Person | null) => void }) {
  const [text, setText] = useState('')
  const { data } = useQuery({
    queryKey: ['interaction-people', text],
    queryFn: () => api.get<List<Person>>(`/api/v1/admin/interactions/people?q=${encodeURIComponent(text)}`),
    enabled: text.trim().length >= 2 && !value,
  })
  const options = data?.items ?? []
  return (
    <div className="block">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {value ? (
        <div className="mt-1 flex items-center gap-2">
          <Badge tone="primary">{value.full_name}</Badge>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Clear
          </Button>
        </div>
      ) : (
        <div className="relative mt-1">
          <Input value={text} onChange={setText} placeholder="Type a name" />
          {options.length > 0 && text.trim().length >= 2 && (
            <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-background shadow-md">
              {options.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="flex w-full items-baseline justify-between px-3 py-1.5 text-left text-[13.5px] hover:bg-muted"
                    onClick={() => {
                      onChange(p)
                      setText('')
                    }}
                  >
                    <span>{p.full_name}</span>
                    <span className="text-[12px] text-muted-foreground">{p.side}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
