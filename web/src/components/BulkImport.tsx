import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Upload, Download, AlertTriangle, CheckCircle2, ClipboardPaste } from 'lucide-react'
import { actingInstitution } from '@/lib/api'
import { Button, Table, Td } from '@/components/ui'

/* Adding a list you already have, instead of retyping it.
 *
 * A school setting up has its classes, its sections, its staff and its
 * students in spreadsheets already — that is what a school office is made of.
 * Typing eighty rows into a one-at-a-time form on the day you are deciding
 * whether the product is any good is the sort of thing that decides it.
 *
 * Two ways in, because schools have their data in two shapes:
 *
 *   Drop a CSV. Excel and Google Sheets both export one in two clicks.
 *   Paste the cells. Select the range in the sheet, Ctrl-V here. The clipboard
 *     carries tab-separated text, which is a CSV with different punctuation —
 *     and it saves the export step entirely, which for one column of section
 *     names is the difference between using this and not bothering.
 *
 * Nothing is written until the check has passed. The first upload is always a
 * dry run: it reports which rows are wrong, by row number, with the offending
 * values, so the fix happens in the spreadsheet where the data lives. A file
 * with any bad row writes nothing at all — a partial import leaves the office
 * reconciling what went in against what did not, which is more work than
 * fixing the sheet.
 */

interface Problem {
  row: number
  problem?: string
  data?: Record<string, string>
}
interface Result {
  total: number
  valid: number
  rejected: number
  imported: number
  dry_run: boolean
  problems: Problem[]
}

export default function BulkImport({
  entity,
  title,
  hint,
  onDone,
}: {
  /** classes | sections | staff — must be an entity the server imports. */
  entity: string
  title: string
  hint: string
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [csv, setCsv] = useState('')
  const [name, setName] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [paste, setPaste] = useState('')

  const send = async (text: string, commit: boolean) => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(
        `/api/v1/setup/import/${entity}${commit ? '?commit=true' : ''}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'text/csv',
            // A platform operator working inside a school must import into
            // that school, not into none.
            ...(actingInstitution() ? { 'X-Acting-Institution': actingInstitution()! } : {}),
          },
          body: text,
        },
      )
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error?.message ?? 'That file could not be read.')
        return
      }
      setResult(body as Result)
      if (commit && (body as Result).imported > 0) {
        // Everything on the page counts rows; none of it knows we just added
        // several hundred.
        qc.invalidateQueries()
        onDone?.()
      }
    } catch {
      setError('Could not reach the server. Nothing has been imported.')
    } finally {
      setBusy(false)
    }
  }

  const take = (text: string, label: string) => {
    setCsv(text)
    setName(label)
    setResult(null)
    void send(text, false)
  }

  const onFile = (f: File | undefined) => {
    if (!f) return
    if (f.size > 8 * 1024 * 1024) {
      setError('That file is over 8 MB. Split it, or ask us to run it as a migration.')
      return
    }
    const fr = new FileReader()
    fr.onload = () => take(String(fr.result ?? ''), f.name)
    fr.readAsText(f)
  }

  // Clipboard cells arrive tab-separated. Quoting the fields makes it a CSV
  // the server parses with the same reader as a file, rather than a second
  // parser to keep in step with the first.
  const fromPaste = () => {
    const rows = paste.trim().split(/\r?\n/).filter((r) => r.trim() !== '')
    if (!rows.length) return
    const csvText = rows
      .map((r) => r.split('\t').map((c) => `"${c.trim().replace(/"/g, '""')}"`).join(','))
      .join('\n')
    setPasting(false)
    take(csvText, `${rows.length - 1} pasted rows`)
  }

  const clean = result && result.rejected === 0 && result.valid > 0
  const written = result && !result.dry_run && result.imported > 0

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-[14px] font-medium">{title}</p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{hint}</p>
        </div>
        <a
          href={`/api/v1/setup/import/${entity}/template`}
          download
          className="inline-flex items-center gap-1.5 text-[12.5px] underline underline-offset-2"
        >
          <Download className="h-3.5 w-3.5" />
          Template
        </a>
      </div>

      <div className="p-4">
        {pasting ? (
          <div>
            <textarea
              autoFocus
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={7}
              placeholder={'Paste the cells straight from your spreadsheet.\nKeep the header row — the column names are how the fields are matched.'}
              className="field w-full font-mono text-[12.5px]"
            />
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={!paste.trim() || busy} onClick={fromPaste}>
                Check these rows
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setPasting(false); setPaste('') }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              onFile(e.dataTransfer.files?.[0])
            }}
            className={[
              'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'border-border',
            ].join(' ')}
          >
            <Upload className="h-5 w-5 text-muted-foreground" />
            <p className="text-[13.5px]">
              Drop a CSV here, or{' '}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="underline underline-offset-2"
              >
                choose a file
              </button>
            </p>
            <p className="text-[12.5px] text-muted-foreground">
              Exported from Excel or Google Sheets — or{' '}
              <button
                type="button"
                onClick={() => setPasting(true)}
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                <ClipboardPaste className="h-3 w-3" />
                paste the cells instead
              </button>
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
          </div>
        )}

        {name && !pasting && (
          <p className="mt-2 text-[12.5px] text-muted-foreground">Reading: {name}</p>
        )}

        {error && (
          <p className="mt-3 flex items-start gap-2 text-[13px] text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            {error}
          </p>
        )}

        {result && (
          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
              <span><b className="tabular-nums">{result.total}</b> rows read</span>
              <span className="text-success"><b className="tabular-nums">{result.valid}</b> ready</span>
              {result.rejected > 0 && (
                <span className="text-destructive"><b className="tabular-nums">{result.rejected}</b> need fixing</span>
              )}
              {written ? (
                <span className="ml-auto inline-flex items-center gap-1.5 text-success">
                  <CheckCircle2 className="h-4 w-4" />
                  {result.imported} added
                </span>
              ) : clean ? (
                <Button size="sm" className="ml-auto" disabled={busy} onClick={() => send(csv, true)}>
                  {busy ? 'Adding…' : `Add these ${result.valid}`}
                </Button>
              ) : null}
            </div>

            {result.rejected > 0 && (
              <div className="mt-3 overflow-x-auto">
                <p className="mb-2 text-[12.5px] text-muted-foreground">
                  Nothing has been added. Fix these rows in your spreadsheet and drop it again —
                  the row numbers match the file.
                </p>
                <Table head={['Row', 'Problem', 'What the row said']} empty={false}>
                  {result.problems.slice(0, 25).map((p, i) => (
                    <tr key={i}>
                      <Td className="tabular-nums">{p.row}</Td>
                      <Td className="text-destructive">{p.problem}</Td>
                      <Td className="text-[12px] text-muted-foreground">
                        {Object.entries(p.data ?? {})
                          .filter(([, v]) => v)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' · ') || '—'}
                      </Td>
                    </tr>
                  ))}
                </Table>
                {result.problems.length > 25 && (
                  <p className="mt-2 text-[12.5px] text-muted-foreground">
                    …and {result.problems.length - 25} more.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
