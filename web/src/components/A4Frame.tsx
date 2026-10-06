import { useEffect, useRef, useState } from 'react'

/* A DOCUMENT SHOWN AT ITS PAPER SIZE, SHRUNK TO FIT (owner, 2026-10-06:
   "any device, don't compress to make it responsive, keep A4 always").

   The page is laid out at the paper's own width (A4 portrait is 794 CSS px,
   landscape 1123) and then scaled down as one picture to the space it has,
   so a phone shows the same receipt the printer will, only smaller, instead
   of re-flowing it into a tall thin column. */
const WIDTH = { a4: 794, 'a4-landscape': 1123, a5: 559, letter: 816 } as const

export default function A4Frame({ html, title, size = 'a4' }: { html: string; title: string; size?: keyof typeof WIDTH }) {
  const box = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  const [height, setHeight] = useState(1123)
  const paper = WIDTH[size]

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setAvail(el.clientWidth)
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener('resize', measure)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  const scale = avail ? Math.min(1, avail / paper) : 1
  return (
    <div ref={box} className="w-full overflow-hidden">
      <div style={{ width: paper * scale, height: height * scale, margin: '0 auto' }}>
        <iframe
          title={title}
          srcDoc={html}
          scrolling="no"
          className="block rounded-md border-0 bg-white shadow-sm"
          style={{ width: paper, height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
          onLoad={(e) => { const d = e.currentTarget.contentDocument; if (d) setHeight(d.documentElement.scrollHeight) }}
        />
      </div>
    </div>
  )
}
