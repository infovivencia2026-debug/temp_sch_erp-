import { useEffect, useRef, useState } from 'react'
import { actingInstitution } from '@/lib/api'
import type { Lesson } from './lms-shared'
import { LockedFrame } from './YouTubeLesson'

/* A lesson's library video (worker routes/teaching/videos.ts).

   A plain <video> over GET /lms/videos/{id}/stream, which answers Range
   requests, so seeking works in Safari (iPhone) as in Chrome. Speed buttons
   under it. For the child's own login (`track`), the place is saved and
   restored ("resume where you left off"), and the stretches actually played
   are sent as a map of buckets; the server merges them and, at 90% watched,
   marks the lesson finished. */

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]

/** Same as bucketFor in the worker. */
export const bucketFor = (duration: number) => Math.max(5, Math.ceil(duration / 2000))

export function fmtDur(s?: number | null): string {
  if (!s || !Number.isFinite(s)) return ''
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(sec).padStart(2, '0')
}

export function VideoPlayer({ lesson, track, onFinished, videoId }: { lesson?: Lesson; track?: boolean; onFinished?: () => void; videoId?: string }) {
  const id = videoId ?? lesson?.video_id ?? ''
  const ref = useRef<HTMLVideoElement>(null)
  const [speed, setSpeed] = useState(1)
  const [resumed, setResumed] = useState<number | null>(null)
  const [percent, setPercent] = useState<number>(lesson?.video_percent ?? 0)
  const [failed, setFailed] = useState(false)
  const st = useRef({ watched: [] as number[], bucket: 5, last: -1, dirty: false, sending: false, off: false, sentPos: lesson?.video_position ?? 0, done: !!lesson?.done })

  const send = async () => {
    const v = ref.current, s = st.current
    if (!track || !lesson || !v || s.sending || s.off || !Number.isFinite(v.duration)) return
    /* Something new watched, or the place moved: either is worth saving. */
    if (!s.dirty && Math.abs(v.currentTime - s.sentPos) < 2) return
    s.sending = true; s.dirty = false; s.sentPos = v.currentTime
    try {
      /* A plain fetch, not api.post: this is a background save nobody pressed
         (no "Saved" notice, no offline queue), and keepalive lets the last one
         out as the page closes. */
      const acting = actingInstitution()
      const res = await fetch(`/api/v1/portal/lms/lessons/${lesson.id}/video-progress`, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json', ...(acting ? { 'X-Acting-Institution': acting } : {}) },
        body: JSON.stringify({ position: v.currentTime, duration: v.duration, watched: s.watched.map((x) => (x ? '1' : '0')).join('') }),
      })
      if (res.status === 403 || res.status === 404) { s.off = true; return }
      if (!res.ok) { s.dirty = true; return }
      const r = await res.json() as { percent: number; done: boolean }
      setPercent(r.percent)
      if (r.done && !s.done) { s.done = true; onFinished?.() }
    } catch { s.dirty = true } finally { s.sending = false }
  }

  useEffect(() => {
    if (!track) return
    const t = window.setInterval(send, 15_000)
    const hide = () => { if (document.visibilityState === 'hidden') void send() }
    document.addEventListener('visibilitychange', hide)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', hide); void send() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, lesson?.id])

  const onMeta = async () => {
    const v = ref.current
    if (!v) return
    const s = st.current
    s.bucket = bucketFor(v.duration)
    const n = Math.ceil(v.duration / s.bucket)
    let saved = { position: lesson?.video_position ?? 0, watched: lesson?.video_watched ?? '', bucket_seconds: lesson?.video_bucket ?? null }
    if (track && lesson) {
      /* Read fresh: the course page may have been drawn from a cache. */
      try {
        const res = await fetch(`/api/v1/portal/lms/lessons/${lesson.id}/video-progress`, { credentials: 'same-origin' })
        if (res.ok) saved = await res.json()
      } catch { /* keep what the page had */ }
    }
    const w = saved.bucket_seconds === s.bucket ? saved.watched ?? '' : ''
    s.watched = Array.from({ length: n }, (_, i) => (w[i] === '1' ? 1 : 0))
    const pos = saved.position ?? 0
    s.sentPos = pos
    if (track && pos > 5 && pos < v.duration - 5 && v.currentTime < 1 && v.paused) { resumeAt.current = pos; v.currentTime = pos; setResumed(pos) }
    s.last = v.currentTime
  }
  const onTime = () => {
    const v = ref.current, s = st.current
    if (!v || !s.watched.length) return
    const t = v.currentTime
    if (!v.seeking && !v.paused && s.last >= 0 && t >= s.last && t - s.last <= 1.5 * Math.max(1, v.playbackRate)) {
      for (let i = Math.floor(s.last / s.bucket); i <= Math.min(s.watched.length - 1, Math.floor(t / s.bucket)); i++) {
        if (!s.watched[i]) { s.watched[i] = 1; s.dirty = true }
      }
    }
    s.last = t
  }

  /* NO SKIPPING AHEAD (owner, 2026-10-10: "remove skipping, continue where
     it left"). Until the video is finished, the child can go back but not
     forward past the first stretch they have not watched; a jump ahead is
     put back there. Once finished, they can move freely. */
  const allowed = () => {
    const s = st.current, v = ref.current
    if (!s.watched.length) return 0
    const gap = s.watched.indexOf(0)
    return gap < 0 ? (v?.duration ?? Infinity) : gap * s.bucket
  }
  const onSeeking = () => {
    const v = ref.current, s = st.current
    if (!v || !track || s.done) return
    const max = Math.max(allowed(), s.sentPos, s.last)
    if (v.currentTime > max + 1) { v.currentTime = max; setBlocked(true) }
  }
  const [blocked, setBlocked] = useState(false)

  /* Unfinished and the child's own: no seek bar (LockedFrame in YouTubeLesson.tsx). */
  /* Every student video is guarded against going forward (LockedFrame). */
  const locked = !!track
  const resumeAt = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  void percent

  if (!id) return null
  return (
    <div className="mx-auto w-full max-w-3xl space-y-2">
      <LockedFrame locked={locked} playing={playing} resume={resumeAt}
        time={() => ref.current?.currentTime ?? null} seek={(t) => { if (ref.current) ref.current.currentTime = t }}
        toggle={() => { const v = ref.current; if (!v) return; if (v.paused) void v.play(); else v.pause() }}
        back={() => { const v = ref.current; if (v) v.currentTime = Math.max(0, v.currentTime - 10) }}
        restart={() => { const v = ref.current; if (v) v.currentTime = 0 }}>
      <div className="overflow-hidden rounded-lg border bg-black shadow-sm">
        <video
          ref={ref}
          className="aspect-video w-full bg-black"
          src={`/api/v1/lms/videos/${id}/stream`}
          poster={lesson?.video_thumb ? `/api/v1/lms/videos/${id}/thumbnail` : undefined}
          controls={!locked}
          onPlay={() => setPlaying(true)}
          onPause={() => { setPlaying(false); void send() }}
          playsInline
          preload="metadata"
          controlsList="nodownload"
          onContextMenu={(e) => e.preventDefault()}
          onLoadedMetadata={onMeta}
          onTimeUpdate={onTime}
          onSeeking={onSeeking}
          onSeeked={() => { st.current.last = ref.current?.currentTime ?? -1 }}
          onEnded={() => void send()}
          onError={() => setFailed(true)}
          onRateChange={() => setSpeed(ref.current?.playbackRate ?? 1)}
        />
      </div>
      </LockedFrame>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="hidden text-muted-foreground sm:inline">Speed</span>
        <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="Playback speed">
          {SPEEDS.map((x) => (
            <button key={x} type="button" aria-pressed={speed === x}
              className={`min-h-10 min-w-11 px-2.5 text-[14px] sm:min-h-8 sm:min-w-0 sm:text-[13px] ${speed === x ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => { if (ref.current) ref.current.playbackRate = x; setSpeed(x) }}>{x}×</button>
          ))}
        </div>
        {track && (lesson?.done || st.current.done) && <span className="w-full text-muted-foreground sm:ml-auto sm:w-auto">Finished</span>}
      </div>
      {blocked && track && !st.current.done && <p className="text-[13px] text-muted-foreground">You can't skip ahead. Carry on from where you are, or go back.</p>}
      {resumed !== null && (
        <p className="text-[13px] text-muted-foreground">
          Resumed at {fmtDur(resumed)}.{' '}
          <button type="button" className="min-h-10 underline" onClick={() => { if (ref.current) { ref.current.currentTime = 0; st.current.last = 0 } setResumed(null) }}>Start from the beginning</button>
        </p>
      )}
      {failed && (
        <p className="text-[13px] text-destructive">
          This video will not play in this browser. It may be a .mov or HEVC (H.265) file, which some Android browsers cannot play. Try another browser, or ask your teacher for an mp4 (H.264) copy.
        </p>
      )}
    </div>
  )
}
