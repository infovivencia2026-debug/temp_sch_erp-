import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload, Download, AlertTriangle, CheckCircle2, ClipboardPaste } from 'lucide-react'
import { api, actingInstitution } from '@/lib/api'
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

/* Parsing the file again, in the browser, purely to show it.
 *
 * The server parses it too and that parse is the one that counts. This one
 * exists so somebody can read their own file before agreeing to load it: the
 * screen used to say "3 rows read, 3 ready" and ask them to press a button,
 * which is asking somebody to vouch for a file they cannot see.
 *
 * Quoted fields, doubled quotes inside them, and newlines inside quotes are
 * all handled, because a school's address column contains commas and a
 * half-parsed preview is more alarming than no preview.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false }
      } else field += c
      continue
    }
    if (c === '"') { quoted = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((x) => x.trim() !== '')) rows.push(row)
      row = []
      continue
    }
    field += c
  }
  row.push(field)
  if (row.some((x) => x.trim() !== '')) rows.push(row)
  // Excel writes a byte order mark; it is invisible and would otherwise show
  // up glued to the first column heading.
  if (rows.length && rows[0].length) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '')
  return rows
}

interface ImportRun {
  entity: string
  filename?: string
  rows_read: number
  rows_imported: number
  rows_rejected: number
  imported_by?: string
  created_at: string
}

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
  endpoint,
  templateUrl,
}: {
  /** classes | sections | staff — must be an entity the server imports. */
  entity: string
  title: string
  hint: string
  onDone?: () => void
  /** Overrides for entities with an importer of their own. Students had one
   *  long before this component existed, and it knows about guardians and
   *  placement; pointing at it beats reimplementing it here. */
  endpoint?: string
  templateUrl?: string
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [csv, setCsv] = useState('')
  const [name, setName] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [grid, setGrid] = useState<string[][]>([])
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [paste, setPaste] = useState('')

  const send = async (text: string, commit: boolean) => {
    setBusy(true)
    setError('')
    try {
      const base = endpoint ?? `/api/v1/setup/import/${entity}`
      // The filename travels with the commit so the history can say
      // "students-final-v3.csv" rather than "312 rows".
      const q = commit ? `?commit=true&filename=${encodeURIComponent(name)}` : ''
      const res = await fetch(
        `${base}${q}`,
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
    setShowAll(false)
    setGrid(parseCsv(text))
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
          href={templateUrl ?? `/api/v1/setup/import/${entity}/template`}
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

        {/* The file itself, before anybody agrees to load it. Ten rows is
            enough to recognise your own spreadsheet and see that the columns
            landed where you meant them to; the rest is one click away. */}
        {grid.length > 1 && !written && (
          <div className="mt-3">
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[12.5px] font-medium">
                What is in this file
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {grid.length - 1} {grid.length === 2 ? 'row' : 'rows'} ·{' '}
                  {grid[0].length} columns
                </span>
              </p>
              {grid.length > 11 && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="text-[12.5px] underline underline-offset-2 text-muted-foreground"
                >
                  {showAll ? 'Show first 10' : `Show all ${grid.length - 1}`}
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-auto rounded-md border">
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">#</th>
                    {grid[0].map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                        {h || <span className="text-destructive">(no name)</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(showAll ? grid.slice(1) : grid.slice(1, 11)).map((r, ri) => (
                    <tr key={ri} className="border-t">
                      <td className="px-2 py-1 tabular-nums text-muted-foreground">{ri + 2}</td>
                      {grid[0].map((_, ci) => (
                        <td key={ci} className="whitespace-nowrap px-2 py-1">
                          {r[ci] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!showAll && grid.length > 11 && (
              <p className="mt-1 text-[12px] text-muted-foreground">
                Showing the first 10 of {grid.length - 1} rows.
              </p>
            )}
          </div>
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
                  {busy ? 'Uploading…' : `Upload these ${result.valid}`}
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
        <History entity={entity} refresh={written ? 1 : 0} />
      </div>
    </div>
  )
}

/**
 * What has been uploaded here before.
 *
 * Every importer reported a count on screen and forgot it the moment the page
 * refreshed, so "has somebody already loaded the class list?" was answerable
 * only by going to look at the rows and guessing. In an office where three
 * people share the work, the second person re-uploads because they cannot see
 * that the first already did.
 *
 * Not narrowed to the signed-in user: the whole point is to see somebody
 * else's upload.
 */
function History({ entity, refresh }: { entity: string; refresh: number }) {
  const q = useQuery({
    queryKey: ['import-history', entity, refresh],
    queryFn: () =>
      api.get<{ items: ImportRun[] }>(
        `/api/v1/setup/import/history?entity=${encodeURIComponent(entity)}`,
      ),
  })

  const runs = q.data?.items ?? []
  if (!runs.length) return null

  return (
    <div className="mt-5 border-t pt-4">
      <p className="mb-2 text-[12.5px] font-medium">
        Uploaded before
        <span className="ml-1.5 font-normal text-muted-foreground">
          {runs.length === 1 ? '1 time' : `${runs.length} times`}
        </span>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-medium">File</th>
              <th className="py-1 pr-3 font-medium">When</th>
              <th className="py-1 pr-3 font-medium">By</th>
              <th className="py-1 pr-3 font-medium">Rows</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="py-1 pr-3">{r.filename ?? 'pasted cells'}</td>
                <td className="py-1 pr-3 tabular-nums text-muted-foreground">
                  {r.created_at.replace('T', ' ').slice(0, 16)}
                </td>
                <td className="py-1 pr-3 text-muted-foreground">{r.imported_by ?? '—'}</td>
                <td className="py-1 pr-3 tabular-nums">
                  {r.rows_imported} added
                  {r.rows_rejected > 0 && (
                    <span className="text-destructive"> · {r.rows_rejected} rejected</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
