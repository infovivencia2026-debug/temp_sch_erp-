import { useRef, useState } from 'react'
import { Paperclip, X } from 'lucide-react'
import { Button } from '@/components/ui'

/* Attaching a file, on a deployment with no object store.
 *
 * Every screen that wanted a file used to probe /api/v1/files/presign, get a
 * 503, and put up an honest panel explaining that the school could not host a
 * document and should paste a link instead. The explanation was true and the
 * situation was silly: the server has disk on it.
 *
 * This posts multipart to /api/v1/files and hands back the id. One component
 * rather than one per screen, because the id is the only thing any caller
 * wants and the difference between a lesson plan and a worksheet is the row
 * it ends up attached to, not the upload.
 *
 * Progress is deliberately real. XMLHttpRequest rather than fetch, because
 * fetch still cannot report upload progress, and a teacher sending a 40 MB
 * recording over a school connection needs to see that something is happening
 * rather than decide the button is broken and press it again.
 */

export interface UploadedFile {
  file_id: string
  name: string
  size_bytes: number
  content_type: string
  url: string
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function FilePicker({
  value,
  onChange,
  purpose = 'attachment',
  label = 'Attach a file',
  hint,
}: {
  value: UploadedFile | null
  onChange: (f: UploadedFile | null) => void
  purpose?: string
  label?: string
  hint?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  /* Chosen but not yet sent.
   *
   * Picking a file used to start the upload on the same click, so there was no
   * moment at which somebody could check they had picked the right one — and
   * on a school connection a 40 MB video is a slow mistake to make. Now the
   * choice and the send are two separate acts, and what is about to go up is
   * on screen in between. */
  const [pending, setPending] = useState<File | null>(null)
  const [preview, setPreview] = useState<string>('')

  function choose(file: File) {
    setError('')
    setPending(file)
    // An image is worth showing rather than describing. Revoked when the
    // choice is replaced or cleared, so a long session does not accumulate
    // object URLs for files nobody kept.
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old)
      return file.type.startsWith('image/') ? URL.createObjectURL(file) : ''
    })
  }

  function clear() {
    setPending(null)
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old)
      return ''
    })
  }

  function send(file: File) {
    setError('')
    setProgress(0)
    const body = new FormData()
    body.append('file', file)
    body.append('purpose', purpose)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/v1/files')
    // Same-origin session cookie. No token is minted for uploads: the endpoint
    // is behind the ordinary session middleware like every other call.
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      setProgress(null)
      if (xhr.status === 201) {
        onChange(JSON.parse(xhr.responseText) as UploadedFile)
        clear()
        return
      }
      // The server's own sentence, where it sent one. Its refusals name the
      // reason — too large, a program, storage unconfigured — and replacing
      // them with "upload failed" would throw away the only useful part.
      try {
        setError(JSON.parse(xhr.responseText).message || 'The upload was refused.')
      } catch {
        setError('The upload was refused.')
      }
    }
    xhr.onerror = () => {
      setProgress(null)
      setError('The upload did not reach the server.')
    }
    xhr.send(body)
  }

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px]">{value.name}</span>
        <span className="text-[12.5px] tabular-nums text-muted-foreground">
          {human(value.size_bytes)}
        </span>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          <X className="h-3.5 w-3.5" />
          Remove
        </Button>
      </div>
    )
  }

  return (
    <div>
      <input
        ref={input}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) choose(f)
          // Cleared so choosing the same file twice in a row still fires.
          e.target.value = ''
        }}
      />
      {pending ? (
        <div className="rounded-md border p-3">
          <p className="mb-2 text-[12.5px] font-medium">About to upload</p>
          <div className="flex flex-wrap items-center gap-3">
            {preview ? (
              <img
                src={preview}
                alt=""
                className="h-14 w-14 rounded border object-cover"
              />
            ) : (
              <span className="flex h-14 w-14 items-center justify-center rounded border bg-muted">
                <Paperclip className="h-5 w-5 text-muted-foreground" aria-hidden />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{pending.name}</p>
              <p className="text-[12.5px] text-muted-foreground">
                {human(pending.size)}
                {pending.type ? ` · ${pending.type}` : ''}
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={progress !== null} onClick={() => send(pending)}>
              {progress !== null ? `Uploading ${progress}%` : 'Upload this file'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={progress !== null}
              onClick={() => input.current?.click()}
            >
              Choose a different one
            </Button>
            <Button size="sm" variant="ghost" disabled={progress !== null} onClick={clear}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={progress !== null}
            onClick={() => input.current?.click()}
          >
            <Paperclip className="h-3.5 w-3.5" />
            {label}
          </Button>
          <span className="text-[12.5px] text-muted-foreground">
            {hint ?? 'Any document, image, recording or archive, up to 64 MB.'}
          </span>
        </div>
      )}
      {progress !== null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
      {error && <p className="mt-1.5 text-[12.5px] text-destructive">{error}</p>}
    </div>
  )
}
