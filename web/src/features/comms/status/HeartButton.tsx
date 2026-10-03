import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Heart } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { StatusItem } from '@shared/api/feature_class_status'
import { FEED_KEY } from './status-api'

/* THE HEART ON A STATUS.

   A family watching the school's photos has, until now, had no way to say
   anything about one: the only acts available were to look and to close. A
   heart is the smallest answer that is still an answer, and it asks nothing
   of the school -- nobody is notified, there is no thread to read, and the
   poster sees a number rather than a list of names.

   The count moves the instant the button is pressed and the request follows,
   because a heart that waits for a round trip feels broken on a slow school
   connection. If the request fails the count goes back and nothing is said:
   this is the one control in the product where an error message would cost
   more attention than the act is worth.

   One row per person per post on the server, so pressing twice quickly
   cannot count twice however the taps interleave. */
export default function HeartButton({ post, dark }: { post: StatusItem; dark?: boolean }) {
  const qc = useQueryClient()
  const [liked, setLiked] = useState(!!post.liked)
  const [count, setCount] = useState(post.likes ?? 0)
  const [busy, setBusy] = useState(false)
  // A fresh feed is the truth; the local state is only ahead of it.
  useEffect(() => { setLiked(!!post.liked); setCount(post.likes ?? 0) }, [post.id, post.liked, post.likes])

  const press = async () => {
    if (busy) return
    const next = !liked
    setLiked(next); setCount((n) => Math.max(0, n + (next ? 1 : -1))); setBusy(true)
    try {
      const r = await api.post<{ liked: boolean; likes: number }>(`/api/v1/status/posts/${post.id}/like`, { liked: next })
      setLiked(r.liked); setCount(r.likes)
      void qc.invalidateQueries({ queryKey: FEED_KEY })
    } catch {
      setLiked(!next); setCount((n) => Math.max(0, n + (next ? -1 : 1)))
    } finally { setBusy(false) }
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void press() }}
      aria-pressed={liked}
      aria-label={liked ? 'Remove your heart' : 'Heart this'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-bold transition-colors',
        '[@media(pointer:coarse)]:min-h-[40px]',
        dark
          ? cn('text-white/85 hover:bg-white/15', liked && 'text-white')
          : cn('text-muted-foreground hover:bg-muted hover:text-foreground', liked && 'bg-primary/10 text-primary'),
      )}
    >
      <Heart
        aria-hidden="true"
        className={cn('size-[18px] transition-transform duration-200', liked && 'scale-110 fill-current')}
      />
      <span className="tabular-nums">{count}</span>
    </button>
  )
}
