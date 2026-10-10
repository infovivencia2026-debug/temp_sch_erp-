import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'

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
  seekTo(seconds: number, allowSeekAhead: boolean): void
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

export function YouTubeLesson({
  videoId,
  listId,
  channel,
  title,
  onPlayer,
}: {
  videoId?: string | null
  listId?: string | null
  channel?: string | null
  title?: string
  /** Handed the player once it exists, so a notes panel can read the clock. */
  onPlayer?: (p: YTPlayer | null) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const cb = useRef(onPlayer)
  cb.current = onPlayer

  useEffect(() => {
    let dead = false
    let player: YTPlayer | null = null
    const el = host.current
    if (!el || (!videoId && !listId)) return
    loadApi().then((YT) => {
      if (dead || !host.current) return
      player = new YT.Player(host.current, {
        /* The nocookie host, and the origin so the API's postMessage channel
           is not open to any page. */
        host: 'https://www.youtube-nocookie.com',
        videoId: videoId ?? undefined,
        playerVars: {
          autoplay: 0,          // never, least of all for a child
          controls: 1,          // theirs, not ours
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
      })
      try {
        const f = player.getIframe?.() ?? host.current?.querySelector('iframe') ?? null
        if (f) f.referrerPolicy = 'strict-origin-when-cross-origin'
      } catch { /* the player still works without it */ }
      cb.current?.(player)
    }).catch((e: Error) => { if (!dead) setFailed(e.message) })
    return () => {
      dead = true
      cb.current?.(null)
      try { player?.destroy?.() } catch { /* the iframe is going anyway */ }
    }
  }, [videoId, listId])

  const href = watchUrl(videoId, listId)

  return (
    <div className="space-y-2">
      {failed ? (
        /* A blocked or missing player is a link, not a dead rectangle. A
           school network that filters YouTube is common enough that this is
           an ordinary state rather than an error. */
        <div className="rounded-[14px] border bg-muted/40 p-4">
          <p className="text-[14px]">{failed}.</p>
          <a href={href} target="_blank" rel="noreferrer"
             className="mt-1 inline-flex items-center gap-1.5 text-[14px] font-medium text-primary underline">
            Watch it on YouTube <ExternalLink className="size-3.5" />
          </a>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border bg-black">
          {/* 16:9, and max-w-full so it never pushes a phone sideways. */}
          <div className="relative w-full max-w-full" style={{ aspectRatio: '16 / 9' }}>
            <div ref={host} className="absolute inset-0 h-full w-full" />
          </div>
        </div>
      )}
      {/* Attribution and the way out to the source, always on the page. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
        {channel ? <span>On YouTube by <span className="font-medium text-foreground">{channel}</span></span> : <span>Hosted on YouTube</span>}
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
          {listId && !videoId ? 'Open the playlist' : 'Watch on YouTube'} <ExternalLink className="size-3" />
        </a>
        {title ? <span className="sr-only">{title}</span> : null}
      </p>
    </div>
  )
}

export type { YTPlayer }
