import { useEffect, useRef, useState } from 'react'
import { actingInstitution } from '@/lib/api'
import { ChevronLeft, ExternalLink, Maximize, Pause, Play, RotateCcw, Undo2 } from 'lucide-react'

/* A YOUTUBE VIDEO OR PLAYLIST, EMBEDDED THE WAY YOUTUBE ASKS FOR.
 *
 * The whole compliance story of this feature is in this file, so it is
 * written down here rather than spread across the screens that use it.
 *
 * EMBED, NEVER COPY. This renders YouTube's own iframe against YouTube's own
 * domain. Nothing is downloaded, re-hosted, proxied or stripped: the moment a
 * school serves somebody else's video from its own origin it is no longer
 * embedding it, and that is what takedowns are made of. If the uploader
 * disabled embedding the player says so itself and the "Watch on YouTube"
 * link below is the way through -- we do not route around that signal.
 *
 * youtube-nocookie.com, NOT youtube.com. The privacy-enhanced host does not
 * set its advertising cookies until something is played. This product is used
 * by children, and under the DPDP Act a school quietly handing an ad network
 * a profile of a nine-year-old is the exact thing nobody wants to explain.
 *
 * NO AUTOPLAY, NO HIDDEN CONTROLS, NO BRANDING REMOVED, NOTHING DRAWN OVER
 * THE PLAYER. Those are YouTube's terms, and three of them are also simply
 * right for a classroom. rel=0 keeps the end-screen suggestions to the same
 * channel instead of offering a child the open internet.
 *
 * ATTRIBUTION STAYS ON THE PAGE. The channel's name, when the teacher
 * recorded it, and a link back to the video on YouTube. A viewer can always
 * get to the source.
 *
 * THE IFRAME API IS LOADED FROM YOUTUBE, which is both the only way to read
 * the playhead for a timestamped note and the sanctioned way to do it. It is
 * loaded once per page and only when a lesson actually needs it.
 */

/** YouTube's player, as much of it as this file uses. */
interface YTPlayer {
  getCurrentTime(): number
  getDuration?(): number
  getPlayerState?(): number
  getPlaybackRate?(): number
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo?(): void
  pauseVideo?(): void
  destroy?(): void
  getIframe?(): HTMLIFrameElement
}
interface YTApi {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer
}
declare global {
  interface Window {
    YT?: YTApi
    onYouTubeIframeAPIReady?: () => void
  }
}

/* One loader for the page, however many lessons ask for it. A second <script>
   tag would re-run the API and orphan the players made by the first. */
let apiPromise: Promise<YTApi> | null = null
function loadApi(): Promise<YTApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (apiPromise) return apiPromise
  apiPromise = new Promise<YTApi>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prev?.()
      if (window.YT?.Player) resolve(window.YT)
      else reject(new Error('the YouTube player did not load'))
    }
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.async = true
    s.onerror = () => reject(new Error('the YouTube player could not be reached'))
    document.head.appendChild(s)
    /* A school behind a filter that blocks YouTube would otherwise hang on a
       promise for ever; the lesson falls back to a plain link. */
    window.setTimeout(() => reject(new Error('the YouTube player did not load')), 12_000)
  })
  return apiPromise
}

/* THE DISCLAIMER, ONCE (owner, 2026-10-10: "let them agree that they are
   watching yt vd ... let them accept that before watching vd and only show
   for the first time and make it a disclamer").

   A child opening a lesson should know whose video they are about to play
   and whose player is about to run. The school is not the publisher here,
   and saying so once -- plainly, before the first frame -- is both fair to
   the family and the thing that answers a complaint later.

   WHY NOTHING LOADS UNTIL THEY AGREE. The point is not the wording, it is
   that the iframe is not created yet. Until the button is pressed no
   request has gone to YouTube at all: no player script, no embed, nothing
   for anyone to log. An agreement that appears over a video already
   playing agrees to something that has happened.

   REMEMBERED PER DEVICE, in localStorage. A disclaimer is a notice, not a
   consent record the school must produce later, so it does not need a row
   in the database; if it ever does, this is the one place to change. Every
   read and write is wrapped, because a private window or blocked site data
   throws rather than returning empty -- and when it does, the notice simply
   shows again, which is the safe way to fail.

   The teacher's own preview is not a child and is not asked. */
