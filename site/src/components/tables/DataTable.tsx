import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsUpDown, Search, SlidersHorizontal, X,
} from 'lucide-react'
import { Avatar, Badge, Button, Checkbox, Dropdown, EmptyState, Select, TableSkeleton } from '@/components/ui'
import type { Column, Row } from '@/data/generator'
import { toneFor } from '@/data/generator'
import { cx, sortRows } from '@/lib/utils'

export interface DataTableProps {
  columns: Column[]
  rows: Row[]
  loading?: boolean
  pageSize?: number
  selectable?: boolean
  onRowClick?: (row: Row) => void
  rowActions?: (row: Row) => React.ReactNode
  toolbar?: React.ReactNode
  bulkActions?: (ids: string[], clear: () => void) => React.ReactNode
  emptyHint?: string
  /** Filter pushed in from outside — a chart click, usually. Shown as a removable chip. */
  externalFilter?: { label: string; value: string } | null
  onClearExternalFilter?: () => void
}

/** Columns that carry the record's identity get merged into one cell: a name
 *  with its reference quietly underneath. A row leading with "REC-02601" tells
 *  the reader nothing; a row leading with a person does. */
function useIdentity(columns: Column[]) {
  return useMemo(() => {
    const personIdx = columns.findIndex((c) => c.type === 'person')
    const refIdx = columns.findIndex((c) => c.type === 'id' || c.type === 'code')
    if (personIdx === -1 || refIdx === -1) {
      return { merged: false, primary: columns[0], secondary: null as Column | null, rest: columns.slice(1) }
    }
    return {
      merged: true,
      primary: columns[personIdx],
      secondary: columns[refIdx],
      rest: columns.filter((_, i) => i !== personIdx && i !== refIdx),
    }
  }, [columns])
}

/** Numbers carry the meaning, so they get the weight; dates and places are
 *  context, so they recede. Without this every cell competes equally. */
function cellTone(c: Column) {
  if (['money', 'moneysm', 'int', 'rating'].includes(c.type)) return 'text-right tabular-nums font-medium'
  if (['pct'].includes(c.type)) return 'text-right tabular-nums'
  if (['date', 'datepast', 'datefuture', 'time', 'city', 'campus'].includes(c.type)) return 'muted'
  return ''
}

