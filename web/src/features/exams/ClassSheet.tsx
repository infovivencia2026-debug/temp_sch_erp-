/* The whole-class marks sheet (owner, 2026-10-13).

   One exam, one class, every subject side by side: export a file with every
   child and every subject (and part), fill it, import the same file. Imported
   marks land in the grid below, editable, with each subject's total and grade
   worked out live; nothing is written until Save, and Save goes paper by
   paper through the same routes the one-paper screen uses, so a teacher who
   may not mark a subject is told so for that subject only. */
import { overMax } from './marksSheet'
import { useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { Download, Upload, X } from 'lucide-react'
import type { GradebookRow } from '@shared/api'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, FormNotice } from '@/components/ui'
import { downloadCSV } from '@/components/rows'
import {
  ABSENT, ONE, classStudents, classTemplate, gradeFor, paperSave, readClassSheet, recordedCell,
  type ClassPaper,
} from './marksSheet'

interface PaperRef { id: string; subject: string; max_marks: number }
interface PartMarks {
  parts: { id: string; name: string; max_marks: number }[]
  items: { student_id: string; parts: Record<string, number | null> }[]
  bands?: { grade: string; min: number; max: number }[]
}

type Edits = Record<string, Record<string, Record<string, string>>>

export default function ClassSheet({ papers, className, examName }: {
  papers: PaperRef[]; className: string; examName: string
}) {
  const qc = useQueryClient()
  const books = useQueries({ queries: papers.map((p) => ({
    queryKey: ['gradebook', p.id, ''],
    queryFn: () => api.call('GET /exams/gradebook', { query: { exam_subject_id: p.id, section_id: '' } }),
  })) })
  const partQs = useQueries({ queries: papers.map((p) => ({
    queryKey: ['part-marks', p.id],
    queryFn: () => api.get<PartMarks>(`/api/v1/exams/subjects/${p.id}/part-marks`),
  })) })
  const [edits, setEdits] = useState<Edits>({})
  const [note, setNote] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const loading = books.some((b) => b.isLoading) || partQs.some((q) => q.isLoading)
  const sheet: (ClassPaper & { bands: PartMarks['bands'] })[] = papers.map((p, i) => ({
    id: p.id, subject: p.subject,
    max_marks: (books[i].data?.items?.[0] as GradebookRow | undefined)?.max_marks ?? p.max_marks,
    parts: partQs[i].data?.parts ?? [],
    rows: books[i].data?.items ?? [],
    saved: new Map((partQs[i].data?.items ?? []).map((x) => [x.student_id, x.parts])),
    bands: partQs[i].data?.bands ?? [],
  }))
  const students = classStudents(sheet)

  const keysOf = (p: ClassPaper) => (p.parts.length ? p.parts.map((x) => ({ key: x.id, name: x.name, max: x.max_marks })) : [{ key: ONE, name: 'Marks', max: p.max_marks }])
  const valueOf = (p: ClassPaper, sid: string, key: string) => edits[p.id]?.[sid]?.[key] ?? recordedCell(p, sid, key)
  const badCell = (v: string, max: number) => {
    const t = v.trim()
    if (t === '' || t.toUpperCase() === ABSENT) return false
    const n = Number(t)
    return !Number.isFinite(n) || n < 0 || n > max
  }
  const totalOf = (p: ClassPaper, sid: string): number | null => {
    const vals = keysOf(p).map((k) => valueOf(p, sid, k.key).trim())
    if (vals.some((v) => v.toUpperCase() === ABSENT)) return null
    const nums = vals.filter((v) => v !== '' && Number.isFinite(Number(v))).map(Number)
    return nums.length ? nums.reduce((a, b) => a + b, 0) : null
  }
  const setCell = (pid: string, sid: string, key: string, v: string) =>
    setEdits((e) => ({ ...e, [pid]: { ...(e[pid] ?? {}), [sid]: { ...(e[pid]?.[sid] ?? {}), [key]: v } } }))

  /* The grid appears once a sheet is imported, to check and change before
     Save (owner, 2026-10-13); it is not a blank form to type into. */
  const [shown, setShown] = useState(false)
  const importFile = (file: File) => {
    setNote(''); setProblems([])
    const reader = new FileReader()
    reader.onerror = () => setProblems(['That file could not be read.'])
    reader.onload = () => {
      const got = readClassSheet(String(reader.result ?? ''), sheet)
      if (!got.columns) { setProblems(['No subject columns in that file matched this class and exam. Export the sheet here and fill that one.']); return }
      setEdits((e) => {
        const next = { ...e }
        for (const [pid, bySid] of Object.entries(got.cells)) {
          next[pid] = { ...(next[pid] ?? {}) }
          for (const [sid, cells] of Object.entries(bySid)) next[pid][sid] = { ...(next[pid][sid] ?? {}), ...cells }
        }
        return next
      })
      setNote(`${got.filled} ${got.filled === 1 ? 'child' : 'children'} loaded below. Check them, then press Save.`)
      setShown(true)
      const list = [...got.errors.map((x) => `${x} — not loaded.`)]
      if (got.missed.length) list.push(`Nobody in this class matched: ${got.missed.join(', ')}.`)
      setProblems(list)
    }
    reader.readAsText(file)
  }

  const dirty = Object.entries(edits).filter(([, by]) => Object.keys(by).length)
  const invalid = sheet.some((p) => Object.entries(edits[p.id] ?? {}).some(([, cells]) =>
    Object.entries(cells).some(([k, v]) => badCell(v, keysOf(p).find((x) => x.key === k)?.max ?? 0))))

  const save = async () => {
    setSaving(true); setNote('')
    const failed: string[] = []
    let saved = 0
    for (const [pid, cells] of dirty) {
      const p = sheet.find((x) => x.id === pid)!
      const body = paperSave(p, cells)
      try {
        if (body.kind === 'parts') await api.put(`/api/v1/exams/subjects/${pid}/part-marks`, body.body)
        else await api.call('POST /exams/marks', { body: body.body })
        saved++
        setEdits((e) => { const n = { ...e }; delete n[pid]; return n })
      } catch (err) {
        failed.push(`${p.subject}: ${err instanceof Error ? err.message : 'could not be saved'}`)
      }
      qc.invalidateQueries({ queryKey: ['gradebook', pid] })
      qc.invalidateQueries({ queryKey: ['part-marks', pid] })
    }
    qc.invalidateQueries({ queryKey: ['exam-subjects'] })
    setSaving(false)
    setNote(saved ? `${saved} subject${saved === 1 ? '' : 's'} saved.` : '')
    setProblems(failed.map((f) => `Not saved — ${f}`))
  }

  if (!papers.length) return <p className="px-5 py-4 text-[14px] text-muted-foreground">No subject of this exam has a date yet. Set the dates in Exams &amp; papers → Date sheet, and those subjects appear here.</p>
  return (
    <Card>
      <CardHeader
        title={`${className} · ${examName} · whole class`}
        action={
          <Button disabled={saving || !dirty.length || invalid} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        }
      />
      <div className="grid gap-3 px-5 py-3 sm:grid-cols-2">
        <div>
          <Button
            variant="secondary"
            disabled={loading || !students.length}
            onClick={() => downloadCSV(classTemplate({ class_name: className, exam_name: examName }, sheet),
              `marks-${className}-${examName}`.replace(/\s+/g, '-'))}
          >
            <Download className="h-4 w-4" /> Export sheet
          </Button>
          <p className="mt-1 text-[12px] text-muted-foreground">Download this class's sheet: every student, every subject and part, with marks already entered.</p>
        </div>
        <div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-muted">
            <Upload className="h-3.5 w-3.5" aria-hidden /> Import sheet
            <input type="file" accept=".csv,text/csv,text/plain" className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = '' }} />
          </label>
          <p className="mt-1 text-[12px] text-muted-foreground">Upload the filled sheet; marks appear below to check before you save.</p>
        </div>
      </div>
      {(note || problems.length > 0) && (
        <div className="space-y-2 px-5 pb-3">
          {/* Closable (owner, 2026-10-15): "5 subjects saved" is only true
              until the next edit, and sat on screen with no way to put it
              away while the class kept working through the next exam. */}
          {note && (
            <div className="relative">
              <FormNotice ok={note} />
              <button
                type="button"
                onClick={() => setNote('')}
                aria-label="Close"
                className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          )}
          {problems.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-destructive">
              {problems.slice(0, 30).map((x, i) => <li key={i}>{x}</li>)}
              {problems.length > 30 && <li>and {problems.length - 30} more</li>}
            </ul>
          )}
        </div>
      )}
      {!shown ? <p className="px-5 pb-4 text-[13px] text-muted-foreground">Export the sheet, fill in the marks, then Import it: the marks appear here to check and change before you save.</p> : loading ? <p className="px-5 pb-4 text-[13px] text-muted-foreground">Loading the class…</p> : (
        <div className="overflow-x-auto border-t">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b bg-muted/40">
                <th rowSpan={2} className="px-2 py-1.5 text-left">Roll</th>
                <th rowSpan={2} className="px-2 py-1.5 text-left">Student</th>
                <th rowSpan={2} className="px-2 py-1.5 text-left">Section</th>
                {sheet.map((p) => (
                  <th key={p.id} colSpan={keysOf(p).length + 2} className="border-l px-2 py-1.5 text-center">{p.subject}</th>
                ))}
              </tr>
              <tr className="border-b bg-muted/40 text-[12px] text-muted-foreground">
                {sheet.map((p) => [
                  ...keysOf(p).map((k) => <th key={p.id + k.key} className="border-l px-2 py-1 font-normal">{k.name} ({k.max})</th>),
                  <th key={p.id + 't'} className="px-2 py-1 font-normal">Total ({p.max_marks})</th>,
                  <th key={p.id + 'g'} className="px-2 py-1 font-normal">Grade</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.student_id} className="border-b">
                  <td className="px-2 py-1 tabular-nums">{s.roll_no ?? ''}</td>
                  <td className="px-2 py-1 font-medium whitespace-nowrap">{s.full_name}</td>
                  <td className="px-2 py-1 text-muted-foreground">{s.section || '-'}</td>
                  {sheet.map((p) => {
                    const on = p.rows.some((r) => r.student_id === s.student_id)
                    const t = on ? totalOf(p, s.student_id) : null
                    const g = t == null ? null : gradeFor(p.bands ?? [], t, p.max_marks)
                    return [
                      ...keysOf(p).map((k) => {
                        const v = on ? valueOf(p, s.student_id, k.key) : ''
                        return (
                          <td key={p.id + k.key} className="border-l px-1 py-0.5">
                            {on && (
                              <input
                                value={v}
                                onChange={(e) => { if (overMax(e.target.value, k.max)) return; setCell(p.id, s.student_id, k.key, e.target.value) }}
                                aria-label={`${p.subject} ${k.name} for ${s.full_name}, out of ${k.max}`}
                                aria-invalid={badCell(v, k.max) || undefined}
                                className={`w-14 rounded border px-1 py-0.5 text-right tabular-nums ${badCell(v, k.max) ? 'border-destructive' : ''} ${edits[p.id]?.[s.student_id]?.[k.key] !== undefined ? 'bg-primary/5' : ''}`}
                              />
                            )}
                          </td>
                        )
                      }),
                      <td key={p.id + 't'} className="px-2 py-1 font-medium tabular-nums">{t ?? '-'}</td>,
                      <td key={p.id + 'g'} className="px-2 py-1">{g ? <Badge tone="primary">{g}</Badge> : '-'}</td>,
                    ]
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {invalid && <p className="px-5 py-2 text-[13px] text-destructive">A box outlined in red is not a number between 0 and its maximum (or AB for absent).</p>}
        </div>
      )}
    </Card>
  )
}
