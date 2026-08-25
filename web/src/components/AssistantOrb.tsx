import { useEffect, useRef } from 'react'

/* The assistant's status, as movement rather than a spinner.

   A spinner says "busy". This says which KIND of busy, which is the thing
   somebody waiting actually wants to know: is it still reading, or already
   writing? Three states, and the difference between them is legible from across
   a desk without reading the label.

   Drawn on a canvas rather than assembled from CSS keyframes because the states
   have to BLEND. Swapping one CSS animation for another restarts it at its own
   keyframe zero, which makes the ball jump at exactly the moment somebody is
   watching it for reassurance. */

export type OrbState = 'idle' | 'thinking' | 'answering'

const TAU = Math.PI * 2

export function AssistantOrb({ state, size = 34 }: { state: OrbState; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  /* The target lives in a ref, not in state: the animation loop reads it every
     frame, and re-running the effect on each change would tear down and restart
     the loop — which is the jump this component exists to avoid. */
  const target = useRef<OrbState>(state)
  target.current = state

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Everything animated is a pair — where it is, and where it is going — so a
    // state change moves a target and the orb eases into it.
    const amp = { v: 1, to: 1 }
    const speed = { v: 0.35, to: 0.35 }
    const glow = { v: 0.25, to: 0.25 }
    let t = 0
    let last = 0
    let raf = 0

    const aim = () => {
      const s = target.current
      if (s === 'idle') { amp.to = 1; speed.to = 0.35; glow.to = 0.25 }
      if (s === 'thinking') { amp.to = 0.62; speed.to = 2.6; glow.to = 0.9 }
      if (s === 'answering') { amp.to = 1.22; speed.to = 1.1; glow.to = 0.6 }
    }
    // Critically damped, not springy: an overshoot reads as a bounce, and a
    // bouncing status light looks like an error.
    const ease = (p: { v: number; to: number }, dt: number) => {
      p.v += (p.to - p.v) * Math.min(1, dt * 4)
    }

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - (last || now)) / 1000)
      last = now
      aim()
      ease(amp, dt); ease(speed, dt); ease(glow, dt)
      t += dt * speed.v

      const c = size / 2
      const base = size * 0.26 * amp.v
      ctx.clearRect(0, 0, size, size)

      const halo = ctx.createRadialGradient(c, c, base * 0.2, c, c, base * 2.1)
      halo.addColorStop(0, `rgba(96,165,250,${0.32 * glow.v})`)
      halo.addColorStop(1, 'rgba(96,165,250,0)')
      ctx.fillStyle = halo
      ctx.fillRect(0, 0, size, size)

      /* Three rings at slightly different rates. One ring is a spinner; three
         at different speeds read as something with depth, and the difference
         between them is what makes a change of speed visible at all. */
      for (let i = 0; i < 3; i++) {
        const phase = t * (1 + i * 0.35) + (i * TAU) / 3
        const wob = still ? 0 : Math.sin(phase) * base * 0.16
        const r = base + wob - i * base * 0.13
        ctx.beginPath()
        for (let a = 0; a <= TAU + 0.01; a += 0.1) {
          // A perfect circle cannot show rotation; the lobes give the eye
          // something to track.
          const lobe = still ? 0 : Math.sin(a * 3 + phase * 1.6) * base * 0.07 * amp.v
          const rr = r + lobe
          const x = c + Math.cos(a) * rr
          const y = c + Math.sin(a) * rr
          if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.strokeStyle = `rgba(96,165,250,${0.9 - i * 0.26})`
        ctx.lineWidth = 1.6 - i * 0.35
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(c, c, base * 0.34, 0, TAU)
      ctx.fillStyle = `rgba(191,219,254,${0.55 + glow.v * 0.4})`
      ctx.fill()

      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden="true" />
}
