import { isQuietTable } from '../../shared/live-areas'

/* WHAT CHANGED, FOR EVERYBODY ELSE'S SCREEN (Yajur, 2026-10-27: "It should
   never repeat again in anything like this").

   index.ts calls recordLiveChange after every successful write request with
   the tables its statements wrote (idcache.ts watchAuthWrites), so no route
   has to remember to announce itself. Each table gets the next school-wide
   sequence number; /portal/live (routes/portal/school_life.ts) hands a
   client the tables changed since the number it last saw, and the web
   (lib/live.ts, shared/live-areas.ts) refetches the screens showing them. */

/** Notes the tables a request wrote. Never fails the request: a miss costs one poll's freshness. */
export async function recordLiveChange(db: D1Database, tables: string[]): Promise<void> {
  const loud = [...new Set(tables)].filter((t) => !isQuietTable(t))
  if (loud.length === 0) return
  try {
    await db.prepare(`INSERT INTO live_changes (tbl, seq, at)
        SELECT value, (SELECT COALESCE(max(seq), 0) + 1 FROM live_changes), ?2 FROM json_each(?1) WHERE true
        ON CONFLICT(tbl) DO UPDATE SET seq = excluded.seq, at = excluded.at`)
      .bind(JSON.stringify(loud), new Date().toISOString()).run()
  } catch {
    /* A school database not yet migrated (0120): the poll's other parts still work. */
  }
}

/** The newest sequence number, and the tables changed after `since` (null: too many, or no `since`: refetch all). */
export async function liveChangesSince(db: D1Database, since: string | null): Promise<{ seq: string; tables: string[] | null }> {
  try {
    const top = await db.prepare(`SELECT COALESCE(max(seq), 0) AS seq FROM live_changes`).first<{ seq: number }>()
    const seq = String(top?.seq ?? 0)
    const from = since !== null && /^\d+$/.test(since) ? Number(since) : null
    if (from === null) return { seq, tables: null }
    const rows = await db.prepare(`SELECT tbl FROM live_changes WHERE seq > ? ORDER BY seq DESC LIMIT 201`).bind(from).all<{ tbl: string }>()
    const names = rows.results.map((r) => r.tbl)
    return { seq, tables: names.length > 200 ? null : names }
  } catch {
    return { seq: '', tables: [] }
  }
}
