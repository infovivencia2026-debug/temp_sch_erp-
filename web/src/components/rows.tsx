/* Getting rows out, and finding one.
 *
 * A scan of the product found 122 registers with no way to export and 122 with
 * no way to search. Neither can be solved the way the existing ExportButton
 * solves it — that one points at a hand-written server report, and there are
 * ten of those against a hundred and sixty screens that need one.
 *
 * The rows are already in the browser. So these work on what the screen has
 * fetched, cost one line at the call site, and need no endpoint at all. What
 * they cannot do is export a page the screen never loaded: where a list is
 * paged or capped server-side, the file holds what was on screen and says so.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Download, Search } from 'lucide-react'
import { Button, Input } from './ui'

export interface Column<T> {
  header: string
  /** Anything falsy other than 0 is written as an empty cell, not "null". */
  value: (row: T) => string | number | null | undefined
}

/* Excel treats a leading =, +, - or @ as a formula, so a cell like
   "=cmd|' /c calc'!A1" out of a name field executes on open. Prefixing a
   quote makes it text again, and is what every CSV writer that has been bitten
   does. The cost is a leading apostrophe on the handful of cells that start
   with an operator; the alternative is handing somebody a live formula. */
function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  if (/["\n\r,]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function toCSV<T>(rows: T[], columns: Column<T>[]): string {
  const head = columns.map((c) => cell(c.header)).join(',')
  const body = rows.map((r) => columns.map((c) => cell(c.value(r))).join(','))
  /* CRLF and a BOM, because the reader opens this in Excel. Without the BOM
     every name with a Devanagari or accented character arrives as mojibake. */
  return '﻿' + [head, ...body].join('\r\n') + '\r\n'
}

export function downloadCSV(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name.endsWith('.csv') ? name : `${name}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  /* Revoked on the next tick rather than immediately: Safari has not finished
     with the URL when click() returns. */
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Export what is on screen. Disabled, not hidden, when there is nothing. */
export function ExportRows<T>({
  rows,
  columns,
  name,
  label = 'Export',
}: {
  rows: T[]
  columns: Column<T>[]
  /** Filename stem. The date is appended, so yesterday's file is still there. */
  name: string
  label?: string
}) {
  const stamp = new Date().toISOString().slice(0, 10)
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={!rows.length}
      title={rows.length ? `Download these ${rows.length} rows as CSV` : 'Nothing to export'}
      onClick={() => downloadCSV(toCSV(rows, columns), `${name}-${stamp}`)}
    >
      <Download className="h-3.5 w-3.5" />
      {label}
    </Button>
  )
}

/* Finding a row.
 *
 * Client-side, over what is loaded. That is the honest scope: it cannot find a
 * child on a page the screen has not fetched, so screens that page server-side
 * should pass the query up instead of using this. For the many registers that
 * load a whole list and render it, this is the whole feature.
 *
 * Terms are ANDed and matched case-insensitively as substrings, so "6b lak"
 * finds Lakshmi in Grade 6-B whichever order the fields come in.
 */
export function useSearch<T>(rows: T[], fields: (row: T) => (string | number | null | undefined)[]) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return rows
    return rows.filter((r) => {
      const hay = fields(r).filter((v) => v !== null && v !== undefined)
        .join(' ').toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
    // `fields` is a fresh closure each render; depending on it would defeat the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q])
  return { q, setQ, shown }
}

/** The box itself. Kept separate so a screen can place it where it belongs. */
export function SearchBox({
  value,
  onChange,
  placeholder = 'Search',
  className = 'w-56',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={onChange} placeholder={placeholder}
        srLabel={placeholder} className="pl-8" />
    </div>
  )
}

/** "12 of 240" — so a filtered list never looks like the whole list. */
export function Showing({ shown, total, noun = 'rows' }: {
  shown: number; total: number; noun?: string
}): ReactNode {
  if (shown === total) return null
  return (
    <span className="text-[13px] text-muted-foreground">
      {shown} of {total} {noun}
    </span>
  )
}
