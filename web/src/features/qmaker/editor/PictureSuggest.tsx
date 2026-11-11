import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Editor } from '@tiptap/react'
import { X } from 'lucide-react'
import { Button, Dialog, EmptyState, ErrorState, Loading, SEG_BAR, segClass } from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { useToast } from '@/components/Toast'
import { useDebouncedValue } from '@/lib/debounce'
import { ImageStorePane } from './ImagePicker'
import { pictureKeywords, tileSrc, searchPictures, storePicture, type PictureHit, type PictureKind } from '../lib/pictures'
import { insertAssets } from './RichInput'
import { useMaker } from './context'

/* Pictures suggested while a teacher types, and a dialog to look for one.
   Free, openly licensed clip art (photos on request) from an open library;
   a click stores it in the image store and puts it at the cursor. */

const STRIP = 6

/** Stores the picture and puts it where the cursor is. */
function useInsertPicture(editor: Editor | null) {
  const { remember } = useMaker()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const insert = async (p: PictureHit) => {
    if (!editor || busy) return false
    setBusy(p.full)
    try {
      const a = await storePicture(p)
      remember([a])
      insertAssets(editor, [a])
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That picture could not be added.')
      return false
    } finally {
      setBusy(null)
    }
  }
  return { insert, busy }
}

function Tile({ p, onPick, busy, small }: { p: PictureHit; onPick: () => void; busy: boolean; small?: boolean }) {
  const credit = [p.title, p.creator && `by ${p.creator}`, p.licence].filter(Boolean).join(', ')
  return (
    <button type="button" className={`qm-pictile ${small ? 'small' : ''}`} title={`Insert: ${credit}`} aria-label={`Insert picture: ${credit}`}
      disabled={busy} aria-busy={busy} onClick={onPick}>
      <img src={tileSrc(p.thumb)} alt="" loading="lazy" referrerPolicy="no-referrer" />
      {!small && <span className="truncate">{p.title || 'Picture'}</span>}
      {!small && <span className="truncate text-muted-foreground">{p.licence}{p.creator ? ` · ${p.creator}` : ''}</span>}
    </button>
  )
}

/** The words of the paragraph the cursor is in. */
const paragraphText = (e: Editor | null) => (e && !e.isDestroyed ? e.state.selection.$from.parent.textContent : '')

/** A small row of suggestions under the toolbar, for the paragraph being typed. */
/* The thing to draw is nearly always the last key word ("What is the colour of
   apple?" -> apple); three words together brought mixed pictures (owner, 2026-11-11). */
const lastWord = (q: string) => q.split(' ').filter(Boolean).pop() ?? ''

export function PictureStrip({ editor }: { editor: Editor | null }) {
  // Asks once typing has paused for a second, and only for words worth a picture.
  const q = useDebouncedValue(lastWord(pictureKeywords(paragraphText(editor))), 1000)
  const [hidden, setHidden] = useState('')
  const { insert, busy } = useInsertPicture(editor)
  const ask = q.length >= 3 && q !== hidden
  const res = useQuery({
    queryKey: ['picture-search', 'clipart', q],
    queryFn: ({ signal }) => searchPictures(q, 'clipart', signal),
    enabled: ask,
    staleTime: 10 * 60_000,
    retry: false,
  })
  if (!ask || !editor) return null
  const items = res.data?.items.slice(0, STRIP) ?? []
  return (
    <div className="qm-picstrip" role="region" aria-label={`Pictures for ${q}`}>
      <span className="qm-picstrip__label truncate">Pictures for &lsquo;{q}&rsquo;</span>
      <div className="qm-picstrip__row">
        {res.isLoading ? <span className="qm-thint">Looking…</span>
          : res.error || res.data?.unavailable ? <span className="qm-thint">The picture library did not answer.</span>
          : !items.length ? <span className="qm-thint">No pictures found.</span>
          : items.map((p) => <Tile key={p.full} p={p} small busy={busy === p.full} onPick={() => insert(p)} />)}
      </div>
      <Button size="sm" variant="ghost" title="Hide these pictures" onClick={() => setHidden(q)}><X className="size-4" /></Button>
    </div>
  )
}

/** "Find a picture": search the library, clip art or photos. */
export function PictureDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { from, to, empty } = editor.state.selection
  const [text, setText] = useState(() => empty ? lastWord(pictureKeywords(paragraphText(editor))) : pictureKeywords(editor.state.doc.textBetween(from, to, ' ')))
  const [tab, setTab] = useState<'clipart' | 'store'>('clipart')
  const kind: PictureKind = 'clipart'
  const q = pictureKeywords(useDebouncedValue(text, 400))
  const { insert, busy } = useInsertPicture(editor)
  const res = useQuery({
    queryKey: ['picture-search', kind, q],
    queryFn: ({ signal }) => searchPictures(q, kind, signal),
    enabled: tab === 'clipart' && q.length >= 3,
    staleTime: 10 * 60_000,
    retry: false,
  })
  /* No longer flips the tab when clip art falls back to photos: the cached
     fallback flipped it straight back each time, so Clip art could not be
     chosen (owner, 2026-11-11). It says so instead. */

  return (
    <Dialog
      title="Find a picture"
      description="Free clip art, or your school's own pictures in the image store."
      size="xl"
      onClose={onClose}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4">
        <div className={SEG_BAR} role="group" aria-label="Where the picture comes from">
          {([['clipart', 'Clip art'], ['store', 'Image store']] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={tab === k} className={segClass(tab === k)} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === 'store' ? <ImageStorePane onPick={(assets) => { insertAssets(editor, assets); onClose() }} /> : <>
        <SearchBox value={text} onChange={setText} placeholder="What should the picture show? e.g. apple" />
        {q.length < 3 ? <EmptyState title="Type what the picture should show." body="For example: apple, leaf, clock." />
          : res.isLoading ? <Loading shape="cards" />
          : res.error ? <ErrorState error={res.error} />
          : res.data?.unavailable ? <EmptyState title="The picture library did not answer." body="Try again in a moment." />
          : !res.data?.items.length ? <EmptyState title="No clip art found." body="Try a simpler word, in English, or upload your own in the image store." />
          : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {res.data.items.map((p) => (
                <li key={p.full}><Tile p={p} busy={busy === p.full} onPick={async () => { if (await insert(p)) onClose() }} /></li>
              ))}
            </ul>
          )}
        </>}
      </div>
    </Dialog>
  )
}
