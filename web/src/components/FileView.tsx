import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Paperclip, Download } from 'lucide-react'
import { Button } from '@/components/ui'
import { useOverlayHistory } from '@/lib/overlay-history'

/* Reading an attachment without taking a copy of it.

   Every attachment in this product was a link that downloaded. A teacher
   checking that the worksheet they attached is the right one had to open their
   Downloads folder to find out; a parent on a phone had to save a school
   record onto the phone to read one line of it. Neither is what either of them
   wanted, and the copy in Downloads outlives the reason it was made — which is
   the school's problem, not the reader's.

   So: a full-screen viewer, and Download still there for whoever actually
   wants the file.

   WHAT IT CAN AND CANNOT SHOW

   PDFs, images, plain text, CSV, audio and video render here. A .docx or an
   .xlsx cannot — no browser renders one without either a plug-in or shipping
   the file to somebody else's server to convert, and sending a school's
   records to a third party to save a click is not a trade worth making. Those
   say so plainly and offer the download, which is what they were before.

   The server serves it under a CSP of `sandbox`, so whatever is in the frame
   runs no script and can reach nothing of this origin's.
*/

export interface ViewableFile {
  file_id: string
  name: string
  content_type?: string
}

const IMAGE = /^image\/(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i
const TEXT = /^text\/(plain|csv|markdown|tab-separated-values)$/i

/** What the browser will make of this, from the type and then the name.

    The type is what the uploader's browser declared and is usually right; the
    extension is the fallback for the ones that arrive as
    application/octet-stream, which is most CSVs exported from a spreadsheet. */
function kindOf(f: ViewableFile): 'pdf' | 'image' | 'text' | 'audio' | 'video' | 'none' {
  const ct = (f.content_type ?? '').toLowerCase()
  const ext = (f.name.split('.').pop() ?? '').toLowerCase()
  if (ct === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (IMAGE.test(ct) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic'].includes(ext)) return 'image'
  if (TEXT.test(ct) || ['txt', 'csv', 'md', 'tsv', 'log'].includes(ext)) return 'text'
  if (ct.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio'
  if (ct.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) return 'video'
  return 'none'
}

export function canView(f: ViewableFile) {
  return kindOf(f) !== 'none'
}

/** A CSV read as a table rather than as a wall of commas. */
function CsvTable({ text }: { text: string }) {
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 500)
    .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">Empty file.</p>
  const [head, ...body] = rows
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((c, i) => (
              <th key={i} className="border-b bg-muted/40 px-2 py-1.5 text-left font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {head.map((_, j) => (
                <td key={j} className="border-b px-2 py-1.5 align-top">{r[j] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= 500 && (
        <p className="px-2 py-2 text-[12px] text-muted-foreground">
          First 500 rows. Download the file for the rest.
        </p>
      )}
    </div>
  )
}

export default function FileView({
  file,
  onClose,
}: {
  file: ViewableFile
  onClose: () => void
}) {
  // The phone's Back closes this, like every overlay: see overlay-history.ts.
  /* The hook's return value is what a close control must call. Calling
     onClose directly unmounts first, and the cleanup then spends the
     history entry the hook had pushed -- so the panel closes and the page
     navigates back at the same time. */
  const close = useOverlayHistory(true, onClose)
  const kind = kindOf(file)
  const src = `/api/v1/files/${file.file_id}?inline=1`
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // Text and CSV are fetched rather than framed, so they can be laid out —
  // a CSV in an iframe is a wall of commas.
  useEffect(() => {
    if (kind !== 'text') return
    let gone = false
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (!gone) setText(t) })
      .catch(() => { if (!gone) setFailed(true) })
    return () => { gone = true }
  }, [src, kind])

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [close])

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-background"
      /* Fixed elements escape the body's notch padding, so on the iPhone the
         header would sit under the clock and the bottom under the home
         indicator. Zero in a browser and on Android. */
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
      role="dialog"
      aria-label={file.name}
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <span className="flex min-w-0 items-center gap-2 text-[14px] font-medium">
          <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{file.name}</span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {/* Still offered. Somebody who wants the file wants the file. */}
          <a
            href={`/api/v1/files/${file.file_id}`}
            download={file.name}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-muted"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Download
          </a>
          <Button variant="ghost" onClick={close}>Close</Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-muted/20 p-4">
        {kind === 'pdf' && (
          <iframe src={src} title={file.name} className="h-full w-full rounded border bg-white" />
        )}
        {kind === 'image' && (
          <div className="flex h-full items-center justify-center">
            <img src={src} alt={file.name} className="max-h-full max-w-full object-contain" />
          </div>
        )}
        {kind === 'audio' && (
          <div className="flex h-full items-center justify-center">
            <audio src={src} controls className="w-full max-w-lg" />
          </div>
        )}
        {kind === 'video' && (
          <div className="flex h-full items-center justify-center">
            <video src={src} controls className="max-h-full max-w-full rounded" />
          </div>
        )}
        {kind === 'text' && (
          <div className="mx-auto max-w-4xl rounded border bg-card p-3">
            {failed ? (
              <p className="text-[13px] text-muted-foreground">
                This file could not be read here. Download it instead.
              </p>
            ) : text === null ? (
              <p className="text-[13px] text-muted-foreground">Opening…</p>
            ) : /\.csv$|\.tsv$/i.test(file.name) || (file.content_type ?? '').includes('csv') ? (
              <CsvTable text={text} />
            ) : (
              <pre className="whitespace-pre-wrap break-words text-[13px]">{text}</pre>
            )}
          </div>
        )}
        {kind === 'none' && (
          <div className="mx-auto mt-10 max-w-md rounded border bg-card p-6 text-center">
            <p className="text-[14px] font-medium">This one cannot be shown here</p>
            {/* Said plainly rather than shown as a blank frame. A Word or Excel
                file needs either a plug-in or a trip through somebody else's
                server to convert, and a school's records are not worth sending
                to a third party to save a click. */}
            <p className="mt-1 text-[13px] text-muted-foreground">
              Word, Excel and PowerPoint files open in the app they belong to.
              Everything else — PDFs, pictures, text and CSV — opens here.
            </p>
            <a
              href={`/api/v1/files/${file.file_id}`}
              download={file.name}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Download {file.name}
            </a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
