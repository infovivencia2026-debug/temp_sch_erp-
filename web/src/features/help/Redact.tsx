import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { useT } from '@/lib/i18n'

/* A screenshot with anything private blacked out before it leaves the device.

   The picture is drawn on a canvas; dragging a finger or the mouse over it
   draws a black box, and what is uploaded is the canvas, so the boxes are
   burnt into the pixels rather than laid over them. Large photos are scaled
   to 1600px on the long side first, which is also what keeps the upload
   small on phone data. */

const MAX_SIDE = 1600

export interface RedactedImage { blob: Blob; name: string }

export function Redact({ file, onChange }: { file: File; onChange: (img: RedactedImage | null) => void }) {
  const t = useT()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [boxes, setBoxes] = useState<[number, number, number, number][]>([])
  const drag = useRef<{ x: number; y: number } | null>(null)
  const [live, setLive] = useState<[number, number, number, number] | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    const i = new Image()
    i.onload = () => setImg(i)
    i.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    const c = canvas.current
    if (!c || !img) return
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    c.width = Math.round(img.naturalWidth * scale)
    c.height = Math.round(img.naturalHeight * scale)
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0, c.width, c.height)
    g.fillStyle = '#000'
    for (const b of live ? [...boxes, live] : boxes) g.fillRect(b[0], b[1], b[2], b[3])
    if (!live) {
      c.toBlob((blob) => { if (blob) onChange({ blob, name: file.name.replace(/\.\w+$/, '') + '.png' }) }, 'image/png')
    }
    // onChange is the caller's setter; redrawing on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, boxes, live, file.name])

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height }
  }
  const box = (a: { x: number; y: number }, b: { x: number; y: number }): [number, number, number, number] =>
    [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y)]

  return (
    <div className="space-y-2">
      <p className="text-[13px] text-muted-foreground">{t('help.redact')}</p>
      <canvas
        ref={canvas}
        className="block max-h-[60vh] w-full touch-none rounded-md object-contain shadow-[var(--field-shadow)]"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = at(e) }}
        onPointerMove={(e) => { if (drag.current) setLive(box(drag.current, at(e))) }}
        onPointerUp={(e) => {
          if (drag.current) {
            const b = box(drag.current, at(e))
            if (b[2] > 4 && b[3] > 4) setBoxes((bs) => [...bs, b])
          }
          drag.current = null
          setLive(null)
        }}
      />
      {boxes.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setBoxes((bs) => bs.slice(0, -1))}>{t('help.undo_box')}</Button>
      )}
    </div>
  )
}
