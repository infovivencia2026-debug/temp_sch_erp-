import { useMemo, useRef, useState } from 'react'
import { PickerMenu } from '@/components/PickerMenu'
import { useQueryClient } from '@tanstack/react-query'
import { Camera, FileSpreadsheet, Sparkles } from 'lucide-react'
import { Badge, Button, Checkbox, Dialog, FormNotice } from '@/components/ui'
import { cn } from '@/lib/utils'
import { smartImportApi, type Analysis, type ColumnMap, type ImportKind, type RunResult, type Table } from './smartApi'

/* IMPORT WITH AI.

   Any spreadsheet or a photo of a paper register. The server proposes what
   kind of records it holds and which column is which; the person checks,
   previews through the real importer's dry run, and only then imports. A
   photo is never imported as read: its table is shown, cell by cell, with
   the doubtful cells marked, and the person has to say they have checked it
   before anything else happens. */

type Step = 'pick' | 'review' | 'map' | 'preview' | 'done'

const pct = (n: number) => `${Math.round(n * 100)}%`
const confTone = (n: number) => (n >= 0.85 ? 'success' : n >= 0.6 ? 'warning' : 'danger') as 'success' | 'warning' | 'danger'

const SMART_KINDS = new Set(['students', 'classes', 'sections', 'subjects', 'periods', 'holidays', 'timetable', 'class_subjects', 'allocations',
  'attendance', 'staff_attendance', 'marks', 'student_history', 'staff', 'staff_history', 'fee_heads', 'fee_structures', 'fee_payments'])

