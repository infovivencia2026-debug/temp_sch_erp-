import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Upload, Download, AlertTriangle, CheckCircle2, ClipboardPaste, Maximize2, Minimize2,
} from 'lucide-react'
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
export function parseCsv(text: string): string[][] {
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
interface ImportField {
  name: string
  required: boolean
  example?: string
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
  params,
  subjectMapping,
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
  /** Facts true of the whole sheet rather than of one row, sent with it. A
   *  grid mark sheet is one exam, of one class, in one year, out of one
   *  maximum; repeating those on every row is how one typo puts one child's
   *  paper out of ten. */
  params?: Record<string, string>
  /** Lets the clerk say which of their columns hold marks, and for which
   *  subject. Only a mark sheet needs this. */
  subjectMapping?: boolean
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [csv, setCsv] = useState('')
  const [name, setName] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [grid, setGrid] = useState<string[][]>([])
  const [showAll, setShowAll] = useState(false)
  /* Whatever is open in its own window: the file about to be uploaded, or
     one opened out of the history. Held here rather than in each place so
     only one can be open, and so the history's own panel does not have to
     grow a table inside a table inside a step. */
  const [expanded, setExpanded] = useState<{ title: string; rows: string[][] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [paste, setPaste] = useState('')
  /* WHICH OF YOUR COLUMNS IS WHICH OF OURS.

     Header matching only ever normalised case and spacing, so a sheet saying
     "Adm No" where we say "admission_no" did not fail loudly -- it imported
     every child with a generated admission number, because that column was
     never seen.

     Nothing is guessed. A guessed mapping that is wrong is worse than none:
     it imports, it reports success, and the mistake is found months later in
     a column nobody thought to check. So every field is pointed at a column
     by a person, and a field left alone is a field this file does not carry. */
  const [colMap, setColMap] = useState<Record<string, string>>({})
  /* their header -> the subject whose marks it holds.
   *
   * Which columns are subjects cannot be worked out from the file: "Total",
   * "Rank", "Attendance" and "Remarks" sit in the same header row and are not
   * subjects. Guessing wrong writes a child's total into a paper nobody sat,
   * so it is asked. */
  const [subjectMap, setSubjectMap] = useState<Record<string, string>>({})

  const fields = useQuery({
    queryKey: ['import-fields', entity],
    queryFn: () => api.get<{ fields: ImportField[] }>(
      `/api/v1/setup/import/${entity}/fields`),
  })

  const theirHeaders = grid.length ? grid[0] : []
  const fieldList = fields.data?.fields ?? []
  const missing = fieldList
    .filter((f) => f.required && !colMap[f.name])
    .map((f) => f.name)

  const send = async (text: string, commit: boolean) => {
    setBusy(true)
    setError('')
    try {
      const base = endpoint ?? `/api/v1/setup/import/${entity}`
      // The filename travels with the commit so the history can say
      // "students-final-v3.csv" rather than "312 rows".
      const qs = new URLSearchParams()
      if (commit) {
        qs.set('commit', 'true')
        qs.set('filename', name)
      }
      for (const [k, v] of Object.entries(params ?? {})) {
        if (v) qs.set(k, v)
      }
      const query = qs.toString()
      const q = query ? `?${query}` : ''
      const res = await fetch(
        `${base}${q}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'text/csv',
            // Sent beside the file rather than wrapped around it, so the same
            // request works from a script and from this screen.
            /* Subject columns travel in the same map under a subject:
               prefix, so there is one mechanism for "which of your columns is
               this" rather than two that can disagree. */
            ...(Object.keys({ ...colMap, ...subjectMap }).length
              ? {
                  'X-Column-Map': JSON.stringify({
                    ...colMap,
                    ...Object.fromEntries(
                      Object.entries(subjectMap)
                        .filter(([, subject]) => subject.trim())
                        .map(([header, subject]) => [`subject:${subject.trim()}`, header]),
                    ),
                  }),
                }
              : {}),
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
    setColMap({})
    setSubjectMap({})
  }

  const take = (text: string, label: string) => {
    const rows = parseCsv(text)
    setCsv(text)
    setName(label)
    setResult(null)
    setShowAll(false)
    setGrid(rows)

    /* A HEADER THAT IS ALREADY OUR NAME IS NOT A GUESS.

       Only an exact match is filled in, after the same normalising the server
       does -- "Admission No" and "admission_no" are the same word, not a
       resemblance. Anything that merely looks similar is left empty for a
       person to decide, because a plausible wrong match is the failure this
       screen exists to prevent: it imports, it says it worked, and the error
       surfaces months later in a column nobody thought to check.

       A file written from our own template therefore needs no work, and a
       school's own sheet is mapped by hand. */
      const norm = (h: string) =>
        h.replace(/^\ufeff/, '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    const byName = new Map((rows[0] ?? []).map((h) => [norm(h), h]))
    const exact: Record<string, string> = {}
    for (const f of fields.data?.fields ?? []) {
      const hit = byName.get(norm(f.name))
      if (hit) exact[f.name] = hit
    }
    setColMap(exact)
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
          className="inline-flex items-center gap-1.5 text-[12.5px] tap-inline underline underline-offset-2"
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
                className="tap-inline underline underline-offset-2"
              >
                choose a file
              </button>
            </p>
            <p className="text-[12.5px] text-muted-foreground">
              Exported from Excel or Google Sheets — or{' '}
              <button
                type="button"
                onClick={() => setPasting(true)}
                className="inline-flex items-center gap-1 tap-inline underline underline-offset-2"
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
              className="text-[12.5px] tap-inline underline underline-offset-2 text-muted-foreground hover:text-foreground"
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
              <span className="flex items-center gap-3">
                {grid.length > 11 && (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="text-[12.5px] tap-inline underline underline-offset-2 text-muted-foreground"
                  >
                    {showAll ? 'Show first 10' : `Show all ${grid.length - 1}`}
                  </button>
                )}
                {/* Eighteen columns in a panel this tall is a file you scroll
                    rather than one you read. */}
                <button
                  type="button"
                  onClick={() => setExpanded({ title: name || 'This file', rows: grid })}
                  className="inline-flex items-center gap-1 text-[12.5px] tap-inline underline underline-offset-2 text-muted-foreground"
                >
                  <Maximize2 className="h-3 w-3" />
                  expand
                </button>
              </span>
            </div>
            <div className="max-h-80 overflow-auto rounded-md border">
              <SheetTable rows={grid} limit={showAll ? undefined : 10} />
            </div>
            {!showAll && grid.length > 11 && (
              <p className="mt-1 text-[12px] text-muted-foreground">
                Showing the first 10 of {grid.length - 1} rows.
              </p>
            )}
          </div>
        )}

        {!!grid.length && !result && (
          <div className="mt-4 rounded-md border">
            <div className="border-b px-3 py-2">
              <p className="text-[13px] font-medium">Which column is which</p>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                Point each field we need at a column of your file. Anything you
                leave alone is not imported. Nothing is matched for you unless
                your header is already the same word.
              </p>
            </div>
            <div className="max-h-72 overflow-y-auto divide-y">
              {fieldList.map((f) => (
                <div key={f.name} className="flex items-center gap-3 px-3 py-2">
                  <div className="w-48 flex-none">
                    <p className="text-[13px]">
                      {f.name.replace(/_/g, ' ')}
                      {f.required && <span className="text-destructive"> *</span>}
                    </p>
                    {f.example && (
                      <p className="text-[11.5px] text-muted-foreground">
                        like {f.example}
                      </p>
                    )}
                  </div>
                  <select
                    className="h-8 flex-1 rounded-md border bg-surface px-2 text-[13px]"
                    value={colMap[f.name] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      setColMap((m) => {
                        const next = { ...m }
                        if (v) next[f.name] = v
                        else delete next[f.name]
                        return next
                      })
                    }}
                  >
                    <option value="">Not in my file</option>
                    {theirHeaders.map((h, i) => (
                      <option key={`${h}-${i}`} value={h}>{h}</option>
                    ))}
                  </select>
                  {/* The first row's value under the chosen column, because a
                      column of ADM0019s identifies itself faster than any
                      header does. */}
                  <span className="w-40 flex-none truncate text-[12px] text-muted-foreground">
                    {colMap[f.name] && grid[1]
                      ? grid[1][theirHeaders.indexOf(colMap[f.name])] ?? ''
                      : ''}
                  </span>
                </div>
              ))}
            </div>
            {subjectMapping && (
              <div className="border-t">
                <div className="px-3 py-2">
                  <p className="text-[13px] font-medium">Which columns hold marks</p>
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                    Name the subject each marks column belongs to. Leave the
                    rest \u2014 Total, Rank, Attendance, Remarks \u2014 empty: they are
                    worked out from the marks, not read from the sheet.
                  </p>
                </div>
                <div className="max-h-56 overflow-y-auto divide-y">
                  {theirHeaders
                    .filter((h) => !Object.values(colMap).includes(h))
                    .map((h, i) => (
                      <div key={`${h}-${i}`} className="flex items-center gap-3 px-3 py-1.5">
                        <span className="w-48 flex-none truncate text-[13px]">{h}</span>
                        <Input
                          value={subjectMap[h] ?? ''}
                          onChange={(v) => setSubjectMap((m) => ({ ...m, [h]: v }))}
                          placeholder="Subject name, or leave empty"
                        />
                        <span className="w-24 flex-none truncate text-[12px] text-muted-foreground">
                          {grid[1]?.[theirHeaders.indexOf(h)] ?? ''}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
              {missing.length > 0 ? (
                <p className="text-[12.5px] text-warning">
                  Still to choose: {missing.map((m) => m.replace(/_/g, ' ')).join(', ')}
                </p>
              ) : (
                <p className="text-[12.5px] text-muted-foreground">
                  {fieldList.length - Object.keys(colMap).length} of{' '}
                  {fieldList.length} fields not in this file, and will be left
                  empty.
                </p>
              )}
              <span className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={discard}>Cancel</Button>
                <Button
                  size="sm"
                  disabled={busy || missing.length > 0}
                  onClick={() => send(csv, false)}
                >
                  {busy ? 'Checking\u2026' : 'Check the file'}
                </Button>
              </span>
            </div>
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
              <div className="mt-4 scroll-x">
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
        <History entity={entity} refresh={written ? 1 : 0} onOpen={setExpanded} />
      </div>
      {/* Its own window, over everything. The file is the thing being looked
          at, so it gets the screen rather than a panel inside a panel. */}
      {expanded && (
        <SheetViewer
          title={expanded.title}
          rows={expanded.rows}
          onClose={() => setExpanded(null)}
        />
      )}
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
function History({
  entity,
  refresh,
  onOpen,
}: {
  entity: string
  refresh: number
  onOpen: (v: { title: string; rows: string[][] }) => void
}) {
  const qc = useQueryClient()
  const [undoing, setUndoing] = useState('')
  const [outcome, setOutcome] = useState('')

  /* Taking one upload back out.
   *
   * Deletes only the records that upload created — every importer upserts, so
   * a corrected re-upload edits rows that were already there and undoing it
   * must not remove a class somebody typed in by hand. Rows something else now
   * depends on are kept and counted rather than cascaded away. */
  /* A BROWSER CONFIRM IS NOT A WARNING.
   *
   * This is the one control in the product that destroys records outright,
   * and it asked through window.confirm -- a grey box people dismiss without
   * reading, that cannot say which children are about to go, and that some
   * browsers suppress entirely after a few appearances.
   *
   * So the warning is part of the page: it names the file, counts exactly what
   * will be destroyed, says plainly that it cannot be undone, and puts the
   * destructive answer on the right where a mis-click lands on Cancel. */
  const [confirming, setConfirming] = useState<ImportRun | null>(null)

  const undo = async (run: ImportRun) => {
    setConfirming(null)
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

  const [loadingRun, setLoadingRun] = useState('')
  const [failedRun, setFailedRun] = useState('')

  /* Reading one upload back, into a window of its own.

     It used to unfold inside the history block: a table nested in a panel
     nested in a step, eighteen columns wide in a space three hundred pixels
     tall. The file is the thing being looked at, so it gets the screen. */
  const openFile = async (run: ImportRun) => {
    setLoadingRun(run.id)
    setFailedRun('')
    try {
      const body = await api.get<{ content: string; omitted: boolean }>(
        `/api/v1/setup/import/history/${run.id}/content`,
      )
      if (body.omitted) {
        setFailedRun('That file was too large to keep a copy of, so only the counts were recorded.')
        return
      }
      const rows = body.content ? parseCsv(body.content) : []
      if (rows.length < 2) {
        setFailedRun('No copy of this file was kept — it was uploaded before uploads began being stored.')
        return
      }
      onOpen({ title: run.filename ?? 'This upload', rows })
    } catch {
      setFailedRun('Could not read that file back.')
    } finally {
      setLoadingRun('')
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
    <div className="mt-4 border-t pt-4">
      <p className="mb-2 text-[12.5px] font-medium">
        Uploaded before
        <span className="ml-1.5 font-normal text-muted-foreground">
          {runs.length === 1 ? '1 time' : `${runs.length} times`}
        </span>
      </p>
      {/* Capped and scrolled, in both directions.

          The cap was the easy half: a step re-uploaded a dozen times was
          pushing the form off the screen with its own history, so the box got
          a height and a scrollbar.

          The hard half is the width, and it was wrong. This table is
          hand-rolled rather than the shared `Table`, so the `NARROW_WIDE` rule
          that recently taught narrow tables to scroll sideways never reached
          it -- and `w-full` on five columns inside a 265px panel does not
          decline to fit, it breaks words to fit. The result was a filename
          reading "vig/nan" over two lines and a status reading "un/do/ne",
          which is worse than a scrollbar by every measure: it is slower to
          read, it is ambiguous about whether the hyphen is in the data, and it
          makes a row two or three times taller than the one above it.

          `w-max min-w-full` is the same shape as the shared component's fix.
          The table fills the box when the box is wide enough and takes its
          natural content width when it is not, and the `overflow-auto` that
          was already here carries it sideways. `whitespace-nowrap` on the
          cells is what actually forbids the break: without it the table would
          still choose to shrink a column rather than overflow.

          Not editing ui.tsx to share the constant, because this table wants
          the behaviour at every width rather than only between 640 and 900. */}
      <div className="max-h-56 overflow-auto rounded-md border">
        <table
          className="w-max min-w-full text-[12.5px]
                     [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap
                     [&_td:first-child]:pl-2 [&_th:first-child]:pl-2
                     [&_td:last-child]:pr-2 [&_th:last-child]:pr-2"
        >
          <thead className="sticky top-0 bg-muted">
            <tr className="text-left text-muted-foreground">
              {/* The header carried `px-2` that no body cell carried, so
                  "File" sat 7px right of the filename underneath it. The inset
                  off the box border is now stated once on the table, for the
                  first and last cell of every row, so a header and the column
                  under it cannot disagree about it again. */}
              <th className="py-1 pr-3 font-medium">File</th>
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
                    className="tap-inline underline underline-offset-2 hover:text-primary"
                    title="Open this file"
                  >
                    {r.filename ?? 'pasted cells'}
                    {loadingRun === r.id && ' …'}
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
                      onClick={() => setConfirming(r)}
                      className="tap-inline underline underline-offset-2 text-muted-foreground hover:text-destructive"
                    >
                      {undoing === r.id ? 'deleting\u2026' : `delete these ${r.created_rows}`}
                    </button>
                  ) : (
                    /* "nothing to remove" beside "139 added" reads as the
                       delete being broken, and for two importers it was: class
                       subjects and the timetable recorded nothing they
                       created, so their uploads said both things at once for
                       ever. Fixed at the source; this now distinguishes the
                       two reasons a row has nothing of its own. */
                    <span
                      className="text-muted-foreground"
                      title={r.rows_imported > 0
                        ? 'This upload changed records that already existed rather than creating new ones, or predates the record of what an upload created.'
                        : 'This upload created nothing.'}
                    >
                      {r.rows_imported > 0 ? 'only updated existing' : 'nothing to remove'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirming && (
        <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/5 p-3">
          <p className="text-[13px] font-medium text-destructive">
            Delete {confirming.created_rows}{' '}
            {confirming.created_rows === 1 ? 'record' : 'records'} permanently?
          </p>
          <p className="mt-1 text-[12.5px]">
            Everything <span className="font-medium">{confirming.filename ?? 'this upload'}</span>{' '}
            created is removed from the database. This cannot be undone, and
            there is no copy kept.
          </p>
          {/* The limits, said before rather than discovered after. Somebody
              deleting an upload usually believes it will put the school back
              exactly as it was, and on two counts it will not. */}
          <ul className="mt-1.5 list-disc pl-4 text-[12.5px] text-muted-foreground">
            <li>
              Records this upload only <span className="italic">changed</span> keep
              their new values. The old ones are not restored.
            </li>
            <li>
              Anything now in use \u2014 a child with attendance, a class with a
              timetable \u2014 is kept and counted, not deleted.
            </li>
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            {/* The destructive answer is second, so the reflex click lands on
                Cancel rather than on the deletion. */}
            <Button
              size="sm"
              /* The button palette has no destructive variant, so the
                 danger is carried by the panel around it and by the words on
                 it. Better than inventing a red button that exists nowhere
                 else in the product. */
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={undoing === confirming.id}
              onClick={() => undo(confirming)}
            >
              Yes, delete permanently
            </Button>
          </div>
        </div>
      )}
      {failedRun && <p className="mt-2 text-[12.5px] text-muted-foreground">{failedRun}</p>}
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
    <div className="mt-4 border-t pt-4">
      <p className="mb-1 text-[13px] font-medium">Give them logins</p>
      <p className="mb-4 text-[12.5px] text-muted-foreground">
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

/**
 * A parsed sheet, drawn as a table.
 *
 * The same component inline and full screen, because a preview cramped into a
 * panel and a preview that fills the window should not be two pieces of code
 * that slowly stop agreeing about what the file said.
 */
function SheetTable({ rows, limit }: { rows: string[][]; limit?: number }) {
  const body = limit ? rows.slice(1, limit + 1) : rows.slice(1)
  return (
    <table className="w-full text-[12.5px]">
      <thead className="sticky top-0 bg-muted">
        <tr>
          {/* Fixed and unwrapped. The column was sized by its content, so a
              two-digit row number broke across two lines and every row after
              row nine was twice as tall as the ones above it. */}
          <th className="w-10 whitespace-nowrap px-2 py-1.5 text-right font-medium text-muted-foreground">
            #
          </th>
          {rows[0].map((h, i) => (
            <th key={i} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
              {h || <span className="text-destructive">(no name)</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, ri) => (
          <tr key={ri} className="border-t">
            <td className="w-10 whitespace-nowrap px-2 py-1 text-right tabular-nums text-muted-foreground">
              {ri + 2}
            </td>
            {rows[0].map((_, ci) => (
              <td key={ci} className="whitespace-nowrap px-2 py-1">{r[ci] ?? ''}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The whole sheet, filling the window.
 *
 * Eighteen columns in a panel three hundred pixels tall is a file you scroll
 * rather than a file you read. This is the same table with room to be looked
 * at, and it is where somebody actually checks that a column landed where they
 * meant it to.
 *
 * Escape closes it, the backdrop closes it, and the scroll position is its
 * own — the page behind does not move while it is open.
 */
export function SheetViewer({
  title,
  rows,
  onClose,
}: {
  title: string
  rows: string[][]
  onClose: () => void
}) {
  /* Two sizes, because both are wanted.
   *
   * A sheet eighteen columns wide is read edge to edge; the same sheet checked
   * against the form behind it is better with the page still visible around
   * it. It opens large and goes to the full window on request. */
  const [full, setFull] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Restored on close rather than assumed to have been empty: another
    // overlay may have set it.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return (
    <div
      className={
        full
          ? 'fixed inset-0 z-50 bg-background'
          : 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4'
      }
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={
          full
            ? 'flex h-full w-full flex-col border bg-background'
            : 'flex max-h-[85vh] w-full max-w-[90vw] flex-col rounded-lg border bg-background shadow-lg'
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <p className="text-[14px] font-medium">{title}</p>
          <span className="text-[12.5px] text-muted-foreground">
            {rows.length - 1} rows · {rows[0]?.length ?? 0} columns
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setFull((v) => !v)}>
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {full ? 'Windowed' : 'Full screen'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <SheetTable rows={rows} />
        </div>
      </div>
    </div>
  )
}
