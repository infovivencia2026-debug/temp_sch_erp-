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