export function ImportWithAIButton({ kind, onDone, size = 'sm', variant = 'secondary' }: {
  kind?: string; onDone?: () => void; size?: 'sm' | 'md'; variant?: 'primary' | 'secondary' | 'ghost' | 'outline'
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <Sparkles className="h-3.5 w-3.5" /> Import with AI
      </Button>
      {open && <SmartImport kind={kind && SMART_KINDS.has(kind) ? kind : undefined} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  )
}

export default function SmartImport({ kind: initialKind, onClose, onDone }: { kind?: string; onClose: () => void; onDone?: () => void }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('pick')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [a, setA] = useState<Analysis | null>(null)
  const [table, setTable] = useState<Table>({ headers: [], rows: [] })
  const [kinds, setKinds] = useState<ImportKind[]>([])
  const [kind, setKind] = useState(initialKind ?? '')
  const [mapping, setMapping] = useState<ColumnMap[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [reviewed, setReviewed] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)
  const [confirm, setConfirm] = useState(false)

  const kindDef = kinds.find((k) => k.key === kind)
  const uncertain = useMemo(() => new Set((a?.uncertain ?? []).map(([r, c]) => `${r}:${c}`)), [a])
  const run = async (f: () => Promise<void>) => { setBusy(true); setError(null); try { await f() } catch (e) { setError(e) } finally { setBusy(false) } }

  const pick = (file: File | undefined) => file && run(async () => {
    const res = await smartImportApi.analyze(file, initialKind)
    setA(res); setTable(res.table); setKinds(res.kinds)
    if (res.source === 'photo') { setReviewed(false); setStep('review'); return }
    applyProposal(res.proposal!)
    setStep('map')
  })
  const applyProposal = (p: NonNullable<Analysis['proposal']>) => { setKind(p.kind); setMapping(p.mapping); setNotes(p.notes) }

  const proposeFromReviewed = () => run(async () => {
    const res = await smartImportApi.propose(table, initialKind)
    setKinds(res.kinds); applyProposal(res.proposal); setStep('map')
  })
  const reKind = (k: string) => run(async () => {
    setKind(k)
    const res = await smartImportApi.propose(table, k)
    applyProposal(res.proposal)
  })
  const body = () => ({ kind, table, mapping: mapping.map((m) => ({ index: m.index, field: m.field })), source: a!.source, reviewed: a!.source === 'sheet' || reviewed, filename: a!.filename })
  const preview = () => run(async () => { setResult(await smartImportApi.preview(body())); setConfirm(false); setStep('preview') })
  const commit = () => run(async () => {
    setResult(await smartImportApi.commit(body()))
    setStep('done')
    qc.invalidateQueries()
    onDone?.()
  })

  const setCell = (r: number, c: number, v: string) => setTable((t) => ({ ...t, rows: t.rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)) }))
  const setHeader = (c: number, v: string) => setTable((t) => ({ ...t, headers: t.headers.map((h, j) => (j === c ? v : h)) }))
  const setField = (index: number, field: string) => setMapping((m) => m.map((x) => {
    if (x.index === index) return { ...x, field: field || null, confidence: 1, source: 'user' as const }
    return field && x.field === field ? { ...x, field: null, confidence: 0 } : x
  }))
  const missing = kindDef ? kindDef.required.filter((r) => !mapping.some((m) => m.field === r)) : []
  const problemsBySource = useMemo(() => {
    const m = new Map<number, string[]>()
    for (const p of result?.problems ?? []) if (p.source_row !== null && p.problem) m.set(p.source_row, [...(m.get(p.source_row) ?? []), p.problem])
    return m
  }, [result])

  /* The shared Dialog: Escape, the dim and the phone's Back close it, focus
     is trapped, and on a phone it is a bottom sheet with the steps pinned. */
  return (
    <Dialog
      onClose={onClose}
      size="xl"
      label="Import with AI"
      title={<span className="inline-flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />Import with AI</span>}
      description={step === 'pick' ? 'Any spreadsheet or a photo of a register' : step === 'review' ? 'Check what was read from the photo'
        : step === 'map' ? 'Check the columns' : step === 'preview' ? 'Preview: nothing is saved yet' : 'Done'}
      footer={step === 'pick' ? undefined : (
        <div className="flex w-full flex-wrap items-center gap-2">
          {step === 'review' && <>
            <Button size="sm" variant="ghost" onClick={() => setStep('pick')}>Back</Button>
            <Button size="sm" className="ml-auto" disabled={!reviewed || busy} pending={busy} onClick={proposeFromReviewed}>Match columns</Button>
          </>}
          {step === 'map' && <>
            <Button size="sm" variant="ghost" onClick={() => setStep(a?.source === 'photo' ? 'review' : 'pick')}>Back</Button>
            <Button size="sm" className="ml-auto" disabled={missing.length > 0 || busy} pending={busy} onClick={preview}>Preview</Button>
          </>}
          {step === 'preview' && result && <>
            <Button size="sm" variant="ghost" onClick={() => setStep('map')}>Change columns</Button>
            {confirm ? (
              <span className="ml-auto flex items-center gap-2 text-[13px]">
                Import {result.valid} row{result.valid === 1 ? '' : 's'} as {result.label}?
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>No</Button>
                <Button size="sm" pending={busy} disabled={busy} onClick={commit}>Yes, import</Button>
              </span>
            ) : (
              <Button size="sm" className="ml-auto" disabled={result.valid === 0 || busy} onClick={() => setConfirm(true)}>Import {result.valid} row{result.valid === 1 ? '' : 's'}</Button>
            )}
          </>}
          {step === 'done' && <Button size="sm" className="ml-auto" onClick={onClose}>Close</Button>}
        </div>
      )}
    >
          {error ? <div className="mb-3"><FormNotice error={error} /></div> : null}

          {step === 'pick' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-[10px] border border-dashed p-6 text-center hover:bg-muted/40 disabled:opacity-50">
                <FileSpreadsheet className="h-6 w-6 text-primary" />
                <span className="font-medium">Choose a spreadsheet</span>
                <span className="text-[12.5px] text-muted-foreground">CSV or Excel (.xlsx), in any layout. The columns are matched for you.</span>
              </button>
              <button type="button" disabled={busy} onClick={() => camRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-[10px] border border-dashed p-6 text-center hover:bg-muted/40 disabled:opacity-50">
                <Camera className="h-6 w-6 text-primary" />
                <span className="font-medium">Photo of a paper register</span>
                <span className="text-[12.5px] text-muted-foreground">Attendance register, marks sheet or class list. You check every cell before anything is imported.</span>
              </button>
              <input ref={fileRef} type="file" hidden accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
              <input ref={camRef} type="file" hidden accept="image/*" capture="environment"
                onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
              {busy && <p className="text-[13px] text-muted-foreground sm:col-span-2">Reading the file…</p>}
            </div>
          )}

          {step === 'review' && (
            <>
              <p className="mb-2 text-[13px]">
                Read from the photo{a?.notes ? `: ${a.notes}` : ''}. Compare it with the paper and correct anything wrong.
                {uncertain.size > 0 && <> Cells <span className="rounded bg-warning/20 px-1">marked like this</span> could not be read clearly.</>}
              </p>
              <EditableGrid table={table} uncertain={uncertain} onCell={setCell} onHeader={setHeader} />
              <div className="mt-3">
                <Checkbox checked={reviewed} onChange={setReviewed} label="I have checked every row against the paper" />
              </div>
            </>
          )}

          {step === 'map' && kindDef && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
                <span>This looks like</span>
                <PickerMenu ariaLabel="Kind of data" align="start" className={busy ? 'pointer-events-none opacity-60' : undefined} value={kind} onChange={reKind}
                  options={kinds.map((k) => ({ value: k.key, label: k.label }))} />
                {a?.ai ? <Badge tone="primary">matched by AI</Badge> : <Badge>matched by column names</Badge>}
                <span className="text-muted-foreground">{table.rows.length} rows</span>
              </div>
              {notes.length > 0 && <ul className="mb-3 list-disc pl-5 text-[12.5px] text-muted-foreground">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
              <div className="overflow-x-auto rounded-[10px] border">
                <table className="w-full text-[13px]">
                  <thead className="bg-muted/50 text-left"><tr><th className="px-3 py-2">Your column</th><th className="px-3 py-2">Example</th><th className="px-3 py-2">Goes into</th><th className="px-3 py-2">Sure?</th></tr></thead>
                  <tbody>
                    {mapping.map((m) => (
                      <tr key={m.index} className="border-t">
                        <td className="px-3 py-2 font-medium">{m.header}</td>
                        <td className="max-w-[16rem] truncate px-3 py-2 text-muted-foreground">{table.rows.find((r) => r[m.index])?.[m.index] ?? ''}</td>
                        <td className="px-3 py-2">
                          <PickerMenu ariaLabel={`Where ${m.header} goes`} align="start" value={m.field ?? ''} onChange={(v) => setField(m.index, v)}
                            options={[{ value: '', label: 'Skip this column' }, ...kindDef.columns.map((c) => ({ value: c, label: `${c.replace(/_/g, ' ')}${kindDef.required.includes(c) ? ' *' : ''}` }))]} />
                        </td>
                        <td className="px-3 py-2">{m.field ? (m.source === 'user' ? <Badge>you chose</Badge> : <Badge tone={confTone(m.confidence)}>{pct(m.confidence)}</Badge>) : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {missing.length > 0 && <p className="mt-2 text-[13px] text-destructive">Still needed: {missing.map((x) => x.replace(/_/g, ' ')).join(', ')}.</p>}
              <p className="mt-2 text-[12.5px] text-muted-foreground">Dates, class names (VI-A becomes your Grade 6, section A), phone numbers and P/A marks are tidied before the preview.</p>
            </>
          )}

          {(step === 'preview' || step === 'done') && result && (
            <>
              <div className="mb-3 flex flex-wrap gap-2 text-[13px]">
                {step === 'done'
                  ? <Badge tone="success">Imported {result.imported} of {result.total}</Badge>
                  : <Badge tone={result.rejected ? 'warning' : 'success'}>{result.valid} of {result.total} ready</Badge>}
                {result.rejected > 0 && <Badge tone="danger">{result.rejected} with problems</Badge>}
                {step === 'preview' && (result.changes?.length ?? 0) > 0 && <Badge tone="info">{result.changes!.length} values tidied</Badge>}
              </div>
              {step === 'done' && <p className="mb-3 text-[13px]">{result.run_id ? 'You can undo this import from Setup, Import history.' : ''} Rows with problems were skipped; fix them and import those again.</p>}
              {step === 'preview' && result.rows && (
                <div className="overflow-x-auto rounded-[10px] border">
                  <table className="w-full text-[12.5px]">
                    <thead className="bg-muted/50 text-left"><tr><th className="px-2 py-1.5">#</th>{result.fields.map((f) => <th key={f} className="px-2 py-1.5">{f.replace(/_/g, ' ')}</th>)}<th className="px-2 py-1.5">Problem</th></tr></thead>
                    <tbody>
                      {result.rows.slice(0, 200).map((r, i) => {
                        const src = result.source_rows?.[i] ?? i
                        const probs = problemsBySource.get(src)
                        return (
                          <tr key={i} className={cn('border-t', probs && 'bg-destructive/8')}>
                            <td className="px-2 py-1 text-muted-foreground">{src + 1}</td>
                            {result.fields.map((f) => <td key={f} className="whitespace-nowrap px-2 py-1">{r[f] ?? ''}</td>)}
                            <td className="px-2 py-1 text-destructive">{probs?.join('; ')}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {step === 'done' && result.problems.length > 0 && (
                <ul className="list-disc pl-5 text-[13px] text-destructive">
                  {result.problems.slice(0, 50).map((p, i) => <li key={i}>Row {(p.source_row ?? p.row - 2) + 1}: {p.problem}</li>)}
                </ul>
              )}
            </>
          )}
    </Dialog>
  )
}

function EditableGrid({ table, uncertain, onCell, onHeader }: {
  table: Table; uncertain: Set<string>; onCell: (r: number, c: number, v: string) => void; onHeader: (c: number, v: string) => void
}) {
  return (
    <div className="overflow-auto rounded-[10px] border">
      <table className="text-[12.5px]">
        <thead className="bg-muted/50">
          <tr>{table.headers.map((h, c) => (
            <th key={c} className="p-1"><input aria-label={`Column ${c + 1} heading`} className="field h-7 min-w-[6rem] font-semibold" value={h} onChange={(e) => onHeader(c, e.target.value)} /></th>
          ))}</tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r} className="border-t">
              {row.map((v, c) => (
                <td key={c} className="p-1">
                  <input aria-label={`Row ${r + 1}, ${table.headers[c]}`} value={v} onChange={(e) => onCell(r, c, e.target.value)}
                    className={cn('field h-7 min-w-[5rem]', uncertain.has(`${r}:${c}`) && 'bg-warning/20')} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The assistant's compact entry: an icon beside the paper-clip. */
export function AssistantImportWithAI({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={disabled}
        aria-label="Import with AI: any spreadsheet or a photo of a register" title="Import with AI: any spreadsheet or a photo of a register"
        className="grid size-8 shrink-0 place-items-center rounded-full border transition-colors hover:bg-accent disabled:opacity-40">
        <Sparkles className="size-3.5" />
      </button>
      {open && <SmartImport onClose={() => setOpen(false)} />}
    </>
  )
}
