import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookMarked, ClipboardList, PackageOpen, Tags } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { useRouteFeature } from '@/lib/catalog'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice, Input, Select,
  Loading, SkeletonTable, SkeletonTiles, ErrorState, EmptyState, PrintButton,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* The rest of a librarian's year.

   The library screen could catalogue a book, issue it and fine you for keeping
   it. The three things a librarian does around that — telling the next reader
   the book is back, proving to an inspection that the register matches the
   shelves, and getting next year's textbooks in before June — had nowhere to
   live. */

interface Reservation {
  id: string
  title_id: string
  title: string
  author?: string
  reader: string
  reader_kind: string
  placed_at: string
  status: 'waiting' | 'ready' | 'collected' | 'expired' | 'cancelled'
  position: number
  ready_accession_no?: string
  collect_by?: string
  past_collection_date: boolean
  copies_on_shelf: number
}
interface Audit {
  id: string
  name: string
  opened_on: string
  closed_on?: string
  remarks?: string
  copies_expected: number
  copies_scanned: number
  copies_missing: number
  copies_on_loan: number
  copies_found_on_loan: number
}
interface Missing {
  copy_id: string
  accession_no: string
  title: string
  author?: string
  rack?: string
  status: string
}
interface Indent {
  id: string
  class_id: string
  class_name: string
  subject?: string
  title: string
  publisher: string
  qty_requested: number
  qty_received: number
  qty_issued: number
  indent_no?: string
  class_roll: number
  shortfall: number
}
interface Title {
  id: string
  title: string
  author?: string
}
interface Copy {
  id: string
  accession_no: string
  barcode?: string
  rack?: string
  status: string
}

const TABS = [
  ['holds', 'Holds', BookMarked],
  ['audit', 'Stock audit', ClipboardList],
  ['indent', 'Textbook indent', PackageOpen],
  ['labels', 'Spine labels', Tags],
] as const

export default function LibraryDesk() {
  /* Opened from the catalogue entry for the stock audit or the textbook
     indent, the desk starts on that tab rather than on the holds. */
  const { feature } = useRouteFeature()
  const [tab, setTab] = useState<(typeof TABS)[number][0]>(() => {
    switch (feature?.slug) {
      case 'annual_book_stock_verification': return 'audit'
      case 'new_session_textbook_orders': return 'indent'
      case 'barcode_spine_label_printing': return 'labels'
      default: return 'holds'
    }
  })

  const holds = useQuery({
    queryKey: ['library-reservations'],
    queryFn: () => api.get<List<Reservation>>('/api/v1/ops/library/reservations'),
  })
  const audits = useQuery({
    queryKey: ['library-audits'],
    queryFn: () => api.get<List<Audit>>('/api/v1/ops/library/audits'),
  })

  if (holds.isLoading) return <SkeletonTiles count={4} label="Opening the desk…" />
  if (holds.error) return <ErrorState error={holds.error} />

  const rows = holds.data?.items ?? []
  const ready = rows.filter((r) => r.status === 'ready')
  const waiting = rows.filter((r) => r.status === 'waiting')
  const open = (audits.data?.items ?? []).find((a) => !a.closed_on)

  return (
    <>
      <PageHead
        eyebrow="Library"
        title="Holds, stock and textbooks"
        description="Who is waiting for what, whether the shelves match the register, and where next year's textbook order has got to."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Waiting to be collected" value={ready.length} icon={BookMarked} />
          <Stat label="In a queue" value={waiting.length} />
          <Stat
            label="Missing at last count"
            value={open ? open.copies_missing : (audits.data?.items?.[0]?.copies_missing ?? 0)}
            icon={ClipboardList}
          />
          <Stat label="Audit" value={open ? 'Open' : 'Closed'} />
        </CellGrid>

        <div className="flex gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              aria-current={tab === k}
              className={
                tab === k
                  ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                  : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'
              }
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'holds' && <Holds rows={rows} />}
        {tab === 'audit' && <StockAudit audits={audits.data?.items ?? []} />}
        {tab === 'indent' && <Indents />}
        {tab === 'labels' && <SpineLabels />}
      </PageBody>
    </>
  )
}

