import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Dialog, EmptyState, ErrorState, Field, Input, Loading } from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { imgSrc, searchImages, uploadImage, type ImageAsset } from '../lib/images'

/* The image store: every picture anyone at the school has put into a paper or
   a banked question, found by its name. Pick one, or several for a row. */
export default function ImagePicker({ onPick, onClose }: { onPick: (assets: ImageAsset[]) => void; onClose: () => void }) {
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
  const upload = async (files: File[]) => {
    if (!files.length) return
    setBusy(true); setNote('')
    try {
      const added: ImageAsset[] = []
      for (const [i, f] of files.entries()) {
        const base = name.trim() || f.name.replace(/\.[a-z0-9]+$/i, '')
        added.push(await uploadImage(f, files.length > 1 && name.trim() ? `${base} ${i + 1}` : base))
      }
      setNote(added.length === 1 ? `Saved as "${added[0].name}".` : `Saved ${added.length} pictures.`)
      setName(''); setPicked(added); refresh()
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
    <Dialog
      title="Image store"
      description="Pictures already used in your school's papers. Choose one, or several to put side by side."
      size="xl"
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!picked.length} onClick={() => onPick(picked)}>
          {picked.length > 1 ? `Insert ${picked.length} pictures` : 'Insert picture'}
        </Button>
      </>}
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1"><Field label="Save a picture from this device" hint="Give it a name so anyone can find it later."><Input value={name} onChange={setName} placeholder="Name, e.g. Red apple" /></Field></div>
          <Button className="shrink-0" disabled={busy} onClick={() => file.current?.click()}>{busy ? 'Saving…' : 'Upload picture'}</Button>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
            onChange={(ev) => { const fs = [...(ev.target.files ?? [])]; ev.target.value = ''; void upload(fs) }} />
        </div>
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
                  <span className="truncate">{a.name || 'Picture'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
