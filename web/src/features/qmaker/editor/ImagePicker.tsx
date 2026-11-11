import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Dialog, EmptyState, ErrorState, Field, Input, Loading } from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { imgSrc, searchImages, uploadImage, type ImageAsset } from '../lib/images'

/* The image store: every picture anyone at the school has put into a paper or
   a banked question, found by its name. Pick one, or several for a row. */
export default function ImagePicker({ onPick, onClose }: { onPick: (assets: ImageAsset[]) => void; onClose: () => void }) {
  const [up, setUp] = useState(0)
  return (
    <Dialog title="Image store" size="xl" onClose={onClose}
      actions={<Button onClick={() => setUp((n) => n + 1)}>Upload picture</Button>}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <ImageStorePane onPick={onPick} uploadTrigger={up} />
    </Dialog>
  )
}

/** The image store itself, also a tab of Find a picture (owner, 2026-11-11: "remove photos, add image store there"). */
export function ImageStorePane({ onPick, uploadTrigger = 0 }: { onPick: (assets: ImageAsset[]) => void; uploadTrigger?: number }) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<ImageAsset[]>([])
  const list = useQuery({ queryKey: ['paper-images', q.trim()], queryFn: () => searchImages(q.trim()) })
  const on = (a: ImageAsset) => picked.some((p) => p.id === a.id)
  const toggle = (a: ImageAsset) => setPicked((p) => (on(a) ? p.filter((x) => x.id !== a.id) : [...p, a]))
  /* Teachers keep their own pictures here under a name they choose, and rename
     any picture (owner, 2026-11-11: "let them upload saved images and save it by the name"). */
  const qc = useQueryClient()
  const file = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [rename, setRename] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['paper-images'] })
  // Upload (owner, 2026-11-11): pick the file, then name it anything and Save.
  const [pending, setPending] = useState<{ file: File; url: string } | null>(null)
  useEffect(() => { if (uploadTrigger > 0) file.current?.click() }, [uploadTrigger])
  useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.url) }, [pending])
  const choose = (f: File | undefined) => {
    if (!f) return
    setPending({ file: f, url: URL.createObjectURL(f) }); setName(f.name.replace(/\.[a-z0-9]+$/i, '')); setNote('')
  }
  const saveUpload = async () => {
    if (!pending || !name.trim()) return
    setBusy(true); setNote('')
    try {
      const a = await uploadImage(pending.file, name.trim())
      setNote(`Saved as "${a.name}".`); setPending(null); setName(''); setPicked([a]); refresh()
    } catch (e) { setNote(e instanceof Error ? e.message : 'Could not save the picture.') } finally { setBusy(false) }
  }
  const one = picked.length === 1 ? picked[0] : null
  const saveName = async () => {
    if (!one || !rename.trim()) return
    setBusy(true)
    try {
      const r = await api.post<{ name: string }>('/api/v1/exams/paper-images', { file_id: one.id, name: rename.trim(), width: one.w, height: one.h })
      setPicked([{ ...one, name: r.name }]); setNote(`Renamed to "${r.name}".`); setRename(''); refresh()
    } catch (e) { setNote(e instanceof Error ? e.message : 'Could not rename.') } finally { setBusy(false) }
  }

  return (
      <div className="space-y-4">
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
          onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; choose(f) }} />
        {pending && (
          <div className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-end">
            <img src={pending.url} alt="" className="h-20 w-20 shrink-0 rounded-md object-contain" />
            <div className="min-w-0 flex-1"><Field label="Name of the picture"><Input value={name} onChange={setName} placeholder="e.g. Red apple" /></Field></div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => { setPending(null); setName('') }}>Cancel</Button>
              <Button disabled={busy || !name.trim()} onClick={() => void saveUpload()}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        )}
        {one && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1"><Field label={`Rename "${one.name || 'Picture'}"`}><Input value={rename} onChange={setRename} placeholder="New name" /></Field></div>
            <Button variant="secondary" className="shrink-0" disabled={busy || !rename.trim()} onClick={() => void saveName()}>Save name</Button>
          </div>
        )}
        {note && <p className="text-[13px] text-muted-foreground" role="status">{note}</p>}
        <SearchBox value={q} onChange={setQ} placeholder="Search by name" />
        {list.isLoading ? <Loading shape="cards" /> : list.error ? <ErrorState error={list.error} /> : !list.data?.length ? (
          <EmptyState
            title={q.trim() ? 'No picture has that name.' : 'No pictures yet.'}
            body={q.trim() ? 'Try part of the name, or add the picture from this device with Insert.' : 'Pictures you add to a paper with Insert are kept here under their file name.'}
          />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {list.data.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  aria-pressed={on(a)}
                  onClick={() => toggle(a)}
                  onDoubleClick={() => onPick([a])}
                  className={`qm-imgtile ${on(a) ? 'on' : ''}`}
                >
                  <img src={imgSrc(a)} alt="" loading="lazy" />
                  <span className="truncate">{(a.name || 'Picture').replace(/ \(by .*$/, '')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="sticky bottom-0 flex justify-end bg-background/95 py-2">
          <Button disabled={!picked.length} onClick={() => onPick(picked)}>
            {picked.length > 1 ? `Insert ${picked.length} pictures` : 'Insert picture'}
          </Button>
        </div>
      </div>
  )
}