function Holds({ rows }: { rows: Reservation[] }) {
  const qc = useQueryClient()
  const [titleId, setTitleId] = useState('')
  const [studentId, setStudentId] = useState('')

  const titles = useQuery({
    queryKey: ['library-titles'],
    queryFn: () => api.get<List<Title>>('/api/v1/ops/library/titles'),
  })
  const students = useQuery({
    queryKey: ['students', 'for-holds'],
    queryFn: () => api.get<List<{ id: string; full_name: string }>>('/api/v1/students?limit=300'),
  })

  const place = useMutation({
    mutationFn: () =>
      api.post('/api/v1/ops/library/reservations', { title_id: titleId, student_id: studentId }),
    onSuccess: () => {
      setStudentId('')
      qc.invalidateQueries({ queryKey: ['library-reservations'] })
    },
  })
  const decide = useMutation({
    mutationFn: (v: { id: string; action: string }) =>
      api.post(`/api/v1/ops/library/reservations/${v.id}/decide`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library-reservations'] }),
  })

  const live = rows.filter((r) => r.status === 'waiting' || r.status === 'ready')

  return (
    <>
      <Card>
        <CardHeader
          title="Place a hold"
          description="A hold is on the book, not on a particular copy — reserving one copy would leave a reader waiting behind a book that is lost while three identical ones sit on the shelf."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Book">
              <Select
                value={titleId}
                onChange={setTitleId}
                placeholder="Choose a title"
                options={(titles.data?.items ?? []).map((t) => ({
                  value: t.id,
                  label: t.author ? `${t.title} — ${t.author}` : t.title,
                }))}
              />
            </Field>
            <Field label="Reader">
              <Select
                value={studentId}
                onChange={setStudentId}
                placeholder="Choose a student"
                options={(students.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: s.full_name,
                }))}
              />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button disabled={place.isPending || !titleId || !studentId} onClick={() => place.mutate()}>
              {place.isPending ? 'Placing…' : 'Place hold'}
            </Button>
          </div>
          <FormNotice error={place.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="The queue"
          description="Books behind the counter first, then whoever is still waiting. When a copy comes back the next reader is promoted at that moment, not overnight."
        />
        {live.length === 0 ? (
          <EmptyState title="Nobody is waiting" body="Holds placed on a title appear here in the order they were made." />
        ) : (
          <Table
            head={[
              { label: 'Book' },
              { label: 'Reader' },
              { label: 'Placed' },
              { label: 'Queue' },
              { label: 'Status' },
              { label: '' },
            ]}
          >
            {live.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium">
                  {r.title}
                  {r.author && (
                    <div className="text-[12px] font-normal text-muted-foreground">{r.author}</div>
                  )}
                </Td>
                <Td>
                  {r.reader}
                  <div className="text-[12px] text-muted-foreground">{r.reader_kind}</div>
                </Td>
                <Td className="text-muted-foreground">{formatDate(r.placed_at)}</Td>
                <Td className="tabular-nums text-muted-foreground">
                  {r.status === 'waiting' ? `#${r.position}` : '—'}
                </Td>
                <Td>
                  {r.status === 'ready' ? (
                    <Badge tone={r.past_collection_date ? 'danger' : 'success'}>
                      {r.past_collection_date ? 'Uncollected' : `Ready · ${r.ready_accession_no}`}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">
                      {r.copies_on_shelf > 0 ? 'On shelf now' : 'All copies out'}
                    </Badge>
                  )}
                  {r.collect_by && (
                    <div className="text-[12px] text-muted-foreground">
                      Keep until {formatDate(r.collect_by)}
                    </div>
                  )}
                </Td>
                <Td>
                  <div className="flex gap-1">
                    {r.status === 'ready' && (
                      <>
                        <Button
                          size="sm"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: r.id, action: 'collect' })}
                        >
                          Collected
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: r.id, action: 'expire' })}
                        >
                          Not collected
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      tone="danger"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: r.id, action: 'cancel' })}
                    >
                      Cancel
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <FormNotice error={decide.error} />
      </Card>
    </>
  )
}

