import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Upload, X, Image as ImageIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { PhotoViewer } from '@/components/PhotoViewer'
import { walkRoster } from '@/lib/rosters'
import {
  PageHead, PageBody, Card, CardHeader, Button, Table, Td, Badge,
  FormNotice, Input, Select, CellGrid, Stat, tabClass, TAB_BAR,
} from '@/components/ui'
import { ExportRows } from '@/components/rows'
import { useRouteFeature } from '@/lib/catalog'
import { useSearch } from '@/components/rows'

/* The photographer's delivery, in one go.

   A school photographs everybody on one morning in June and receives a folder
   of six hundred JPEGs named by admission number. Asking the office to open
   six hundred records and upload six hundred files is asking them not to
   bother — and then the ID cards and the report cards go out with an empty box
   for the rest of the year.

   So: pick the whole folder. The admission number is read from each file's
   name, which is what the photographer was given and what the office can check
   by eye. Matching on the child's name would have to guess between two
   children called Ananya Sharma, and the wrong face on a report card is not a
   small error.

   But the file name is the photographer's work, not the school's, and it is
   wrong often enough that a screen which only reports "unmatched" hands back a
   folder-renaming job. So the roll is loaded alongside, every file says which
   child it resolved to by name, class and roll number before anything is sent,
   and any file can be pointed at a child by hand. Guessing from a name is
   still refused; choosing one deliberately is not a guess.
*/

interface Roll {
  admission_no: string
  full_name: string
  class_name?: string
  section_name?: string
  roll_no?: number
  status: string
  /** Already on file, from before this screen ever opened (owner, 2026-10-15:
      a coverage directory, "who still needs one"). */
  photo_file_id?: string
}

interface Ready {
  file: File
  admissionNo: string
  preview: string
  /** Set once the file has been attached, so the row can show it landed. */
  done?: boolean
}

/** admissionFrom reads the admission number out of a file name.

    "2022-08-145.jpg", "2022/08/145.JPG" as a folder path, "0145 (1).png" from
    a camera that renamed a duplicate — all of them are the number with
    decoration around it. The extension goes, a trailing "(1)" goes, and what
    is left is trimmed. Anything the server does not recognise comes back in
    the unmatched list rather than being guessed at here. */
function admissionFrom(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .trim()
}

/** whereTheyAre says which class and roll number a child sits at.

    The admission number is what the import matches on and what the office can
    check against the file; it is not what anybody recognises a child by. */
function whereTheyAre(s: Roll): string {
  const cls = [s.class_name, s.section_name].filter(Boolean).join(' ')
  const roll = s.roll_no != null ? `Roll ${s.roll_no}` : ''
  return [cls, roll].filter(Boolean).join(' · ')
}

/* A ROLL OF SIX HUNDRED, PICKED FROM ON A PHONE.

   This was an <input list="...">, and a datalist is a suggestion rather than a
   choice: nothing shows until you type, and on iOS Safari -- which is what a
   head of section is holding when they do this -- it very often does not
   appear at all. So the roll was served, correct, and unselectable: the box
   took text and matched nothing, and there was no way to tell whether the
   fault was the typing or the screen. The same conclusion was reached for the
   district field in setup/panels.tsx, for the same reason.

   A list drawn by the page instead. It filters on name, class and admission
   number, shows the first eight matches, and closes on a choice. The typed
   text still counts: an admission number entered in full matches without
   opening anything, which is what somebody working from a printed list does. */
