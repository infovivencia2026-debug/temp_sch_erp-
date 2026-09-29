/* Reference data kept in memory, per school, per isolate.

   Classes, sections, subjects, academic years and the working year are read
   on most requests and change a few times a term. Each school database has a
   version number (ref_versions, tenant migration 0015) that triggers bump on
   ANY write to classes, sections, subjects, academic_years or
   user_working_years, whoever makes it. A cached value is served while the
   version it was loaded under is still the school's version.

   Checking the version is itself a read, so it is trusted for REF_TTL_MS
   before it is read again. Within this isolate a write request drops the
   school's entry at once (tenant.ts calls invalidateRef after any
   non-GET), so the writer always reads its own change; another isolate may
   serve the old value for at most REF_TTL_MS.

   The handle must come from tenantDb (tenant.ts), which tags it with the
   school's id; an untagged handle is never cached. */

export const SCHOOL = Symbol.for('erp.school')

interface Entry { version: number; checkedAt: number; data: Map<string, unknown> }

const entries = new Map<string, Entry>()
let ttlMs = 10_000

/** Test hook: how long a read version is trusted (0 re-reads it every call). */
export function setRefTtl(ms: number): void { ttlMs = ms }
export const refTtl = () => ttlMs

/** The school id tenantDb stamped on this handle, or null. */
export function schoolOf(db: D1Database | D1DatabaseSession): string | null {
  return (db as unknown as Record<symbol, string | undefined>)[SCHOOL] ?? null
}

/** Forget a school's cached reference data in this isolate. */
export function invalidateRef(school: string): void { entries.delete(school) }

async function readVersion(db: D1Database | D1DatabaseSession): Promise<number | null> {
  try {
    const r = await db.prepare(`SELECT version FROM ref_versions WHERE key = 'ref'`).first<{ version: number }>()
    return r ? Number(r.version) : null
  } catch { return null } // before migration 0015: no caching
}

async function entryFor(db: D1Database | D1DatabaseSession, school: string): Promise<Entry | null> {
  const now = Date.now()
  const e = entries.get(school)
  if (e && now - e.checkedAt < ttlMs) return e
  const v = await readVersion(db)
  if (v === null) return null
  if (e && e.version === v) { e.checkedAt = now; return e }
  const fresh: Entry = { version: v, checkedAt: now, data: new Map() }
  entries.set(school, fresh)
  return fresh
}

/** `load()` once per school per reference-data version. */
export async function cachedRef<T>(db: D1Database | D1DatabaseSession, key: string, load: () => Promise<T>): Promise<T> {
  const school = schoolOf(db)
  if (!school) return load()
  const e = await entryFor(db, school)
  if (!e) return load()
  if (e.data.has(key)) return e.data.get(key) as T
  const v = await load()
  // Only keep it if nobody replaced the entry meanwhile (a write in this isolate).
  if (entries.get(school) === e) e.data.set(key, v)
  return v
}

export interface YearRow { id: string; name: string; starts_on: string; ends_on: string; is_current: number; closed_at: string | null }

/** Every academic year, newest first. */
export function academicYears(db: D1Database | D1DatabaseSession): Promise<YearRow[]> {
  return cachedRef(db, 'years', async () => (await db.prepare(
    `SELECT id, name, starts_on, ends_on, is_current, closed_at FROM academic_years ORDER BY is_current DESC, starts_on DESC`).all<YearRow>()).results ?? [])
}

/** The school's current year, else its latest: the working year when the person has not chosen one. */
export async function defaultYearId(db: D1Database | D1DatabaseSession): Promise<string | null> {
  return (await academicYears(db))[0]?.id ?? null
}

/** Whether this id is one of the school's academic years. */
export async function yearExists(db: D1Database | D1DatabaseSession, id: string): Promise<boolean> {
  return (await academicYears(db)).some((y) => y.id === id)
}

/** The year the person chose (user_working_years), else null. */
export async function chosenYearId(db: D1Database | D1DatabaseSession, userId: string): Promise<string | null> {
  const all = await cachedRef(db, 'chosen', async () => {
    const r = await db.prepare(`SELECT w.user_id, y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id`)
      .all<{ user_id: string; id: string }>()
    return new Map((r.results ?? []).map((x) => [x.user_id, x.id]))
  })
  return all.get(userId) ?? null
}

/** The whole working-year chain: explicit (already checked by the caller) aside, chosen, else current/latest. */
export async function workingYearFor(db: D1Database | D1DatabaseSession, userId: string): Promise<string | null> {
  return (await chosenYearId(db, userId)) ?? (await defaultYearId(db))
}

/** /ref-data's lists. */
export function refLists(db: D1Database | D1DatabaseSession) {
  return cachedRef(db, 'ref-data', async () => {
    const [classes, sections, subjects] = await db.batch<Record<string, unknown>>([
      db.prepare(`SELECT id, name, level, stream FROM classes ORDER BY level, name`),
      db.prepare(`SELECT sec.id, sec.class_id, c.name AS class_name, sec.academic_year_id, sec.name, sec.capacity, sec.room
          FROM sections sec JOIN classes c ON c.id = sec.class_id ORDER BY c.level, sec.name`),
      db.prepare(`SELECT id, name, code, is_scholastic FROM subjects ORDER BY name`),
    ])
    return { classes: classes.results, sections: sections.results, subjects: subjects.results }
  })
}

