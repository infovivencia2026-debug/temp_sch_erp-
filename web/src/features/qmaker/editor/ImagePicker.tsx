import { useEffect, useRef, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
  const list = useQuery({ queryKey: ['paper-images', q.trim()], queryFn: () => searchImages(q.trim()) })
  /* Teachers keep their own pictures here under a name they choose, and rename
     any picture (owner, 2026-11-11: "let them upload saved images and save it by the name"). */
  const qc = useQueryClient()
  const file = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
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
      await uploadImage(pending.file, name.trim())
      setPending(null); setName(''); refresh()
    } catch (e) { setNote(e instanceof Error ? e.message : 'Could not save the picture.') } finally { setBusy(false) }
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
        {note && <p className="text-[13px] text-destructive" role="alert">{note}</p>}
        <SearchBox value={q} onChange={setQ} placeholder="Search by name" />
        {list.isLoading ? <Loading shape="cards" /> : list.error ? <ErrorState error={list.error} /> : !list.data?.length ? (
          <EmptyState
            title={q.trim() ? 'No picture has that name.' : 'No pictures yet.'}
            body={q.trim() ? 'Try part of the name, or add the picture from this device with Insert.' : 'Pictures you add to a paper with Insert are kept here under their file name.'}
          />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {list.data.map((a) => (
              <li key={a.id}><StoreTile a={a} onPick={() => onPick([a])} onRenamed={refresh} /></li>
            ))}
          </ul>
        )}
      </div>
  )
}

/* One picture: click it to put it in; the pencil under it renames it there
   (owner, 2026-11-11: "add pencil for each image, rename it below the image"). */
function StoreTile({ a, onPick, onRenamed }: { a: ImageAsset; onPick: () => void; onRenamed: () => void }) {
  const shown = (a.name || 'Picture').replace(/ \(by .*$/, '')
  const [edit, setEdit] = useState(false)
  const [val, setVal] = useState(shown)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const n = val.trim()
    if (!n || n === shown) { setEdit(false); return }
    setBusy(true)
    try { await api.post('/api/v1/exams/paper-images', { file_id: a.id, name: n, width: a.w, height: a.h }); onRenamed(); setEdit(false) } finally { setBusy(false) }
  }
  return (
    <div className="qm-imgtile">
      <button type="button" className="contents" title="Put this picture in the question" onClick={onPick}>
        <img src={imgSrc(a)} alt="" loading="lazy" />
      </button>
      {edit ? (
        <div className="flex items-center gap-1">
          <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} aria-label="Picture name"
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEdit(false) }}
            className="field h-7 min-w-0 flex-1 rounded-md px-2 text-[14px]" />
          <Button size="sm" variant="ghost" className="!h-7 !w-7 !min-h-0 !p-0" title="Save name" disabled={busy} onClick={() => void save()}><Check className="size-3.5" /></Button>
          <Button size="sm" variant="ghost" className="!h-7 !w-7 !min-h-0 !p-0" title="Cancel" onClick={() => { setVal(shown); setEdit(false) }}><X className="size-3.5" /></Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate">{shown}</span>
          <Button size="sm" variant="ghost" className="!h-7 !w-7 !min-h-0 !p-0" title="Rename" onClick={() => { setVal(shown); setEdit(true) }}><Pencil className="size-3.5" /></Button>
        </div>
      )}
    </div>
  )
}