function RollPicker({
  label,
  roll,
  loading,
  chosen,
  typed,
  onPick,
}: {
  label: string
  roll: Roll[]
  loading: boolean
  chosen?: Roll
  typed: string
  onPick: (admissionNo: string) => void
}) {
  /* The box holds what was typed, starting from the number read off the
     filename. It showed `text || typed`, so clearing the box brought the
     filename's number straight back and nobody could type a name over it. */
  const [text, setText] = useState(typed)
  const [open, setOpen] = useState(false)
  /* THE LIST IS DRAWN IN THE BODY, NOT IN THE TABLE.

     Absolute under the field, it was clipped by the table's own scrolling
     box -- one option's top edge showing, the rest cut, the screenshot from
     the import desk. Placed against the field's box in viewport coordinates,
     above it when the room below is short, and capped to the room it has. */
  const anchor = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxH: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const el = anchor.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const vv = window.visualViewport
      const vTop = vv ? vv.offsetTop : 0
      const vBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
      const below = vBottom - r.bottom
      const above = r.top - vTop
      const wantsAbove = below < 220 && above > below
      const maxH = Math.max(96, Math.min(256, (wantsAbove ? above : below) - 12))
      const width = Math.max(r.width, 260)
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      setPos(wantsAbove
        ? { left, width, bottom: window.innerHeight - r.top + 4, maxH }
        : { left, width, top: r.bottom + 4, maxH })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const vv = window.visualViewport
    vv?.addEventListener('resize', place)
    vv?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      vv?.removeEventListener('resize', place)
      vv?.removeEventListener('scroll', place)
    }
  }, [open])

  const q = text.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!q) return roll.slice(0, 8)
    return roll
      .filter(
        (s) =>
          s.full_name.toLowerCase().includes(q) ||
          s.admission_no.toLowerCase().includes(q) ||
          whereTheyAre(s).toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [roll, q])

  if (chosen) {
    return (
      <span className="flex items-center gap-2">
        <span className="text-[13px] font-medium">{chosen.full_name}</span>
        <button
          type="button"
          className="text-[12px] text-muted-foreground underline"
          onClick={() => {
            onPick('')
            setText('')
            setOpen(true)
          }}
        >
          change
        </button>
      </span>
    )
  }

  return (
    <span ref={anchor} className="relative block w-full sm:w-64">
      <Input
        srLabel={label}
        value={text}
        onChange={(v) => {
          setText(v)
          setOpen(true)
          // A full admission number typed or pasted needs no list.
          const hit = roll.find((s) => s.admission_no.toLowerCase() === v.trim().toLowerCase())
          if (hit) {
            onPick(hit.admission_no)
            setOpen(false)
          }
        }}
        onFocus={() => setOpen(true)}
        placeholder={loading ? 'Loading the roll…' : 'Name, class or admission number'}
      />
      {open && !loading && pos && createPortal(
        <>
          {/* A press anywhere else closes it. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-[199] cursor-default"
            onClick={() => setOpen(false)}
          />
          <ul
            role="listbox"
            style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
            className="fixed z-[200] overflow-y-auto overflow-x-hidden rounded-xl border bg-popover p-1.5 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.18)]"
          >
            {matches.length === 0 ? (
              <li className="px-3 py-2 text-[13px] text-muted-foreground">
                {roll.length === 0 ? 'The roll has not loaded.' : 'Nobody matches that.'}
              </li>
            ) : (
              matches.map((s) => (
                <li key={s.admission_no}>
                  <button
                    type="button"
                    className="block w-full rounded-lg px-3 py-2 text-left hover:bg-accent"
                    onClick={() => {
                      onPick(s.admission_no)
                      setText('')
                      setOpen(false)
                    }}
                  >
                    <span className="block text-[13.5px] font-medium">{s.full_name}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {whereTheyAre(s)} · {s.admission_no}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </>,
        document.body,
      )}
    </span>
  )
}

/* WHO STILL HAS NO PHOTOGRAPH, NOT ONLY WHAT WAS JUST CHOSEN (owner,
   2026-10-15). The office's question before a folder ever lands is "who are
   we still missing", and this screen only ever answered it for the files on
   screen that moment. The roll already carries photo_file_id, so the answer
   is drawn from the roll itself: a tab for Missing (the default), All and
   With photos, filtered by class, section and a search box, same as the rest
   of the product. A file staged in this visit counts as covered before the
   import is even pressed, so ticking off a child as their face lands in the
   table below does not wait for a page reload. */
type DirTab = 'missing' | 'all' | 'covered'

function DirectoryPanel({
  roll, loading, ready, onChoosePhoto,
}: {
  roll: Roll[]
  loading: boolean
  ready: Ready[]
  onChoosePhoto: (admissionNo: string) => void
}) {
  const [tab, setTab] = useState<DirTab>('missing')
  const [cls, setCls] = useState('')
  const [section, setSection] = useState('')
  // Not yet matched to any real admission number is harmless noise here: it
  // can never equal a roll student's own admission_no below.
  const stagedAdmissions = useMemo(
    () => new Set(ready.filter((r) => !r.done).map((r) => r.admissionNo.trim().toLowerCase())),
    [ready],
  )
  const covered = (s: Roll) => !!s.photo_file_id || stagedAdmissions.has(s.admission_no.trim().toLowerCase())

  const classes = useMemo(() => [...new Set(roll.map((s) => s.class_name).filter((x): x is string => !!x))], [roll])
  const sections = useMemo(
    () => [...new Set(roll.filter((s) => !cls || s.class_name === cls).map((s) => s.section_name).filter((x): x is string => !!x))],
    [roll, cls],
  )
  const scoped = useMemo(
    () => roll.filter((s) => (!cls || s.class_name === cls) && (!section || s.section_name === section)),
    [roll, cls, section],
  )
  const { q, setQ, shown: searched } = useSearch(scoped, (s) => [s.full_name, s.admission_no, String(s.roll_no ?? '')])
  const shown = searched.filter((s) => tab === 'all' || (tab === 'covered' ? covered(s) : !covered(s)))

  const missingCount = scoped.filter((s) => !covered(s)).length
  const coveredCount = scoped.filter(covered).length

  const tabs: { key: DirTab; label: string; n: number }[] = [
    { key: 'missing', label: 'Missing photos', n: missingCount },
    { key: 'all', label: 'All students', n: scoped.length },
    { key: 'covered', label: 'With photos', n: coveredCount },
  ]

  return (
    <Card>
      <CardHeader
        title="Student photo coverage"
        description="Who already has a photograph on file, and who the ID cards and report cards are still missing one for."
        action={
          <ExportRows
            rows={scoped.filter((s) => !covered(s))}
            columns={[
              { header: 'Admission number', value: (s) => s.admission_no },
              { header: 'Student', value: (s) => s.full_name },
              { header: 'Class', value: (s) => s.class_name ?? '' },
              { header: 'Section', value: (s) => s.section_name ?? '' },
              { header: 'Roll', value: (s) => s.roll_no ?? '' },
            ]}
            name="missing-student-photos"
            label="Export missing list"
          />
        }
      />
      <div className={TAB_BAR + ' px-[var(--card-pad)]'}>
        {tabs.map((t) => (
          <button key={t.key} type="button" className={tabClass(tab === t.key)} onClick={() => setTab(t.key)}>
            {t.label} <span className="text-muted-foreground">({t.n})</span>
          </button>
        ))}
      </div>
      <CellGrid cols={3}>
        <Stat label="Total students" value={scoped.length} />
        <Stat label="With photos" value={coveredCount} />
        <Stat label="Missing photographs" value={missingCount} />
      </CellGrid>
      <div className="flex flex-wrap items-end gap-3 px-[var(--card-pad)] pb-3">
        <Select
          value={cls}
          onChange={(v) => { setCls(v); setSection('') }}
          placeholder="All classes"
          options={classes.map((c) => ({ value: c, label: c }))}
        />
        <Select
          value={section}
          onChange={setSection}
          placeholder="All sections"
          options={sections.map((s) => ({ value: s, label: s }))}
        />
        <div className="w-full sm:w-64">
          <Input srLabel="Search student or admission number" value={q} onChange={setQ} placeholder="Search student or admission number…" />
        </div>
      </div>
      <Table head={['Student', 'Admission number', 'Class · section', 'Roll', 'Photo status', '']} empty={!loading && shown.length === 0} emptyLabel="No students match this view.">
        {shown.map((s) => (
          <tr key={s.admission_no}>
            <Td className="font-medium">{s.full_name}</Td>
            <Td className="font-mono text-[12px]">{s.admission_no}</Td>
            <Td className="text-muted-foreground">{[s.class_name, s.section_name].filter(Boolean).join(' · ')}</Td>
            <Td className="text-muted-foreground">{s.roll_no ?? '-'}</Td>
            <Td>
              <Badge tone={covered(s) ? 'success' : 'warning'}>{covered(s) ? 'Photo available' : 'Missing photo'}</Badge>
              {!s.photo_file_id && covered(s) && <div className="text-[11px] text-muted-foreground">Chosen just now, not yet imported</div>}
            </Td>
            <Td>
              {!covered(s) && (
                <button type="button" className="text-[13px] text-primary underline" onClick={() => onChoosePhoto(s.admission_no)}>
                  Select photo
                </button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

export default function StudentPhotos() {
  const nav = useRouteFeature()
  const [ready, setReady] = useState<Ready[]>([])
  const [viewing, setViewing] = useState<Ready | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ matched: number; unmatched: string[] } | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadPanel = useRef<HTMLDivElement>(null)

  /* The roll, once, so every row can say who it is going to.

     Paged rather than asked for in one lump because the list endpoint caps a
     page at 200, and a school with 1400 children would otherwise silently see
     the first 200 of them offered in the picker. */
  const roll = useQuery({
    queryKey: ['photo-import-roll'],
    staleTime: 5 * 60_000,
    // Walked by CURSOR, not offset. The students endpoint is keyset-paged, so
    // stepping with &offset= could skip or repeat rows under a concurrent
    // write, and the old 5000 ceiling truncated a larger roll outright.
    queryFn: async () =>
      (await walkRoster<Roll>('/api/v1/students', { status: 'active' })).items,
  })

  /* "Select photo" from the coverage table below scrolls up to the picker and
     opens it, so choosing a face for one named child is the same one-click
     motion as choosing the whole folder. Matching is still by filename -- a
     single file picked this way only lands on that child if its name carries
     the admission number, or the office points it there by hand below. */
  function choosePhotoFor() {
    uploadPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    fileInput.current?.click()
  }

  const byAdmission = useMemo(() => {
    const m = new Map<string, Roll>()
    for (const s of roll.data ?? []) m.set(s.admission_no.trim().toLowerCase(), s)
    return m
  }, [roll.data])

  function childFor(admissionNo: string): Roll | undefined {
    return byAdmission.get(admissionNo.trim().toLowerCase())
  }

  const unknown = ready.filter((r) => !r.done && !childFor(r.admissionNo)).length
  const sendable = ready.filter((r) => !r.done && childFor(r.admissionNo))

  const send = useMutation({
    mutationFn: async () => {
      setResult(null)
      setBusy(true)
      try {
        /* Uploaded one at a time rather than all at once.

           A school connection handed six hundred parallel uploads drops most
           of them, and a batch that half-arrives is worse than a slow one:
           nobody can tell which children got a photograph. */
        const photos: { admission_no: string; file_id: string }[] = []
        for (const r of sendable) {
          const form = new FormData()
          form.append('file', r.file)
          const up = await fetch('/api/v1/files', { method: 'POST', body: form })
          if (!up.ok) throw new Error(`${r.file.name} did not upload`)
          const j = (await up.json()) as { file_id: string }
          photos.push({ admission_no: r.admissionNo, file_id: j.file_id })
        }
        return api.post<{ matched: number; unmatched: string[] }>(
          '/api/v1/students/photos/import', { photos })
      } finally {
        setBusy(false)
      }
    },
    onSuccess: (r) => {
      setResult(r)
      /* What landed stays on screen, marked, showing the face beside the name
         it went to. Clearing the row would answer "did that work?" with an
         empty table, which is the one answer nobody can act on. */
      setReady((old) =>
        old.map((x) =>
          x.done || r.unmatched.includes(x.admissionNo) || !childFor(x.admissionNo)
            ? x
            : { ...x, done: true }))
    },
  })

  function choose(files: FileList | null) {
    if (!files) return
    setResult(null)
    const incoming = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .map((f) => ({
        file: f,
        admissionNo: admissionFrom(f.webkitRelativePath || f.name),
        preview: URL.createObjectURL(f),
      }))
    // Dropped or picked again: kept alongside what is already staged, so a
    // second folder (or a single face chosen from the coverage table) adds to
    // the batch rather than throwing away a review in progress.
    setReady((old) => [...old, ...incoming.filter((f) => !old.some((x) => x.file.name === f.file.name && x.file.size === f.file.size))])
  }

  /* Taking a file back out of the batch.

     Somebody drags a folder in and it contains the photographer's contact
     sheet, or a picture of a dog. Without this the only way out is to choose
     the whole folder again, which loses every child already pointed at by
     hand. The object URL goes with the row -- nothing else is holding it. */
  function drop(file: File) {
    setReady((old) => {
      const gone = old.find((x) => x.file === file)
      if (gone) URL.revokeObjectURL(gone.preview)
      return old.filter((x) => x.file !== file)
    })
  }

  function cancelAll() {
    ready.forEach((r) => URL.revokeObjectURL(r.preview))
    setReady([])
    setResult(null)
  }

  function point(file: File, admissionNo: string) {
    const adm = admissionNo.trim()
    setReady((old) => old.map((x) => (x.file === file ? { ...x, admissionNo: adm } : x)))
  }

  /* A preview is an object URL; left alone they hold the images in memory for
     as long as the tab is open, and a folder of six hundred is not small. Read
     through a ref at unmount rather than depending on `ready`, because marking
     a row attached changes `ready` and would otherwise revoke every preview
     still on screen. */
  const live = useRef(ready)
  live.current = ready
  useEffect(() => () => { live.current.forEach((r) => URL.revokeObjectURL(r.preview)) }, [])

  const viewerName = viewing ? `${viewing.file.name}${viewing.admissionNo ? ` (${viewing.admissionNo})` : ''}` : ''
  return (
    <>
      {viewing && (
        <PhotoViewer src={viewing.preview} name={viewerName} onClose={() => setViewing(null)} />
      )}
      <PageHead
        eyebrow={nav.section?.name ?? 'Students'}
        title={nav.feature?.name ?? 'Student photographs'}
        description="The photographer's folder, matched to children by admission number. Check the name against the face before you import, photographs print on the ID card and on the report card."
        actions={
          <>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-muted">
              <Upload className="h-3.5 w-3.5" aria-hidden />
              Choose photographs
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => { choose(e.target.files); e.target.value = '' }}
              />
            </label>
            {ready.length > 0 && (
              <Button variant="secondary" disabled={busy} onClick={cancelAll}>
                Cancel
              </Button>
            )}
            {sendable.length > 0 && (
              <Button disabled={busy} onClick={() => send.mutate()}>
                {busy ? 'Uploading…' : `Import ${sendable.length}`}
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Selected photos" value={ready.length} />
          <Stat label="Matched" value={ready.filter((r) => !r.done && childFor(r.admissionNo)).length} />
          <Stat label="Needs review" value={unknown} />
        </CellGrid>
        {send.error && <FormNotice error={send.error} />}
        {result && (
          <FormNotice
            ok={
              `${result.matched} ${result.matched === 1 ? 'photograph' : 'photographs'} attached.` +
              (result.unmatched.length
                ? ` ${result.unmatched.length} did not attach and are still listed below.`
                : '')
            }
          />
        )}
        {unknown > 0 && (
          <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] text-secondary-foreground">
            {unknown === 1
              ? '1 file names no child.'
              : `${unknown} files name no child.`}{' '}
            Choose the child in the Goes to column, or rename the file to their
            admission number. Nothing is attached until you press Import.
          </div>
        )}

        <Card>
          <div ref={uploadPanel} />
          <CardHeader
            title={ready.length ? `${ready.length} chosen` : 'How this works'}
            description="Name each file with the child's admission number · 2022/08/145.jpg for admission number 2022/08/145, and every photograph finds its child on its own. Anything that does not, you can point at a child by typing their name."
          />
          {ready.length === 0 ? (
            /* A DROP TARGET, NOT ONLY A BUTTON (owner, 2026-10-15). The
               office's folder is already open in Explorer or Finder; dragging
               it onto the page is one motion, picking a button and then a
               folder from a dialog is three. */
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click() }}
              onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files) }}
              className={
                'mx-[var(--card-pad)] mb-[var(--card-pad)] flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ' +
                (dragging ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40')
              }
            >
              <ImageIcon className="h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="text-[14px] font-medium">Drag and drop photographs here</p>
              <p className="text-[13px] text-muted-foreground">or choose the folder the photographer delivered</p>
              <p className="text-[12px] text-muted-foreground">Anything that is not an image is ignored, and nothing is attached until you press Import.</p>
            </div>
          ) : (
            <>
              <Table head={['', 'File', 'Goes to', 'Class · roll', '']}>
                {ready.map((r) => {
                  const child = childFor(r.admissionNo)
                  return (
                    <tr key={r.file.name}>
                      <Td>
                        {/* A tap opens it full screen, the way the record's own
                            photo does (owner, 2026-10-15), so a face is worth
                            checking before Import rather than after. */}
                        <button type="button" onClick={() => setViewing(r)} aria-label={`View ${r.file.name}`}>
                          <img loading="lazy" decoding="async"
                            src={r.preview}
                            alt=""
                            className="h-12 w-10 rounded border object-cover"
                          />
                        </button>
                      </Td>
                      <Td className="text-[13px]">
                        {r.file.name}
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {r.admissionNo || '-'}
                        </div>
                      </Td>
                      <Td>
                        {r.done ? (
                          <span className="text-[13px] font-medium">{child?.full_name}</span>
                        ) : (
                          <RollPicker
                            label={`Child for ${r.file.name}`}
                            roll={roll.data ?? []}
                            loading={roll.isLoading}
                            chosen={child}
                            typed={r.admissionNo}
                            onPick={(adm) => point(r.file, adm)}
                          />
                        )}
                      </Td>
                      <Td className="text-[13px] text-muted-foreground">
                        {child ? whereTheyAre(child) : ''}
                      </Td>
                      <Td>
                        <div className="flex items-center justify-between gap-3">
                          {r.done ? (
                            <Badge tone="success">attached</Badge>
                          ) : result?.unmatched.includes(r.admissionNo) ? (
                            <Badge tone="danger">did not attach</Badge>
                          ) : child ? (
                            <Badge tone="neutral">ready</Badge>
                          ) : (
                            <Badge tone="warning">no child yet</Badge>
                          )}
                          <button
                            type="button"
                            title={r.done ? 'Take off this list' : 'Do not import this one'}
                            aria-label={`Remove ${r.file.name}`}
                            disabled={busy}
                            onClick={() => drop(r.file)}
                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        </div>
                      </Td>
                    </tr>
                  )
                })}
              </Table>
            </>
          )}
        </Card>
        <DirectoryPanel roll={roll.data ?? []} loading={roll.isLoading} ready={ready} onChoosePhoto={choosePhotoFor} />
      </PageBody>
    </>
  )
}
