import { useEffect, useRef, useState } from 'react'

/* The assistant's face (owner, 2026-11-05: "this is the face of the AI bot,
   change it", with eyes that follow the cursor).

   A white head with a dark visor; two glowing eyes on the visor say what the
   assistant is doing, legible from across a desk without reading a label:
     idle       tall soft eyes, blinking now and then
     typing     eyes open wide: it is listening to what is being written
     thinking   one eye squints, a question mark floats: it is working it out
     answering  eyes bob as it speaks
   The eyes (and, a little, the head) follow the pointer anywhere on the page.

   Drawn at 240px and scaled to `size`, so the 44px button over the dock and
   the 160px face inside the chat are the same face.

   MOODS. While idle it is not a statue (owner, 2026-11-05: "let her
   expression change every few secs"): every 6-12 seconds it pulls a face --
   a wink, a laugh, hearts, a sleepy blink, a curious look -- for two and a
   half seconds, then settles back. Never while thinking, answering or being
   typed at, where the face is saying something. Reduced motion: no
   floating, no tracking, no blinking -- the expressions alone still say it. */

export type OrbState = 'idle' | 'thinking' | 'answering'

export function AssistantOrb({
  state,
  size = 40,
  awake = false,
  typing = false,
  subtle = false,
}: {
  state: OrbState
  size?: number
  /* Being typed at: wins over the state's idle face. */
  typing?: boolean
  /* Pointed at: the face lifts a little and the eyes brighten. */
  awake?: boolean
  /* Inside the chat: a softer shadow so it sits beside the words. */
  subtle?: boolean
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [mood, setMood] = useState<string | null>(null)
  const resting = state === 'idle' && !typing
  /* A TOUCH CHANGES THE FACE (owner, 2026-11-09: "let the expression change
     when I touch here"). Each tap pulls a different face for a moment and the
     head gives a little bounce. */
  const [poke, setPoke] = useState<{ face: string; n: number } | null>(null)
  const pokeT = useRef(0)
  useEffect(() => () => clearTimeout(pokeT.current), [])
  const onPoke = () => {
    if (state !== 'idle') return
    const FACES = ['laugh', 'love', 'wink', 'happy', 'curious', 'sleepy']
    setPoke((p) => {
      const pool = FACES.filter((f) => f !== p?.face)
      return { face: pool[Math.floor(Math.random() * pool.length)], n: (p?.n ?? 0) + 1 }
    })
    clearTimeout(pokeT.current)
    pokeT.current = window.setTimeout(() => setPoke(null), 1800)
  }

  useEffect(() => {
    if (!resting || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setMood(null); return }
    const MOODS = ['wink', 'laugh', 'love', 'sleepy', 'curious', 'happy']
    let t = 0
    const next = () => {
      t = window.setTimeout(() => {
        setMood(MOODS[Math.floor(Math.random() * MOODS.length)])
        t = window.setTimeout(() => { setMood(null); next() }, 2500)
      }, 6000 + Math.random() * 6000)
    }
    next()
    return () => clearTimeout(t)
  }, [resting])

  useEffect(() => {
    const el = ref.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    let px = 0
    let py = 0
    const apply = () => {
      raf = 0
      const r = el.getBoundingClientRect()
      if (!r.width) return
      // In the 240px drawing's own units, capped so the eyes stay on the visor.
      const k = 240 / r.width
      const dx = Math.max(-28, Math.min(28, ((px - (r.left + r.width / 2)) * k) / 25))
      const dy = Math.max(-18, Math.min(18, ((py - (r.top + r.height / 2)) * k) / 25))
      el.style.setProperty('--look-x', `${dx.toFixed(1)}px`)
      el.style.setProperty('--look-y', `${dy.toFixed(1)}px`)
    }
    const move = (e: PointerEvent) => {
      px = e.clientX
      py = e.clientY
      if (!raf) raf = requestAnimationFrame(apply)
    }
    window.addEventListener('pointermove', move, { passive: true })
    let blinkT = 0
    let openT = 0
    const blink = () => {
      el.setAttribute('data-blink', '')
      openT = window.setTimeout(() => el.removeAttribute('data-blink'), 150)
      blinkT = window.setTimeout(blink, 2000 + Math.random() * 3000)
    }
    blinkT = window.setTimeout(blink, 2000)
    return () => {
      window.removeEventListener('pointermove', move)
      cancelAnimationFrame(raf)
      clearTimeout(blinkT)
      clearTimeout(openT)
    }
  }, [])

  const face = poke && state === 'idle' ? poke.face : typing && state === 'idle' ? 'listening' : resting && mood ? mood : state
  return (
    <span
      ref={ref}
      className="bot-face"
      data-face={face}
      data-awake={awake || typing ? '' : undefined}
      data-subtle={subtle ? '' : undefined}
      data-poke={poke ? String(poke.n % 2) : undefined}
      onPointerDown={onPoke}
      style={{ width: size, height: size, ['--bot-scale' as string]: String(size / 240), pointerEvents: 'auto', cursor: state === 'idle' ? 'pointer' : undefined }}
      aria-hidden="true"
    >
      <span className="bot-face__art">
        <span className="bot-face__shadow" />
        <span className="bot-face__head">
          <span className="bot-face__visor">
            <span className="bot-face__q">?</span>
            <span className="bot-face__tear bot-face__tear--l" />
            <span className="bot-face__tear bot-face__tear--r" />
            <span className="bot-face__eyes">
              <span className="bot-face__eye bot-face__eye--l" />
              <span className="bot-face__eye bot-face__eye--r" />
            </span>
          </span>
        </span>
      </span>
    </span>
  )
}
