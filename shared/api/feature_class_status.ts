/* Class Status: a photo or a short video posted to a section, a class, the
   school or the staff, seen for 24 hours unless pinned to the class gallery.
   The feed is typed; the rest of /status is plain JSON (worker/src/routes/comms/class_status.ts). */

export interface StatusItem {
  id: string
  /** 'text': words alone (the caption) on the school's colour; no media. */
  media_kind: 'photo' | 'video' | 'text'
  content_type: string
  caption?: string
  published_at: string
  expires_at: string
  pinned: boolean
  seen: boolean
  mine: boolean
  /** "Class 5 A", "Whole school", ... */
  audience: string
  duration_seconds?: number
  /** The auth-checked media route; empty for a text status. */
  url: string
  /** The auth-checked ~320px thumbnail, when the poster's browser drew one. */
  thumb?: string
  /** How wide it went, without naming the list: everyone sees this. */
  scope: 'school' | 'staff' | 'class'
  /** For a family: which of their children it was for (student ids). */
  for_kids?: string[]
  /** How many people have hearted it. */
  likes: number
  /** Whether the person this feed was built for is one of them. */
  liked: boolean
  /** Where to report this post seen: signed for the person the feed was built for. Add `&last=1` on the last unseen post of a ring. */
  seen_url?: string
}

export interface StatusRing {
  /** 'school', or the poster's user id. */
  key: string
  as_school: boolean
  poster_id: string
  /** Empty for the school's ring: the client shows the school's own name and logo. */
  name: string
  avatar_key?: string
  mine: boolean
  unseen: number
  latest_at: string
  posts: StatusItem[]
}

export interface StatusFeed {
  enabled: boolean
  can_post: boolean
  can_post_school: boolean
  unseen: number
  rings: StatusRing[]
  /** Pinned posts past their 24 hours: the class gallery. */
  gallery: StatusItem[]
  allow_video: boolean
  max_video_seconds: number
  /** Only when the school's 5 GB of media is nearly full (90%+); otherwise absent. */
  storage_warning?: string
}

export interface ClassStatusApi {
  'GET /status/feed': { res: StatusFeed }
}
