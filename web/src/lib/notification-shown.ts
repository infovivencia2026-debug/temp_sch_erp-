/* WHICH BELL ROWS ARE SHOWN (Yajur, 2026-10-21). One rule for the bell drawer
   and the teacher home panel, so both list the same set:
   - a status entry shows only while the post it points at is still in the
     status feed (live within 24h, or pinned to the gallery); once the feed has
     loaded, an entry for a post no longer there is gone;
   - everything else the server sent shows (it already drops what is done). */

export interface ShownNote { kind: string; link?: string; pending?: boolean }

/** The post a status notification is about: its link is "/?status=<id>". */
export function statusPostIdOf(n: ShownNote): string | null {
  if (n.kind !== 'status' || !n.link) return null
  const m = /[?&]status=([0-9a-f-]{36})/i.exec(n.link)
  return m ? m[1].toLowerCase() : null
}

/** `livePosts` is null until the status feed has loaded (then nothing is hidden). */
export function noteShown(n: ShownNote, livePosts: ReadonlySet<string> | null): boolean {
  if (n.kind !== 'status' || !livePosts) return true
  const id = statusPostIdOf(n)
  return id === null || livePosts.has(id)
}

/** Work owed stays until done and leads the list. */
export function pendingFirst<T extends ShownNote>(items: T[]): T[] {
  return [...items].sort((a, b) => Number(!!b.pending) - Number(!!a.pending))
}

/* VIEWED IS GONE AT ONCE (Yajur, 2026-10-24: "after a notification is clicked
   or the work is done, it should be gone immediately"). The cached feed after
   one row is opened: an ordinary row leaves the list; work owed stays, read,
   until the work is done (the server keeps it the same way). */
export interface FeedNote extends ShownNote { id: string; read_at?: string }
export function dropFromFeed<T extends FeedNote>(
  feed: { items?: T[]; unread?: number } | undefined, id: string, at = new Date().toISOString(),
): { items?: T[]; unread?: number } | undefined {
  if (!feed) return feed
  const items = feed.items ?? []
  const hit = items.find((n) => n.id === id)
  if (!hit) return feed
  const unread = hit.read_at ? feed.unread : Math.max(0, (feed.unread ?? 0) - 1)
  return {
    ...feed,
    unread,
    items: hit.pending ? items.map((n) => (n.id === id ? { ...n, read_at: n.read_at ?? at } : n)) : items.filter((n) => n.id !== id),
  }
}
