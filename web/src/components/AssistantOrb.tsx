import { useEffect, useRef } from 'react'

/* The assistant's status, as a fluid ball.

   A spinner says "busy". This says which KIND of busy, which is the thing
   somebody waiting actually wants to know: is it still reading, or already
   writing? Three states, and the difference between them is legible from
   across a desk without reading the label.

   THE BALL. Five soft blobs -- teal, cyan, green, lime, emerald -- drifting
   under a glass haze, the design the owner handed over. Each blob runs its
   own slow keyframe loop in CSS, which the compositor animates for free.

   STATES BLEND, THEY DO NOT RESTART. Swapping one CSS animation for another
   restarts it at its own keyframe zero, which makes the ball jump at exactly
   the moment somebody is watching it for reassurance. So the keyframes never
   change. What a state changes is the PLAYBACK RATE of the running
   animations -- idle drifts, thinking churns, answering flows -- eased from
   one rate to the next over a quarter of a second through the Web Animations
   API, and the glow, which is a CSS transition on the ball itself. The blobs
   are always where they were a frame ago.

   Reduced motion stops the drift and keeps the glow: a still ball that
   brightens when it is thinking still says the one thing it exists to say. */

export type OrbState = 'idle' | 'thinking' | 'answering'

/* How fast the drift runs in each state, as a multiple of the design's own
   tempo. Idle is a breath; thinking is visibly churning; answering flows a
   little faster than rest, the way somebody speaking moves more than
   somebody listening. */
const RATE: Record<OrbState, number> = { idle: 1, thinking: 3.2, answering: 1.7 }

export function AssistantOrb({
  state,
  size = 40,
  awake = false,
  typing = false,
}: {
  state: OrbState
  size?: number
  /* Being typed at. The owner wanted the ball to move quickly while a
     question is being written -- the same churn as thinking, so the ball
     answers each keystroke -- and to settle again a moment after the last
     key. Wins over awake, because a hover is a smaller thing than typing. */
  typing?: boolean
  /* Pointed at. Applied on top of whatever the state asked for, rather than
     as a fourth state: a hover during "thinking" must not slow the ball to
     some hover speed. It quickens a little and brightens, and leaves the
     state's own rate alone. */
  awake?: boolean
}) {
  const ref = useRef<HTMLSpanElement>(null)
  // The target lives in a ref: the easing loop reads it every frame, and a
  // re-run of the effect on each change would tear the loop down.
  const want = typing ? Math.max(RATE[state], RATE.thinking) : RATE[state] * (awake ? 1.4 : 1)
  const target = useRef(want)
  target.current = want

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let rate = target.current
    let raf = 0
    let last = 0
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - (last || now)) / 1000)
      last = now
      // Critically damped, not springy: an overshoot reads as a bounce, and
      // a bouncing status light looks like an error.
      rate += (target.current - rate) * Math.min(1, dt * 4)
      for (const a of el.getAnimations({ subtree: true })) a.playbackRate = rate
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <span
      ref={ref}
      className="fluid-orb"
      data-state={state}
      data-awake={awake || typing ? '' : undefined}
      style={{ width: size, height: size, ['--orb-size' as string]: `${size}px` }}
      aria-hidden="true"
    >
      <span className="fluid-orb__blob fluid-orb__blob-1" />
      <span className="fluid-orb__blob fluid-orb__blob-2" />
      <span className="fluid-orb__blob fluid-orb__blob-3" />
      <span className="fluid-orb__blob fluid-orb__blob-4" />
      <span className="fluid-orb__blob fluid-orb__blob-5" />
      <span className="fluid-orb__glass" />
    </span>
  )
}