function StockAudit({ audits }: { audits: Audit[] }) {
  const qc = useQueryClient()
  const [code, setCode] = useState('')
  const [rack, setRack] = useState('')
  const [remarks, setRemarks] = useState('')
  const [last, setLast] = useState<string | null>(null)

  const open = audits.find((a) => !a.closed_on)

  const start = useMutation({
    mutationFn: () => api.post('/api/v1/ops/library/audits', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library-audits'] }),
  })
  const scan = useMutation({
    mutationFn: () =>
      api.post<{ title: string; accession_no: string; status: string; register_rack?: string; misshelved: boolean }>(
        `/api/v1/ops/library/audits/${open!.id}/scan`,
        { code, found_rack: rack },
      ),
    onSuccess: (d) => {
      setLast(
        d.misshelved
          ? `${d.title} — register says rack ${d.register_rack}, found in ${rack}`
          : `${d.title} · ${d.accession_no}${d.status === 'issued' ? ' — register says this is on loan' : ''}`,
      )
      setCode('')
      qc.invalidateQueries({ queryKey: ['library-audits', 'library-missing'] })
    },
  })
  const close = useMutation({
    mutationFn: () => api.post('/api/v1/ops/library/audits', { id: open!.id, close: true, remarks }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library-audits'] }),
  })
  const missing = useQuery({
    queryKey: ['library-missing', open?.id],
    queryFn: () => api.get<List<Missing>>(`/api/v1/ops/library/audits/${open!.id}/missing`),
    enabled: !!open,
  })

  if (!open) {
    return (
      <Card>
        <CardHeader
          title="No audit open"
          description="Walk the shelves scanning each book. Anything on the register that nobody scans is what is missing."
        />
        <div className="p-4">
          <Button disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? 'Opening…' : 'Start a stock audit'}
          </Button>
          <FormNotice error={start.error} />
        </div>
        {audits.length > 0 && (
          <Table head={[{ label: 'Audit' }, { label: 'Closed' }, { label: 'Missing' }, { label: 'Findings' }]}>
            {audits.map((a) => (
              <tr key={a.id}>
                <Td className="font-medium">{a.name}</Td>
                <Td className="text-muted-foreground">
                  {a.closed_on ? formatDate(a.closed_on) : '—'}
                </Td>
                <Td className="tabular-nums">{a.copies_missing}</Td>
                <Td className="text-muted-foreground">{a.remarks ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader
          title={open.name}
          description="Scan or type an accession number. Books recorded as on loan are not missing — an audit that says otherwise sends you hunting for books that are in children's bags."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Accession or barcode">
              <Input value={code} onChange={setCode} placeholder="ACC-0012" />
            </Field>
            <Field label="Shelf you are standing at" hint="Flags a book that is on the wrong rack.">
              <Input value={rack} onChange={setRack} placeholder="R2" />
            </Field>
          </FormGrid>
          <div className="mt-4 flex items-center gap-3">
            <Button disabled={scan.isPending || code.trim() === ''} onClick={() => scan.mutate()}>
              {scan.isPending ? 'Recording…' : 'Seen it'}
            </Button>
            {last && <span className="text-[13px] text-muted-foreground">{last}</span>}
          </div>
          <FormNotice error={scan.error} />
        </div>
        <CellGrid cols={4}>
          <Stat label="Should be on the shelf" value={open.copies_expected} />
          <Stat label="Scanned" value={open.copies_scanned} />
          <Stat label="Not found" value={open.copies_missing} />
          <Stat label="Out on loan" value={open.copies_on_loan} />
        </CellGrid>
        {open.copies_found_on_loan > 0 && (
          <p className="px-4 pb-4 text-[13px] text-muted-foreground">
            {open.copies_found_on_loan} book{open.copies_found_on_loan === 1 ? '' : 's'} scanned off
            the shelf that the register says {open.copies_found_on_loan === 1 ? 'is' : 'are'} on
            loan — worth reconciling before you close.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader title="Not found yet" description="Everything the register expects on the shelf that nobody has scanned." />
        {missing.isLoading ? (
          <SkeletonTable columns={3} label="Counting…" />
        ) : (missing.data?.items ?? []).length === 0 ? (
          <EmptyState title="Everything accounted for" body="Every book the register expects has been seen." />
        ) : (
          <Table head={[{ label: 'Accession' }, { label: 'Book' }, { label: 'Rack' }]}>
            {(missing.data?.items ?? []).map((m) => (
              <tr key={m.copy_id}>
                <Td className="font-mono text-[13px]">{m.accession_no}</Td>
                <Td>
                  {m.title}
                  {m.author && (
                    <div className="text-[12px] text-muted-foreground">{m.author}</div>
                  )}
                </Td>
                <Td className="text-muted-foreground">{m.rack ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Close the audit"
          description="Say what it found. An audit that ends with unaccounted books and no note is not an audit."
        />
        <div className="p-4">
          <Field label="What the audit found" required>
            <Input
              value={remarks}
              onChange={setRemarks}
              placeholder="Two titles unaccounted for; written off pending a second search."
            />
          </Field>
          <div className="mt-4">
            <Button
              disabled={close.isPending || remarks.trim() === ''}
              onClick={() => close.mutate()}
            >
              {close.isPending ? 'Closing…' : 'Close audit'}
            </Button>
          </div>
          <FormNotice error={close.error} />
        </div>
      </Card>
    </>
  )
}

function Indents() {
  const qc = useQueryClient()
  const [classId, setClassId] = useState('')
  const [title, setTitle] = useState('')
  const [qty, setQty] = useState('')
  const [indentNo, setIndentNo] = useState('')

  const list = useQuery({
    queryKey: ['textbook-indents'],
    queryFn: () => api.get<List<Indent>>('/api/v1/ops/library/indents'),
  })
  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/academics/classes'),
  })
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post('/api/v1/ops/library/indents', v),
    onSuccess: () => {
      setTitle('')
      setQty('')
      qc.invalidateQueries({ queryKey: ['textbook-indents'] })
    },
  })

  const rows = list.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="Raise a line"
          description="Consumable sets bought per child per year — ordered in February, delivered in May, handed out in June. Kept apart from the accession register, which is not for four hundred identical mathematics books."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Class">
              <Select
                value={classId}
                onChange={setClassId}
                placeholder="Choose a class"
                options={(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
              />
            </Field>
            <Field label="Book">
              <Input value={title} onChange={setTitle} placeholder="NCERT Mathematics — Ganit" />
            </Field>
            <Field label="Copies wanted">
              <Input value={qty} onChange={setQty} type="number" placeholder="48" />
            </Field>
            <Field label="Indent number">
              <Input value={indentNo} onChange={setIndentNo} placeholder="IND/2026/014" />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={save.isPending || !classId || !title.trim() || !qty}
              onClick={() =>
                save.mutate({
                  class_id: classId,
                  title,
                  qty_requested: Number(qty),
                  indent_no: indentNo,
                })
              }
            >
              {save.isPending ? 'Saving…' : 'Add to the indent'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="This year's indent"
          description="Three counts and three moments. The gaps between them are the reason to track it at all."
        />
        {rows.length === 0 ? (
          <EmptyState title="Nothing ordered yet" body="Add a line per class and book above." />
        ) : (
          <Table
            head={[
              { label: 'Class' },
              { label: 'Book' },
              { label: 'Roll' },
              { label: 'Wanted' },
              { label: 'Received' },
              { label: 'Handed out' },
              { label: 'Short' },
            ]}
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium">{r.class_name}</Td>
                <Td>
                  {r.title}
                  <div className="text-[12px] text-muted-foreground">
                    {r.publisher}
                    {r.indent_no && ` · ${r.indent_no}`}
                  </div>
                </Td>
                <Td className="tabular-nums text-muted-foreground">{r.class_roll}</Td>
                <Td className="tabular-nums">{r.qty_requested}</Td>
                <Td>
                  <Counter
                    value={r.qty_received}
                    onSave={(n) => save.mutate({ id: r.id, qty_received: n })}
                  />
                </Td>
                <Td>
                  <Counter
                    value={r.qty_issued}
                    onSave={(n) => save.mutate({ id: r.id, qty_issued: n })}
                  />
                </Td>
                <Td className="tabular-nums">
                  {r.shortfall > 0 ? (
                    <Badge tone="warning">{r.shortfall} short</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <FormNotice error={save.error} />
      </Card>
    </>
  )
}

/** An editable count that only saves when it actually changes. */
function Counter({ value, onSave }: { value: number; onSave: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  const dirty = draft !== String(value)
  return (
    <div className="flex items-center gap-1">
      <Input value={draft} onChange={setDraft} type="number" className="w-20" />
      {dirty && (
        <Button size="sm" onClick={() => onSave(Number(draft))}>
          Save
        </Button>
      )}
    </div>
  )
}

/* Code 39, because a label with a number printed on it is not a barcode.

   Chosen over Code 128 for being self-checking, needing no checksum, and
   encoding in nine elements per character with a fixed table — which is a
   forty-line function rather than a dependency. Every handheld reader a school
   is likely to own reads it. */
const CODE39: Record<string, string> = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
  '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
  '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw',
  E: 'wnnnwwnnn', F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn',
  I: 'nnwnnwwnn', J: 'nnnnwwwnn', K: 'wnnnnnnww', L: 'nnwnnnnww',
  M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn', P: 'nnwnwnnwn',
  Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn',
  U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw',
  Y: 'wwnnwnnnn', Z: 'nwwnwnnnn',
  '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn',
}

function Barcode({ value, height = 34 }: { value: string; height?: number }) {
  const text = `*${value.toUpperCase()}*`
  const narrow = 1
  const wide = 3
  const bars: { x: number; w: number }[] = []
  let x = 0
  for (const ch of text) {
    const pattern = CODE39[ch]
    if (!pattern) continue
    pattern.split('').forEach((el, i) => {
      const w = el === 'w' ? wide : narrow
      // Even indices are bars, odd are spaces.
      if (i % 2 === 0) bars.push({ x, w })
      x += w
    })
    x += narrow // inter-character gap
  }
  return (
    <svg
      viewBox={`0 0 ${x} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Barcode ${value}`}
    >
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={height} fill="currentColor" />
      ))}
    </svg>
  )
}

function SpineLabels() {
  const [titleId, setTitleId] = useState('')
  const titles = useQuery({
    queryKey: ['library-titles'],
    queryFn: () => api.get<List<Title>>('/api/v1/ops/library/titles'),
  })
  const copies = useQuery({
    queryKey: ['library-copies', titleId],
    queryFn: () => api.get<List<Copy>>(`/api/v1/ops/library/titles/${titleId}/copies`),
    enabled: !!titleId,
  })

  const title = (titles.data?.items ?? []).find((t) => t.id === titleId)
  const rows = copies.data?.items ?? []

  return (
    <Card>
      <CardHeader
        title="Spine labels"
        description="A sheet of call tags with a real Code 39 barcode, sized for a spine. Print on plain label stock — the numbers are the accession numbers already in the register."
        action={rows.length > 0 ? <PrintButton /> : undefined}
      />
      <div className="p-4 print:hidden">
        <Field label="Book">
          <Select
            value={titleId}
            onChange={setTitleId}
            placeholder="Choose a title"
            options={(titles.data?.items ?? []).map((t) => ({ value: t.id, label: t.title }))}
          />
        </Field>
      </div>
      {!titleId ? (
        <EmptyState title="Choose a book" body="Its copies each get a label with their own accession number." />
      ) : copies.isLoading ? (
        <Loading label="Loading copies…" />
      ) : (
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map((c) => (
            <div
              key={c.id}
              className="rounded-sm border p-2 text-center"
              style={{ breakInside: 'avoid' }}
            >
              <div className="truncate text-[11px] font-medium">{title?.title}</div>
              <div className="text-[11px] text-muted-foreground">
                {c.rack ? `Rack ${c.rack}` : 'Unshelved'}
              </div>
              <div className="mt-1 text-foreground">
                <Barcode value={c.barcode || c.accession_no} />
              </div>
              <div className="font-mono text-[11px] tracking-wider">{c.accession_no}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
