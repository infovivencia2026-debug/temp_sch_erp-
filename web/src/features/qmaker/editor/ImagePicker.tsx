import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Dialog, EmptyState, ErrorState, Loading } from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { imgSrc, searchImages, type ImageAsset } from '../lib/images'

/* The image store: every picture anyone at the school has put into a paper or
   a banked question, found by its name. Pick one, or several for a row. */
export default function ImagePicker({ onPick, onClose }: { onPick: (assets: ImageAsset[]) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<ImageAsset[]>([])
  const list = useQuery({ queryKey: ['paper-images', q.trim()], queryFn: () => searchImages(q.trim()) })
  const on = (a: ImageAsset) => picked.some((p) => p.id === a.id)
  const toggle = (a: ImageAsset) => setPicked((p) => (on(a) ? p.filter((x) => x.id !== a.id) : [...p, a]))

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
