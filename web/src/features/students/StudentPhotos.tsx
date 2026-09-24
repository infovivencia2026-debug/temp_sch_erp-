import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Upload, X } from 'lucide-react'
import { api } from '@/lib/api'
import { walkRoster } from '@/lib/rosters'
import {
  PageHead, PageBody, Card, CardHeader, Button, Table, Td, Badge,
  FormNotice, EmptyState, Input,
} from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'

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
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)

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
    <span className="relative block w-full sm:w-64">
      <Input
        srLabel={label}
        value={text || typed}
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
      {open && !loading && (
        <>
          {/* A press anywhere else closes it. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
          />
          <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-md border bg-card py-1 shadow-lg">
            {matches.length === 0 ? (
              <li className="px-3 py-2 text-[13px] text-muted-foreground">
                {roll.length === 0 ? 'The roll has not loaded.' : 'Nobody matches that.'}
              </li>
            ) : (
              matches.map((s) => (
                <li key={s.admission_no}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left hover:bg-accent"
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
        </>
      )}
    </span>
  )
}

export default function StudentPhotos() {
  const nav = useRouteFeature()
  const [ready, setReady] = useState<Ready[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ matched: number; unmatched: string[] } | null>(null)

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
    setReady(
      Array.from(files)
        .filter((f) => f.type.startsWith('image/'))
        .map((f) => ({
          file: f,
          admissionNo: admissionFrom(f.webkitRelativePath || f.name),
          preview: URL.createObjectURL(f),
        })),
    )
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

  return (
    <>
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
          <CardHeader
            title={ready.length ? `${ready.length} chosen` : 'How this works'}
            description="Name each file with the child's admission number · 2022/08/145.jpg for admission number 2022/08/145, and every photograph finds its child on its own. Anything that does not, you can point at a child by typing their name."
          />
          {ready.length === 0 ? (
            <EmptyState
              title="No photographs chosen"
              body="Choose the folder the photographer delivered. Anything that is not an image is ignored, and nothing is attached until you press Import."
            />
          ) : (
            <>
              <Table head={['', 'File', 'Goes to', 'Class · roll', '']}>
                {ready.map((r) => {
                  const child = childFor(r.admissionNo)
                  return (
                    <tr key={r.file.name}>
                      <Td>
                        <img
                          src={r.preview}
                          alt=""
                          className="h-12 w-10 rounded border object-cover"
                        />
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
      </PageBody>
    </>
  )
}