const SEEN_KEY = 'erp.ytNoticeSeen'
function noticeSeen(): boolean {
  try { return window.localStorage.getItem(SEEN_KEY) === '1' } catch { return false }
}
function rememberNotice(): void {
  try { window.localStorage.setItem(SEEN_KEY, '1') } catch { /* shown again next time, which is fine */ }
}

/** mm:ss, or h:mm:ss past an hour. */
export function stamp(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0')
}

/** Where to watch it on YouTube itself. */
export function watchUrl(videoId?: string | null, listId?: string | null): string {
  if (videoId && listId) return `https://www.youtube.com/watch?v=${videoId}&list=${listId}`
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`
  return `https://www.youtube.com/playlist?list=${listId ?? ''}`
}

/* NO WAY FORWARD UNTIL IT IS WATCHED (owner, 2026-10-10: "no forwarding
   the video but they can go backward, and don't show how much is done while
   it plays"). A child's unfinished video has no seek bar at all -- the
   player's own controls are off -- and these buttons instead: play/pause,
   back 10 seconds, start again, full screen. Nothing here moves forward. Once
   the video is finished the ordinary controls come back. */
export function LockedFrame({ locked, playing, toggle, back, restart, children }: { locked: boolean; playing: boolean; toggle: () => void; back: () => void; restart: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  /* Full screen is the browser's where it can be had, and where it cannot
     (an iPhone will not put a page element full screen; some Android
     browsers refuse inside an app) the frame covers the screen itself. */
  const [full, setFull] = useState<'real' | 'fake' | null>(null)
  const [hint, setHint] = useState(false)
  const fns = useRef({ toggle, back, restart })
  fns.current = { toggle, back, restart }
  const exit = () => {
    try { (screen.orientation as { unlock?: () => void } | undefined)?.unlock?.() } catch { /* fine */ }
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {})
    setFull(null)
  }
  const enter = () => {
    const el = box.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null
    const landscape = () => { try { void (screen.orientation as { lock?: (o: string) => Promise<void> } | undefined)?.lock?.('landscape')?.catch(() => {}) } catch { /* fine */ } }
    if (el?.requestFullscreen) {
      el.requestFullscreen().then(() => { setFull('real'); landscape() }).catch(() => setFull('fake'))
    } else if (el?.webkitRequestFullscreen) {
      try { el.webkitRequestFullscreen(); setFull('real'); landscape() } catch { setFull('fake') }
    } else setFull('fake')
  }
  const fullRef = useRef(full)
  fullRef.current = full
  useEffect(() => {
    /* Leaving the browser's full screen (Esc, the phone's back) ends ours. */
    const on = () => { if (!document.fullscreenElement && fullRef.current === 'real') setFull(null) }
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  /* THE KEYBOARD SAYS THE SAME AS THE BUTTONS: space or K plays and pauses,
     left or J goes back 10 seconds, Home or 0 starts again, F is full screen,
     Esc leaves it. Right, L and End are swallowed: nothing goes forward. */
  useEffect(() => {
    if (!locked) return
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'escape') { if (fullRef.current === 'fake') setFull(null); return }
      const act: Record<string, () => void> = {
        ' ': () => fns.current.toggle(), k: () => fns.current.toggle(),
        arrowleft: () => fns.current.back(), j: () => fns.current.back(),
        home: () => fns.current.restart(), '0': () => fns.current.restart(),
        f: () => (fullRef.current ? exit() : enter()), arrowright: () => {}, l: () => {}, end: () => {},
      }
      if (!act[k]) return
      if (t && t.tagName === 'BUTTON' && k === ' ') return // a focused button presses itself
      e.preventDefault(); act[k]()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked])
  /* A TAP PLAYS OR PAUSES; TWO QUICK TAPS GO BACK 10 SECONDS, as phone
     players do. The single tap waits a moment to be sure it was not the
     first of two. */
  const tap = useRef<{ at: number; timer: number }>({ at: 0, timer: 0 })
  const onTap = () => {
    const now = Date.now(), t = tap.current
    if (now - t.at < 300) {
      window.clearTimeout(t.timer); t.at = 0
      fns.current.back(); setHint(true); window.setTimeout(() => setHint(false), 700)
      return
    }
    t.at = now
    t.timer = window.setTimeout(() => fns.current.toggle(), 260)
  }
  if (!locked) return <>{children}</>
  const b = 'inline-flex min-h-11 items-center gap-1.5 rounded-md border bg-background px-3 text-[14px] font-medium text-foreground hover:bg-muted'
  return (
    <div ref={box} className={full ? 'fixed inset-0 z-[1000] flex items-center justify-center bg-black' : 'space-y-2'}>
      <div className="relative w-full" style={full ? { width: 'min(100vw, calc(100dvh * 16 / 9))' } : undefined}>
        {children}
        {/* Over the player: taps come here, and the player itself never takes
            focus, so its own controls and keys never see a press. */}
        <button type="button" aria-label={playing ? 'Pause (double tap: back 10 seconds)' : 'Play (double tap: back 10 seconds)'} tabIndex={-1} onClick={onTap}
          className="absolute inset-0 h-full w-full cursor-pointer touch-manipulation bg-transparent [-webkit-tap-highlight-color:transparent]" />
        {hint && <span aria-hidden className="pointer-events-none absolute left-1/4 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/60 px-3 py-2 text-[14px] font-semibold text-white"><Undo2 className="mr-1 inline size-4" />10s</span>}
      </div>
      {/* In full screen: the way back out, and nothing else. */}
      {full && (
        <button type="button" onClick={exit} aria-label="Exit full screen"
          className="absolute left-3 top-3 z-10 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-black/60 px-4 text-[15px] font-medium text-white">
          <ChevronLeft className="size-5" aria-hidden /> Back
        </button>
      )}
      {!full && (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-2 sm:justify-start">
          <button type="button" className={b} onClick={toggle}>{playing ? <><Pause className="size-4" aria-hidden /> Pause</> : <><Play className="size-4" aria-hidden /> Play</>}</button>
          <button type="button" className={b} onClick={back}><Undo2 className="size-4" aria-hidden /> Back 10s</button>
          <button type="button" className={b} onClick={restart}><RotateCcw className="size-4" aria-hidden /> Start again</button>
          <button type="button" className={b} onClick={enter}><Maximize className="size-4" aria-hidden /> Full screen</button>
        </div>
      )}
    </div>
  )
}

export function YouTubeLesson({
  videoId,
  listId,
  channel,
  title,
  onPlayer,
  track,
}: {
  videoId?: string | null
  listId?: string | null
  channel?: string | null
  title?: string
  /** Handed the player once it exists, so a notes panel can read the clock. */
  onPlayer?: (p: YTPlayer | null) => void
  /** The child's own lesson: track what is played and report it when the whole video has been. */
  track?: { lessonId: string; done: boolean; onFinished?: () => void }
}) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /* Read once, on mount: a child who agreed last week never sees it again,
     and one who has not gets the notice instead of the player. */
  const [agreed, setAgreed] = useState(() => noticeSeen())
  const cb = useRef(onPlayer)
  cb.current = onPlayer
  const [percent, setPercent] = useState<number | null>(null)
  const [skipped, setSkipped] = useState(false)
  /* Locked: the child's own lesson, not yet finished (see LockedFrame). */
  const locked = !!track && !track.done
  const [playing, setPlaying] = useState(false)
  const pl = useRef<YTPlayer | null>(null)
  void percent; void skipped
  const tr = useRef(track)
  tr.current = track

  /* THE END OF THE VIDEO HAS TO BE HEARD (tester, 2026-10-10: played a video
     to its end, "player went black", nothing ticked).

     The player was given no events at all, so the only thing that ever
     reported was the once-a-second loop, and it reports only when the whole
     map is in. Reaching the end -- the single moment that matters, and the
     one the child is waiting on -- went unnoticed. Now the reporter is held
     here so the ENDED state can call it the instant it arrives. */
  const report = useRef<(() => void) | null>(null)

  useEffect(() => {
    let dead = false
    let player: YTPlayer | null = null
    const el = host.current
    /* Not before they agree: no script, no iframe, no request to YouTube. */
    if (!agreed || !el || (!videoId && !listId)) return
    loadApi().then((YT) => {
      if (dead || !host.current) return
      player = new YT.Player(host.current, {
        /* The nocookie host, and the origin so the API's postMessage channel
           is not open to any page. */
        host: 'https://www.youtube-nocookie.com',
        videoId: videoId ?? undefined,
        playerVars: {
          autoplay: 0,          // never, least of all for a child
          controls: locked ? 0 : 1, // none while it must be watched through: no seek bar to drag
          disablekb: locked ? 1 : 0, // nor the arrow keys
          modestbranding: 1,
          rel: 0,               // end screen stays on the same channel
          playsinline: 1,
          origin: window.location.origin,
          /* "Error 153: video player configuration error" is YouTube refusing
             an embed it cannot attribute to a site (owner, 2026-10-10). Say
             which page it is on, and make sure the iframe sends our origin. */
          widget_referrer: window.location.href,
          ...(listId ? { list: listId, listType: 'playlist' } : {}),
        },
        events: {
          /* 0 is ENDED. Reported at once rather than waiting for the next
             tick of the loop, which on the last frame may never come: the
             video has stopped, so nothing moves forward to mark. */
          onStateChange: (e: { data: number }) => { setPlaying(e.data === 1); if (e.data === 0) report.current?.() },
        },
      })
      try {
        const f = player.getIframe?.() ?? host.current?.querySelector('iframe') ?? null
        if (f) f.referrerPolicy = 'strict-origin-when-cross-origin'
      } catch { /* the player still works without it */ }
      cb.current?.(player)
      pl.current = player
      if (tr.current && !tr.current.done) watch(player)
    }).catch((e: Error) => { if (!dead) setFailed(e.message) })
    /* WATCHED TO THE END, STRETCH BY STRETCH. Once a second, while it plays,
       the stretch between the last reading and this one is marked played --
       only when it moved forward by about a second's worth, so a jump ahead
       marks nothing. Kept in this browser between visits; sent when every
       stretch is in, and the server decides. */
    let timer = 0
    function watch(p: YTPlayer) {
      const key = `yt-watched:${tr.current!.lessonId}`
      let map: number[] = [], bucket = 5, last = -1, sending = false, finished = false, resumed = false
      const posKey = `yt-pos:${tr.current!.lessonId}`
      const send = async (dur: number) => {
        if (sending || finished) return
        sending = true
        try {
          const acting = actingInstitution()
          const res = await fetch(`/api/v1/portal/lms/lessons/${tr.current!.lessonId}/youtube-watched`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(acting ? { 'X-Acting-Institution': acting } : {}) },
            body: JSON.stringify({ duration: dur, watched: map.map((x) => (x ? '1' : '0')).join('') }),
          })
          if (!res.ok) return
          const r = await res.json() as { done: boolean }
          if (r.done) { finished = true; window.clearInterval(timer); tr.current?.onFinished?.() }
        } catch { /* tried again on the next tick */ } finally { sending = false }
      }
      /* Asked for by the ENDED event. The last stretches are marked here:
         the video stopped on them, which is the strongest evidence there is
         that they were watched, and the loop cannot mark them because
         marking needs the clock to move and it has stopped. */
      report.current = () => {
        const dur = p.getDuration?.() ?? 0
        if (!(dur > 0) || !map.length) return
        for (let i = Math.max(0, map.length - 3); i < map.length; i++) map[i] = 1
        try { localStorage.setItem(key, map.map((x) => (x ? '1' : '0')).join('')) } catch { /* fine */ }
        setPercent(Math.round((100 * map.filter(Boolean).length) / map.length))
        /* Done with it: next time it is opened it starts at the beginning. */
        try { localStorage.removeItem(posKey) } catch { /* fine */ }
        void send(dur)
      }
      timer = window.setInterval(() => {
        if (dead) return
        const dur = p.getDuration?.() ?? 0
        if (!(dur > 0)) return
        if (!map.length) {
          bucket = Math.max(5, Math.ceil(dur / 2000))
          let saved = ''
          try { saved = localStorage.getItem(key) ?? '' } catch { /* private window */ }
          map = Array.from({ length: Math.ceil(dur / bucket) }, (_, i) => (saved[i] === '1' ? 1 : 0))
        }
        /* Continue where it was left: the place saved in this browser. */
        if (!resumed) {
          resumed = true
          let pos = 0
          try { pos = Number(localStorage.getItem(posKey) ?? 0) } catch { /* fine */ }
          if (pos > 5 && pos < dur - 5) { p.seekTo(pos, true); last = -1; return }
        }
        let t = p.getCurrentTime()
        const playing = p.getPlayerState?.() === 1, rate = p.getPlaybackRate?.() ?? 1
        /* No skipping ahead: a jump past the first stretch not yet watched
           (and past where they were) is put back there. Back is always fine. */
        const gap = map.indexOf(0)
        const max = Math.max(gap < 0 ? dur : gap * bucket, last)
        if (t > max + 2) { p.seekTo(max, true); setSkipped(true); t = max; last = -1; return }
        try { if (t > 0) localStorage.setItem(posKey, String(Math.floor(t))) } catch { /* fine */ }
        if (playing && last >= 0 && t >= last && t - last <= 1.6 * Math.max(1, rate)) {
          let changed = false
          for (let i = Math.floor(last / bucket); i <= Math.min(map.length - 1, Math.floor(t / bucket)); i++) if (!map[i]) { map[i] = 1; changed = true }
          if (changed) {
            try { localStorage.setItem(key, map.map((x) => (x ? '1' : '0')).join('')) } catch { /* fine */ }
            setPercent(Math.round((100 * map.filter(Boolean).length) / map.length))
          }
        }
        last = playing ? t : -1
        if (map.length && !map.slice(0, -1).includes(0)) void send(dur)
      }, 1000)
    }
    return () => {
      dead = true
      report.current = null
      window.clearInterval(timer)
      cb.current?.(null)
      try { player?.destroy?.() } catch { /* the iframe is going anyway */ }
    }
  }, [videoId, listId, agreed])

  const href = watchUrl(videoId, listId)

  return (
    <div className="space-y-2">
      {failed ? (
        /* A blocked or missing player is a link, not a dead rectangle. A
           school network that filters YouTube is common enough that this is
           an ordinary state rather than an error. */
        <div className="rounded-[14px] border bg-muted/40 p-4">
          <p className="text-[14px]">{failed}.</p>
          {!track && <a href={href} target="_blank" rel="noreferrer"
             className="mt-1 inline-flex items-center gap-1.5 text-[14px] font-medium text-primary underline">
            Watch it on YouTube <ExternalLink className="size-3.5" />
          </a>}
        </div>
      ) : !agreed ? (
        <div className="rounded-[14px] border bg-muted/30 p-4" style={{ minHeight: 180 }}>
          <h3 className="text-[15px] font-semibold">This video is on YouTube</h3>
          <p className="mt-1.5 max-w-prose text-[13.5px] text-muted-foreground">
            Your school did not make it and does not host it. Pressing play loads YouTube’s own
            player, and from then on YouTube can see that the video was watched, the same as
            opening it on their site. Your notes stay here and are private to you.
          </p>
          <button
            type="button"
            onClick={() => { rememberNotice(); setAgreed(true) }}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground"
          >
            I understand — play the video
          </button>
          <p className="mt-2 text-[12px] text-muted-foreground">Shown once. You will not be asked again.</p>
        </div>
      ) : (
        <LockedFrame locked={locked} playing={playing}
          toggle={() => { const p = pl.current; if (!p) return; if (playing) p.pauseVideo?.(); else p.playVideo?.() }}
          back={() => { const p = pl.current; if (p) p.seekTo(Math.max(0, p.getCurrentTime() - 10), true) }}
          restart={() => { const p = pl.current; if (p) p.seekTo(0, true) }}>
          <div className="overflow-hidden rounded-[14px] border bg-black">
            {/* 16:9, and max-w-full so it never pushes a phone sideways. */}
            <div className="relative w-full max-w-full" style={{ aspectRatio: '16 / 9' }}>
              <div ref={host} className="absolute inset-0 h-full w-full" />
            </div>
          </div>
        </LockedFrame>
      )}
      {/* Attribution and the way out to the source -- for staff only. A student
          sees the video and nothing that leads off to YouTube (owner, 2026-10-10). */}
      {!track && <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
        {channel ? <span>On YouTube by <span className="font-medium text-foreground">{channel}</span></span> : <span>Hosted on YouTube</span>}
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
          {listId && !videoId ? 'Open the playlist' : 'Watch on YouTube'} <ExternalLink className="size-3" />
        </a>
        {title ? <span className="sr-only">{title}</span> : null}
      </p>}
    </div>
  )
}

export type { YTPlayer }