export function DataTable({
  columns, rows, loading, pageSize = 10, selectable = true,
  onRowClick, rowActions, toolbar, bulkActions, emptyHint,
  externalFilter, onClearExternalFilter,
}: DataTableProps) {
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(pageSize)
  const [sel, setSel] = useState<string[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [cursor, setCursor] = useState(-1)
  const bodyRef = useRef<HTMLTableSectionElement>(null)

  const ident = useIdentity(columns)
  const filterCols = columns.filter((c) => c.filterable).slice(0, 4)

  const filtered = useMemo(() => {
    let out = rows
    const needle = q.trim().toLowerCase()
    if (needle) out = out.filter((r) => columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(needle)))
    if (externalFilter) {
      const v = externalFilter.value.toLowerCase()
      out = out.filter((r) => columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(v)))
    }
    for (const [k, v] of Object.entries(filters)) {
      if (v && v !== 'All') out = out.filter((r) => String(r[k]) === v)
    }
    return sortRows(out, sortKey, dir)
  }, [rows, q, filters, sortKey, dir, columns, externalFilter])

  const pages = Math.max(1, Math.ceil(filtered.length / size))
  const current = Math.min(page, pages)
  const slice = filtered.slice((current - 1) * size, current * size)
  const allChecked = slice.length > 0 && slice.every((r) => sel.includes(r._id))
  const activeFilters = Object.values(filters).filter((v) => v && v !== 'All').length

  const toggleSort = (key: string) => {
    if (sortKey === key) setDir(dir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setDir('asc') }
  }

  const optionsFor = (c: Column) => ['All', ...Array.from(new Set(rows.map((r) => String(r[c.key])))).sort()]

  // Arrow keys walk the rows, Enter opens one — a table you can only mouse
  // through is slow for anyone entering data all day.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!slice.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, slice.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
    if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); onRowClick?.(slice[cursor]) }
    if (e.key === ' ' && cursor >= 0 && selectable) {
      e.preventDefault()
      const id = slice[cursor]._id
      setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
    }
  }
  useEffect(() => { setCursor(-1) }, [current, q, filters])

  return (
    <div className="card overflow-visible">
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 muted" />
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1) }}
            placeholder="Search records…"
            aria-label="Search records"
            className="field pl-8 pr-7"
          />
          {q && (
            <button onClick={() => setQ('')} aria-label="Clear search" className="absolute right-2 top-2.5 muted hover:opacity-70">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {filterCols.length > 0 && (
          <Button size="sm" icon={SlidersHorizontal} onClick={() => setShowFilters((s) => !s)}
            className={cx(showFilters && 'bg-accent text-accent-foreground')}>
            Filters
            {activeFilters > 0 && <span className="ml-1 rounded bg-primary px-1 text-[10px] text-primary-foreground">{activeFilters}</span>}
          </Button>
        )}
        <Dropdown
          align="left"
          className="md:hidden"
          trigger={
            <Button size="sm" icon={ArrowUpDown} aria-label="Sort records">
              {sortKey ? columns.find((c) => c.key === sortKey)?.label ?? 'Sort' : 'Sort'}
            </Button>
          }
          items={columns.map((c) => ({
            label: `${sortKey === c.key ? (dir === 'asc' ? '↑ ' : '↓ ') : ''}${c.label}`,
            onClick: () => toggleSort(c.key),
          }))}
        />
        <div className="ml-auto flex items-center gap-2">{toolbar}</div>
      </div>

      {externalFilter && (
        <div className="flex items-center gap-3 border-b bg-accent/60 px-5 py-3.5 text-[14px]">
          <span className="muted">{externalFilter.label}:</span>
          <Badge tone="blue">{externalFilter.value}</Badge>
          <button onClick={onClearExternalFilter} className="ml-auto inline-flex items-center gap-1 text-[12px] muted hover:text-foreground">
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        </div>
      )}

      {showFilters && filterCols.length > 0 && (
        <div className="grid gap-4 border-b bg-muted/30 px-5 py-5 sm:grid-cols-2 lg:grid-cols-4">
          {filterCols.map((c) => (
            <label key={c.key} className="eyebrow block">
              {c.label}
              <Select className="mt-1" options={optionsFor(c)} value={filters[c.key] ?? 'All'}
                onChange={(e) => { setFilters((f) => ({ ...f, [c.key]: e.target.value })); setPage(1) }} />
            </label>
          ))}
        </div>
      )}

      {sel.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b bg-accent px-5 py-3.5 text-[14px]">
          <span className="font-medium">{sel.length} selected</span>
          <div className="ml-auto flex flex-wrap gap-2">
            {bulkActions?.(sel, () => setSel([]))}
            <Button size="sm" variant="ghost" onClick={() => setSel([])}>Clear</Button>
          </div>
        </div>
      )}

      {loading ? <TableSkeleton cols={Math.min(columns.length, 6)} />
        : filtered.length === 0 ? (
          <EmptyState title="No records match your filters" hint={emptyHint || 'Try clearing the search box or resetting filters.'}
            action={<Button size="sm" onClick={() => { setQ(''); setFilters({}); onClearExternalFilter?.() }}>Reset filters</Button>} />
        ) : (
          <>
            <div className="hidden md:block scroll-x" tabIndex={0} onKeyDown={onKeyDown} role="grid"
              aria-label="Records" aria-rowcount={filtered.length}>
              <table className="w-full min-w-max text-sm">
                <thead className="bg-card">
                  <tr className="border-b">
                    {selectable && (
                      <th className="sticky-identity left-0 z-20 w-12 px-5 py-4">
                        <Checkbox checked={allChecked} onChange={(v) =>
                          setSel(v ? Array.from(new Set([...sel, ...slice.map((r) => r._id)])) : sel.filter((id) => !slice.some((r) => r._id === id)))} />
                      </th>
                    )}
                    <Th col={ident.primary} sortKey={sortKey} dir={dir} onSort={toggleSort}
                      sticky className={selectable ? 'left-12' : 'left-0'} />
                    {ident.rest.map((c) => <Th key={c.key} col={c} sortKey={sortKey} dir={dir} onSort={toggleSort} />)}
                    {rowActions && <th className="px-5 py-4 text-right eyebrow">Actions</th>}
                  </tr>
                </thead>
                <tbody ref={bodyRef}>
                  {slice.map((r, i) => (
                    <tr key={r._id}
                      onClick={() => onRowClick?.(r)}
                      onMouseEnter={() => setCursor(i)}
                      aria-selected={sel.includes(r._id)}
                      className={cx('border-b last:border-0 transition-colors duration-300 ease-premium',
                        onRowClick && 'cursor-pointer',
                        i === cursor ? 'bg-accent/70' : 'hover:bg-muted/50',
                        sel.includes(r._id) && 'bg-accent')}>
                      {selectable && (
                        <td className="sticky-identity left-0 z-10 px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={sel.includes(r._id)} onChange={(v) => setSel(v ? [...sel, r._id] : sel.filter((x) => x !== r._id))} />
                        </td>
                      )}
                      <td className={cx('sticky-identity z-10 px-5 py-3.5', selectable ? 'left-12' : 'left-0')}>
                        {ident.merged ? (
                          <div className="flex items-center gap-2.5">
                            <Avatar name={String(r[ident.primary.key])} size={28} />
                            <div className="min-w-0 leading-tight">
                              <div className="truncate font-medium">{String(r[ident.primary.key])}</div>
                              <div className="truncate text-[11px] muted">{String(r[ident.secondary!.key])}</div>
                            </div>
                          </div>
                        ) : (
                          <span className="font-medium">{String(r[ident.primary.key])}</span>
                        )}
                      </td>
                      {ident.rest.map((c) => (
                        <td key={c.key} className={cx('whitespace-nowrap px-5 py-3.5 text-[14px]', cellTone(c))}>
                          <Cell col={c} value={r[c.key]} />
                        </td>
                      ))}
                      {rowActions && <td className="px-5 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>{rowActions(r)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* On a phone a row is a card: sideways scrolling to read one is miserable. */}
            {selectable && (
              <label className="flex items-center gap-2.5 border-b px-3 py-2 text-[12px] muted md:hidden">
                <Checkbox checked={allChecked} onChange={(v) =>
                  setSel(v ? Array.from(new Set([...sel, ...slice.map((r) => r._id)])) : sel.filter((id) => !slice.some((r) => r._id === id)))} />
                Select all on this page
              </label>
            )}
            <div className="divide-y md:hidden">
              {slice.map((r) => (
                <div key={r._id} onClick={() => onRowClick?.(r)} className="px-3 py-3 active:bg-muted/60">
                  <div className="flex items-start gap-2.5">
                    {selectable && (
                      <span className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={sel.includes(r._id)}
                          onChange={(v) => setSel(v ? [...sel, r._id] : sel.filter((x) => x !== r._id))} />
                      </span>
                    )}
                    {ident.merged && <Avatar name={String(r[ident.primary.key])} size={30} />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{String(r[ident.primary.key])}</p>
                      {ident.merged && <p className="truncate text-[11px] muted">{String(r[ident.secondary!.key])}</p>}
                    </div>
                    <div onClick={(e) => e.stopPropagation()}>{rowActions?.(r)}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {ident.rest.slice(0, 4).map((c) => (
                      <span key={c.key} className="text-[11px] muted">
                        {c.label}: <span className="text-foreground"><Cell col={c} value={r[c.key]} /></span>
                      </span>
                    ))}
                  </div>
                  {/* A tab can define nine columns; four of them is not the record. */}
                  {ident.rest.length > 4 && (
                    <details className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                      <summary className="cursor-pointer text-[11px] font-medium text-[hsl(var(--primary))]">
                        {ident.rest.length - 4} more
                      </summary>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                        {ident.rest.slice(4).map((c) => (
                          <span key={c.key} className="text-[11px] muted">
                            {c.label}: <span className="text-foreground"><Cell col={c} value={r[c.key]} /></span>
                          </span>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4 text-[13px] muted">
              <div className="flex items-center gap-2">
                <span>Rows</span>
                <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1) }}
                  aria-label="Rows per page" className="h-7 rounded-md hairline bg-transparent px-1.5 text-xs focus-ring">
                  {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                {/* The full range needs room; the total does not, and knowing
                    how many records there are matters more on a small screen. */}
                <span className="hidden sm:inline">
                  {(current - 1) * size + 1}–{Math.min(current * size, filtered.length)} of {filtered.length}
                </span>
                <span className="sm:hidden">of {filtered.length}</span>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" aria-label="Previous page" disabled={current === 1} onClick={() => setPage(current - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-2">Page {current} / {pages}</span>
                <Button size="sm" variant="ghost" aria-label="Next page" disabled={current === pages} onClick={() => setPage(current + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
    </div>
  )
}

function Th({ col, sortKey, dir, onSort, sticky, className }: {
  col: Column; sortKey: string | null; dir: 'asc' | 'desc'; onSort: (k: string) => void
  sticky?: boolean; className?: string
}) {
  const active = sortKey === col.key
  return (
    <th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cx('whitespace-nowrap px-5 py-4 text-left eyebrow',
        col.align === 'right' && 'text-right', sticky && 'sticky-identity z-20', className)}>
      <button onClick={() => onSort(col.key)} className="inline-flex items-center gap-1 hover:text-foreground">
        {col.label}
        {active ? (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
          : <ChevronsUpDown className="h-3 w-3 opacity-40" />}
      </button>
    </th>
  )
}

function Cell({ col, value }: { col: Column; value: any }) {
  const v = String(value ?? '—')
  if (col.type === 'status' || col.type === 'badge') return <Badge tone={toneFor(v)} dot={col.type === 'status'}>{v}</Badge>
  if (col.type === 'person') return (
    <span className="inline-flex items-center gap-1.5"><Avatar name={v} size={20} />{v}</span>
  )
  if (col.type === 'pct') {
    const n = parseInt(v)
    return (
      <span className="inline-flex items-center justify-end gap-2">
        <span className="hidden lg:block w-14"><Meter value={n} /></span>
        <span className={cx('font-medium', n < 75 && 'text-rose-600')}>{v}</span>
      </span>
    )
  }
  if (col.type === 'grade') return <Badge tone={/A/.test(v) ? 'green' : /B/.test(v) ? 'blue' : 'amber'}>{v}</Badge>
  if (col.type === 'email') return <a href="#" onClick={(e) => e.preventDefault()} className="text-primary hover:underline">{v}</a>
  return <>{v}</>
}

function Meter({ value }: { value: number }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <span className={cx('block h-full rounded-full', value < 75 ? 'bg-rose-500' : value < 88 ? 'bg-amber-500' : 'bg-emerald-500')}
        style={{ width: `${value}%` }} />
    </span>
  )
}
