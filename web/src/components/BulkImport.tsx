import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload, Download, AlertTriangle, CheckCircle2, ClipboardPaste } from 'lucide-react'
import { api, actingInstitution } from '@/lib/api'
import { Button, Input, Table, Td } from '@/components/ui'

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
  id: string
  entity: string
  filename?: string
  rows_read: number
  rows_imported: number
  rows_rejected: number
  imported_by?: string
  created_at: string
  undone_at?: string
  /** How many records this upload created, as opposed to edited. Only these
   *  can be taken back out, so zero means there is nothing to undo. */
  created_rows: number
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

  /* Putting the file down again.
   *
   * Nothing has been written at this point — the dry run reads and reports —
   * so this only clears what is on screen. It exists because the preview
   * invites a decision and one of the two answers had no button. */
  const discard = () => {
    setCsv('')
    setName('')
    setResult(null)
    setGrid([])
    setShowAll(false)
    setError('')
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

        {/* Present the moment a file is loaded, and in every state after
            that.

            It used to live inside the results block, so it existed only when
            the file parsed cleanly — and disappeared exactly when it was most
            wanted, on the screen saying the headers are wrong. Somebody who
            has dropped the wrong file is then looking at a page with no way
            off it but a reload. */}
        {name && !pasting && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-[12.5px] text-muted-foreground">Reading: {name}</p>
            <button
              type="button"
              onClick={discard}
              className="text-[12.5px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
            >
              cancel this file
            </button>
          </div>
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
          <div className="mt-3">
            <p className="flex items-start gap-2 text-[13px] text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
              {error}
            </p>
            {/* Naming the box, because the commonest cause of a missing column
                is the right file in the wrong uploader — a page with four drop
                zones on it invites exactly that, and "needs a column called
                class" does not hint at which of the four you are in. */}
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              This box takes the <b>{entity.replace(/_/g, ' ')}</b> sheet.
            </p>
            <Button size="sm" variant="ghost" className="mt-2" onClick={discard}>
              Cancel
            </Button>
          </div>
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
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {/* Looking at the file is the point of showing it, and
                      deciding against it is a normal outcome. Without this the
                      only way out of a preview was to reload the page. */}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => send(csv, true)}>
                    {busy ? 'Uploading…' : `Upload these ${result.valid}`}
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={discard}>
                  Cancel
                </Button>
              )}
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
        {written && <IssueLogins entity={entity} />}
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
  const qc = useQueryClient()
  const [undoing, setUndoing] = useState('')
  const [outcome, setOutcome] = useState('')

  /* Taking one upload back out.
   *
   * Deletes only the records that upload created — every importer upserts, so
   * a corrected re-upload edits rows that were already there and undoing it
   * must not remove a class somebody typed in by hand. Rows something else now
   * depends on are kept and counted rather than cascaded away. */
  const undo = async (run: ImportRun) => {
    if (!confirm(
      `Remove the ${run.created_rows} ${run.created_rows === 1 ? 'record' : 'records'} ` +
      `that ${run.filename ?? 'this upload'} created? ` +
      'Anything it only updated, and anything now in use, is left alone.'
    )) return
    setUndoing(run.id)
    setOutcome('')
    try {
      const res = await api.post<{ removed: number; kept: number; reasons: string[] }>(
        `/api/v1/setup/import/history/${run.id}/undo`, {},
      )
      setOutcome(
        `${res.removed} removed` +
          (res.kept ? `, ${res.kept} kept because they are in use` : ''),
      )
      await qc.invalidateQueries()
    } catch (e) {
      setOutcome(e instanceof Error ? e.message : 'Could not undo that upload.')
    } finally {
      setUndoing('')
    }
  }

  // Which upload is open, and the file it was made from.
  const [openRun, setOpenRun] = useState('')
  const [seen, setSeen] = useState<{ rows: string[][]; omitted: boolean } | null>(null)
  const [loadingRun, setLoadingRun] = useState(false)

  /* Reading one upload back.
   *
   * The history said 4-staff.csv added ten rows and never said which ten,
   * which is the question anybody actually has when they open it — usually
   * because something looks wrong and they want to compare the sheet against
   * what is now in the school.
   *
   * Parsed with the same function a dropped file goes through, so what is
   * shown here and what was shown then are the same table by construction. */
  const openFile = async (run: ImportRun) => {
    if (openRun === run.id) {
      setOpenRun('')
      setSeen(null)
      return
    }
    setOpenRun(run.id)
    setSeen(null)
    setLoadingRun(true)
    try {
      const body = await api.get<{ content: string; omitted: boolean }>(
        `/api/v1/setup/import/history/${run.id}/content`,
      )
      setSeen({ rows: body.content ? parseCsv(body.content) : [], omitted: body.omitted })
    } catch {
      setSeen({ rows: [], omitted: false })
    } finally {
      setLoadingRun(false)
    }
  }

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
      {/* Capped and scrolled. A step that has been re-uploaded a dozen times
          was pushing the form off the screen with its own history. */}
      <div className="max-h-56 overflow-auto rounded-md border">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-muted">
            <tr className="text-left text-muted-foreground">
              <th className="px-2 py-1 pr-3 font-medium">File</th>
              <th className="py-1 pr-3 font-medium">When</th>
              <th className="py-1 pr-3 font-medium">By</th>
              <th className="py-1 pr-3 font-medium">Rows</th>
              <th className="py-1 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="py-1 pr-3">
                  <button
                    type="button"
                    onClick={() => openFile(r)}
                    className="underline underline-offset-2 hover:text-primary"
                    title="See what was in this file"
                  >
                    {r.filename ?? 'pasted cells'}
                  </button>
                </td>
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
                <td className="py-1 text-right">
                  {r.undone_at ? (
                    <span className="text-muted-foreground">undone</span>
                  ) : r.created_rows > 0 ? (
                    <button
                      type="button"
                      disabled={undoing === r.id}
                      onClick={() => undo(r)}
                      className="underline underline-offset-2 text-muted-foreground hover:text-destructive"
                    >
                      {undoing === r.id ? 'removing…' : `delete these ${r.created_rows}`}
                    </button>
                  ) : (
                    <span
                      className="text-muted-foreground"
                      title="This upload only updated records that already existed, so there is nothing of its own to remove."
                    >
                      nothing to remove
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {openRun && (
          <div className="mt-2 rounded-md border bg-muted/30 p-2">
            {loadingRun ? (
              <p className="text-[12.5px] text-muted-foreground">Reading the file…</p>
            ) : seen?.omitted ? (
              <p className="text-[12.5px] text-muted-foreground">
                That file was too large to keep a copy of, so only the counts were
                recorded.
              </p>
            ) : seen && seen.rows.length > 1 ? (
              <>
                <p className="mb-1.5 text-[12.5px] font-medium">
                  What was in this file
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    {seen.rows.length - 1} rows · {seen.rows[0].length} columns
                  </span>
                </p>
                <div className="max-h-72 overflow-auto rounded border bg-background">
                  <table className="w-full text-[12.5px]">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">#</th>
                        {seen.rows[0].map((h, i) => (
                          <th key={i} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {seen.rows.slice(1).map((row, ri) => (
                        <tr key={ri} className="border-t">
                          <td className="px-2 py-1 tabular-nums text-muted-foreground">{ri + 2}</td>
                          {seen.rows[0].map((_, ci) => (
                            <td key={ci} className="whitespace-nowrap px-2 py-1">{row[ci] ?? ''}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">
                No copy of this file was kept — it was uploaded before uploads began
                being stored.
              </p>
            )}
          </div>
        )}
      </div>
      {outcome && <p className="mt-2 text-[12.5px] text-muted-foreground">{outcome}</p>}
    </div>
  )
}

interface BulkLoginRow {
  name: string
  sign_in_as: string
  password?: string
  existing: boolean
  detail?: string
}
interface BulkLoginResult {
  created: number
  existing: number
  skipped: number
  rows: BulkLoginRow[]
  note: string
}

/**
 * Logins for everybody who was just imported.
 *
 * Sixty children arrive from one sheet and then need sixty accounts, and the
 * only way to make them was to open sixty records and press a button on each.
 * Nobody does that, so the parent portal goes unused in a school that paid
 * for it.
 *
 * Anybody who already has a login keeps it, and is listed with their username
 * and no password. That is the important half: the office issues the logins on
 * Monday, a class teacher runs this on Tuesday, and Tuesday must not quietly
 * replace what the families are already holding.
 */
function IssueLogins({ entity }: { entity: string }) {
  const [result, setResult] = useState<BulkLoginResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  // Finding one person in three hundred. A class teacher wants Aarav's
  // password, not a scroll through the whole school.
  const [find, setFind] = useState('')

  // Which kinds of person this sheet produces. A student list produces both
  // children and the guardians that came across on the same rows.
  const kinds =
    entity === 'students' ? ['students', 'guardians'] : entity === 'staff' ? ['staff'] : []
  if (!kinds.length) return null

  const run = async (kind: string, reset = false) => {
    if (reset && !confirm(
      'This replaces the password of everybody who already has one. ' +
      'Any password already handed out will stop working. Continue?'
    )) return
    setBusy(true)
    setFailed('')
    try {
      const body = await api.post<BulkLoginResult>('/api/v1/setup/logins/bulk', { kind, reset })
      setResult(body)
      setFind('')
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Could not issue the logins.')
    } finally {
      setBusy(false)
    }
  }

  /* Downloading is not a convenience here.
   *
   * The passwords are shown once and nothing can read them back, so a page
   * refresh with sixty unsaved passwords on it loses all sixty and the only
   * way out is to reset every one. */
  const download = () => {
    if (!result) return
    const csv = [
      ['name', 'sign_in_as', 'password', 'status'],
      ...result.rows.map((r) => [
        r.name,
        r.sign_in_as,
        r.password ?? '',
        r.existing ? 'already had a login' : r.detail ? r.detail : 'new',
      ]),
    ]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `logins-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mt-5 border-t pt-4">
      <p className="mb-1 text-[13px] font-medium">Give them logins</p>
      <p className="mb-3 text-[12.5px] text-muted-foreground">
        Anybody who already has one keeps it — nothing here changes a password
        somebody is already using.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {kinds.map((k) => (
          <Button key={k} size="sm" variant="secondary" disabled={busy} onClick={() => run(k)}>
            {busy ? 'Working…' : `Issue ${k} logins`}
          </Button>
        ))}
        {/* Separate button, separate confirm. A lost list of one-time
            passwords has no other way back, and the cost of the wrong press
            is every password in the school. */}
        {kinds.map((k) => (
          <Button
            key={`reset-${k}`}
            size="sm"
            variant="ghost"
            disabled={busy}
            title="Only if the list was lost — this stops the passwords already handed out"
            onClick={() => run(k, true)}
          >
            Reset all {k} passwords
          </Button>
        ))}
      </div>

      {failed && <p className="mt-2 text-[13px] text-destructive">{failed}</p>}

      {result && (
        <div className="mt-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
            <span className="text-success"><b className="tabular-nums">{result.created}</b> new</span>
            <span className="text-muted-foreground">
              <b className="tabular-nums">{result.existing}</b> already had one
            </span>
            {result.skipped > 0 && (
              <span className="text-destructive">
                <b className="tabular-nums">{result.skipped}</b> could not be given one
              </span>
            )}
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <Input
                value={find}
                onChange={setFind}
                placeholder="Find a name"
                className="w-44"
              />
              {result.created > 0 && (
                <Button size="sm" onClick={download}>
                  <Download className="h-3.5 w-3.5" />
                  Download the list
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setResult(null)}>
                Close
              </Button>
            </span>
          </div>
          {result.created > 0 && (
            <p className="mb-2 text-[12.5px] text-destructive">
              Download before you leave this page. The passwords are shown once and
              cannot be looked up again.
            </p>
          )}
          <div className="max-h-72 overflow-auto rounded-md border">
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Name</th>
                  <th className="px-2 py-1.5 text-left font-medium">Sign in as</th>
                  <th className="px-2 py-1.5 text-left font-medium">Password</th>
                </tr>
              </thead>
              <tbody>
                {result.rows
                  .filter(
                    (r) =>
                      !find.trim() ||
                      r.name.toLowerCase().includes(find.trim().toLowerCase()) ||
                      r.sign_in_as.toLowerCase().includes(find.trim().toLowerCase()),
                  )
                  .map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1">{r.name}</td>
                    <td className="px-2 py-1 font-mono">{r.sign_in_as || '—'}</td>
                    <td className="px-2 py-1 font-mono">
                      {r.password ? (
                        r.password
                      ) : (
                        <span className="font-sans text-muted-foreground">
                          {r.detail ?? 'already had a login'}
                        </span>
                      )}
                    </td>
                  </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
