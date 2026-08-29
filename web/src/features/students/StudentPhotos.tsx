import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Button, Table, Td, Badge,
  FormNotice, EmptyState,
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

   Every file is uploaded and then matched. What matched is applied; what did
   not is listed by name so somebody can rename three files rather than start
   the batch again.
*/

interface Ready {
  file: File
  admissionNo: string
  preview: string
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

export default function StudentPhotos() {
  const nav = useRouteFeature()
  const [ready, setReady] = useState<Ready[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ matched: number; unmatched: string[] } | null>(null)

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
        for (const r of ready) {
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
      // What matched is done. What did not is still on screen with its name,
      // which is what somebody needs in order to fix it.
      setReady((old) => old.filter((x) => r.unmatched.includes(x.admissionNo)))
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

  return (
    <>
      <PageHead
        eyebrow={nav.section?.name ?? 'Students'}
        title={nav.feature?.name ?? 'Student photographs'}
        description="The photographer's folder, matched to children by admission number. Photographs print on the ID card and on the report card."
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
              <Button disabled={busy} onClick={() => send.mutate()}>
                {busy ? 'Uploading…' : `Import ${ready.length}`}
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
                ? ` ${result.unmatched.length} matched no admission number and are still listed below — rename them and import again.`
                : '')
            }
          />
        )}

        <Card>
          <CardHeader
            title={ready.length ? `${ready.length} ready to import` : 'How this works'}
            description="Name each file with the child's admission number — 2022/08/145.jpg for admission number 2022/08/145. Most photographers will do this if asked; the office can also rename in bulk from the roll list."
          />
          {ready.length === 0 ? (
            <EmptyState
              title="No photographs chosen"
              body="Choose the folder the photographer delivered. Anything that is not an image is ignored, and nothing is attached until you press Import."
            />
          ) : (
            <Table head={['', 'File', 'Reads as admission no.', '']}>
              {ready.map((r) => (
                <tr key={r.file.name}>
                  <Td>
                    <img
                      src={r.preview}
                      alt=""
                      className="h-12 w-10 rounded border object-cover"
                    />
                  </Td>
                  <Td className="text-[13px]">{r.file.name}</Td>
                  <Td className="font-mono text-[12px]">{r.admissionNo}</Td>
                  <Td>
                    {result?.unmatched.includes(r.admissionNo) && (
                      <Badge tone="warning">no child with this number</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
