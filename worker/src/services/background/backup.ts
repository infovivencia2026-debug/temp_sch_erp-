import type { Env } from '../../env'
import { enqueueMany, registerJob, SkipRetry } from '../jobs'
import { institutionById, tenantDb, type Institution } from '../../tenant'
import { zipStored } from '../xlsx'

/* Nightly backups, school exports and their retention.

   backup:fanout (cron, nightly) queues one backup:database per school plus
   one for CONTROL. backup:database dumps that D1 database as SQL text
   (the CREATE statements from sqlite_master, then one INSERT per row, read
   in pages), gzips it with CompressionStream and streams it to R2 as a
   multipart upload at backups/<slug>/<YYYY-MM-DD>.sql.gz (CONTROL is
   backups/_control/...). Each run is a row in CONTROL.backups. After a
   success the school's older dumps are pruned: every day of the last 30 is
   kept, then the first dump of each month for 12 months.

   A dump restores with:
     gunzip -c <file>.sql.gz > dump.sql
     npx wrangler d1 execute <new-database> --remote --file=dump.sql
   Point-in-time restore of the live database is D1 Time Travel instead
   (src/routes/seller/lifecycle.ts); these dumps are the copy that survives
   the database itself being deleted.

   export:school builds the off-boarding / "give us our data" ZIP: every
   table as CSV plus files.csv, the manifest of the school's R2 objects. */

export const DAILY_KEEP = 30
export const MONTHLY_KEEP = 12
export const EXPORT_TTL_DAYS = 7
const PAGE = 500
const PART = 8 << 20 // R2 multipart parts must be >= 5 MiB except the last

/** Where dumps and exports live: a BACKUPS bucket when bound, else the write bucket. */
export function backupBucket(env: Env): R2Bucket {
  return ((env.BACKUPS as R2Bucket | undefined) ?? env.FILES_WRITE)
}

export const backupKey = (slug: string, date: string) => `backups/${slug}/${date}.sql.gz`
export const exportKey = (slug: string, id: string) => `exports/${slug}/${id}.zip`

// --- reading a database ------------------------------------------------------------

interface SchemaObject { name: string; type: string; sql: string }

/** User objects of a D1 database: tables first, then indexes, triggers, views. */
export async function schemaObjects(db: D1Database): Promise<SchemaObject[]> {
  const r = await db.prepare(`SELECT name, type, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`).all<SchemaObject>()
  return r.results ?? []
}

const q = (id: string) => '"' + id.replace(/"/g, '""') + '"'

/** Every row of a table, in pages: by rowid when the table has one, else by OFFSET. */
export async function* tableRows(db: D1Database, t: SchemaObject): AsyncGenerator<Record<string, unknown>[]> {
  const rowid = !/WITHOUT\s+ROWID/i.test(t.sql)
  if (rowid) {
    let last: number | null = null
    for (;;) {
      const r: D1Result<Record<string, unknown>> = await db.prepare(`SELECT rowid AS __rid, * FROM ${q(t.name)} WHERE (? IS NULL OR rowid > ?) ORDER BY rowid LIMIT ${PAGE}`)
        .bind(last, last).all<Record<string, unknown>>()
      const rows = r.results ?? []
      if (!rows.length) return
      last = Number(rows[rows.length - 1].__rid)
      for (const x of rows) delete x.__rid
      yield rows
      if (rows.length < PAGE) return
    }
  }
  for (let off = 0; ; off += PAGE) {
    const r = await db.prepare(`SELECT * FROM ${q(t.name)} LIMIT ${PAGE} OFFSET ${off}`).all<Record<string, unknown>>()
    const rows = r.results ?? []
    if (!rows.length) return
    yield rows
    if (rows.length < PAGE) return
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof ArrayBuffer) return `X'${hex(new Uint8Array(v))}'`
  if (ArrayBuffer.isView(v)) return `X'${hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}'`
  if (Array.isArray(v)) return `X'${hex(Uint8Array.from(v as number[]))}'` // D1 hands BLOBs back as number[]
  return "'" + String(v).replace(/'/g, "''") + "'"
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Array.isArray(v)) {
    const b = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Uint8Array.from(v as number[])
    let bin = ''
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000))
    s = 'base64:' + btoa(bin)
  } else s = String(v)
  // Spreadsheet formula injection: a leading = + - @ is read as a formula.
  if (/^[=+\-@]/.test(s)) s = "'" + s
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// --- streaming gzip to R2 ----------------------------------------------------------

/** Text in, gzip out, into an R2 multipart upload, with a SHA-256 of the object. */
export class GzipToR2 {
  private cs = new CompressionStream('gzip')
  private writer = this.cs.writable.getWriter()
  private enc = new TextEncoder()
  private text: string[] = []
  private textLen = 0
  private pending: Uint8Array[] = []
  private pendingLen = 0
  private parts: R2UploadedPart[] = []
  private digest = new crypto.DigestStream('SHA-256')
  private digestWriter = this.digest.getWriter()
  size = 0
  private drained: Promise<void>

  constructor(private upload: R2MultipartUpload) {
    this.drained = (async () => {
      const reader = this.cs.readable.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        this.size += value.byteLength
        await this.digestWriter.write(value)
        this.pending.push(value); this.pendingLen += value.byteLength
        if (this.pendingLen >= PART) await this.flushPart()
      }
      if (this.pendingLen > 0 || this.parts.length === 0) await this.flushPart()
    })()
  }

  private async flushPart() {
    const body = new Uint8Array(this.pendingLen)
    let p = 0
    for (const c of this.pending) { body.set(c, p); p += c.byteLength }
    this.pending = []; this.pendingLen = 0
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, body))
  }

  async write(s: string) {
    this.text.push(s); this.textLen += s.length
    if (this.textLen >= 256 * 1024) await this.flushText()
  }

  private async flushText() {
    if (!this.textLen) return
    const s = this.text.join(''); this.text = []; this.textLen = 0
    await this.writer.write(this.enc.encode(s))
  }

  async finish(): Promise<{ size: number; sha256: string }> {
    await this.flushText()
    await this.writer.close()
    await this.drained
    await this.upload.complete(this.parts)
    await this.digestWriter.close()
    return { size: this.size, sha256: hex(new Uint8Array(await this.digest.digest)) }
  }

  async abort() { try { await this.upload.abort() } catch { /* already gone */ } }
}

/** Dumps a whole D1 database as SQL to `key`. */
export async function dumpDatabase(bucket: R2Bucket, db: D1Database, key: string, label: string): Promise<{ tables: number; rows: number; size: number; sha256: string }> {
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { label, created_at: new Date().toISOString() } })
  const out = new GzipToR2(upload)
  try {
    const objects = await schemaObjects(db)
    await out.write(`-- ${label}: SQL dump taken ${new Date().toISOString()} by the school-erp Worker.\n`)
    await out.write(`-- Restore into an EMPTY database: npx wrangler d1 execute <db> --remote --file=dump.sql\nPRAGMA defer_foreign_keys = true;\n`)
    const tables = objects.filter((o) => o.type === 'table')
    for (const t of tables) await out.write(`${t.sql};\n`)
    let rows = 0
    for (const t of tables) {
      await out.write(`\n-- ${t.name}\n`)
      for await (const page of tableRows(db, t)) {
        for (const row of page) {
          const cols = Object.keys(row)
          await out.write(`INSERT INTO ${q(t.name)} (${cols.map(q).join(', ')}) VALUES (${cols.map((c) => sqlValue(row[c])).join(', ')});\n`)
        }
        rows += page.length
      }
    }
    await out.write('\n')
    for (const o of objects) if (o.type !== 'table') await out.write(`${o.sql};\n`)
    const done = await out.finish()
    return { tables: tables.length, rows, ...done }
  } catch (err) {
    await out.abort()
    throw err
  }
}

// --- retention ---------------------------------------------------------------------

/** Which of these dated backups to keep: the last 30 days, then the first of each month for 12 months. */
export function keepDates(dates: string[], today: string): Set<string> {
  const keep = new Set<string>()
  const t = Date.parse(today + 'T00:00:00Z')
  const firstOfMonth = new Map<string, string>()
  for (const d of [...dates].sort()) {
    const age = (t - Date.parse(d + 'T00:00:00Z')) / 86400_000
    if (age < DAILY_KEEP) keep.add(d)
    const m = d.slice(0, 7)
    if (!firstOfMonth.has(m)) firstOfMonth.set(m, d)
  }
  const months = [...firstOfMonth.keys()].sort().reverse()
  const cutoff = new Date(t); cutoff.setUTCMonth(cutoff.getUTCMonth() - (MONTHLY_KEEP - 1))
  const cutoffMonth = cutoff.toISOString().slice(0, 7)
  for (const m of months) if (m >= cutoffMonth) keep.add(firstOfMonth.get(m)!)
  return keep
}

export async function pruneBackups(env: Env, institutionId: string | null, today: string): Promise<number> {
  const r = await env.CONTROL.prepare(`SELECT id, backup_date, object_key FROM backups
      WHERE status = 'succeeded' AND ${institutionId ? 'institution_id = ?' : `scope = 'control'`}`)
    .bind(...(institutionId ? [institutionId] : [])).all<{ id: string; backup_date: string; object_key: string }>()
  const rows = r.results ?? []
  const keep = keepDates(rows.map((x) => x.backup_date), today)
  let pruned = 0
  const bucket = backupBucket(env)
  for (const x of rows) {
    if (keep.has(x.backup_date)) continue
    // Another succeeded row for the same key (a re-run that day) keeps the object.
    if (rows.some((y) => y.id !== x.id && y.object_key === x.object_key && keep.has(y.backup_date))) continue
    await bucket.delete(x.object_key)
    await env.CONTROL.prepare(`UPDATE backups SET status = 'pruned', pruned_at = ? WHERE id = ?`).bind(new Date().toISOString(), x.id).run()
    pruned++
  }
  return pruned
}

// --- jobs --------------------------------------------------------------------------

interface BackupPayload { institution_id?: string | null; scope?: 'control' | 'school'; kind?: string; requested_by?: string | null }

/** Schools whose database still exists (every status but deleted). */
async function backupSchools(env: Env): Promise<Institution[]> {
  const r = await env.CONTROL.prepare(`SELECT * FROM institutions WHERE status <> 'deleted' ORDER BY created_at`).all<Institution>()
  return r.results ?? []
}

registerJob('backup:fanout', async (env) => {
  const schools = await backupSchools(env)
  await enqueueMany(env, [
    { type: 'backup:database', payload: { scope: 'control', kind: 'nightly' } as BackupPayload, institution_id: null },
    ...schools.map((s) => ({ type: 'backup:database', payload: { scope: 'school', kind: 'nightly', institution_id: s.id } as BackupPayload, institution_id: s.id })),
  ])
  await expireExports(env)
})

registerJob<BackupPayload>('backup:database', async (env, job) => {
  const control = job.payload.scope === 'control'
  let db: D1Database, slug: string, label: string, instId: string | null = null
  if (control) {
    db = env.CONTROL; slug = '_control'; label = 'CONTROL'
  } else {
    instId = job.institution_id ?? job.payload.institution_id ?? null
    if (!instId) throw new SkipRetry('backup:database: no institution')
    const inst = await institutionById(env, instId)
    if (!inst) throw new SkipRetry('backup:database: unknown school ' + instId)
    try { db = tenantDb(env, inst) } catch (e) { throw new SkipRetry(String(e)) }
    slug = inst.slug; label = inst.name
  }
  const date = new Date().toISOString().slice(0, 10)
  const key = backupKey(slug, date)
  const id = crypto.randomUUID()
  const started = new Date().toISOString()
  await env.CONTROL.prepare(`INSERT INTO backups (id, institution_id, scope, kind, backup_date, object_key, status, requested_by, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`).bind(id, instId, control ? 'control' : 'school', job.payload.kind ?? 'nightly',
    date, key, job.payload.requested_by ?? null, started).run()
  try {
    const res = await dumpDatabase(backupBucket(env), db, key, label)
    await env.CONTROL.batch([
      env.CONTROL.prepare(`UPDATE backups SET status = 'replaced' WHERE object_key = ? AND status = 'succeeded' AND id <> ?`).bind(key, id),
      env.CONTROL.prepare(`UPDATE backups SET status = 'succeeded', tables = ?, row_count = ?, size_bytes = ?, sha256 = ?, finished_at = ? WHERE id = ?`)
        .bind(res.tables, res.rows, res.size, res.sha256, new Date().toISOString(), id),
    ])
    const pruned = await pruneBackups(env, instId, date)
    console.log('backup done', { label, key, ...res, pruned })
  } catch (err) {
    await env.CONTROL.prepare(`UPDATE backups SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
      .bind(String(err instanceof Error ? err.message : err).slice(0, 2000), new Date().toISOString(), id).run()
    throw err
  }
})

// --- school exports ----------------------------------------------------------------

/** The school's objects in R2 (both buckets; the write bucket wins on a duplicate key). */
async function filesManifest(env: Env, instId: string): Promise<{ key: string; size: number; uploaded: string; etag: string; bucket: string }[]> {
  const seen = new Map<string, { key: string; size: number; uploaded: string; etag: string; bucket: string }>()
  for (const [name, b] of [['uploads', env.FILES_WRITE], ['live', env.FILES]] as [string, R2Bucket][]) {
    let cursor: string | undefined
    do {
      const l = await b.list({ prefix: instId + '/', cursor, limit: 1000 })
      for (const o of l.objects) if (!seen.has(o.key)) seen.set(o.key, { key: o.key, size: o.size, uploaded: o.uploaded.toISOString(), etag: o.etag, bucket: name })
      cursor = l.truncated ? l.cursor : undefined
    } while (cursor)
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export async function buildSchoolExport(env: Env, inst: Institution, exportId: string): Promise<{ key: string; size: number; tables: number; rows: number; files: number }> {
  const db = tenantDb(env, inst)
  const enc = new TextEncoder()
  const entries: [string, Uint8Array][] = []
  let rows = 0
  const tables = (await schemaObjects(db)).filter((o) => o.type === 'table')
  for (const t of tables) {
    const lines: string[] = []
    let cols: string[] | null = null
    for await (const page of tableRows(db, t)) {
      if (!cols) { cols = Object.keys(page[0]); lines.push(cols.map(csvCell).join(',')) }
      for (const r of page) lines.push(cols.map((c) => csvCell(r[c])).join(','))
      rows += page.length
    }
    if (!cols) {
      const info = await db.prepare(`PRAGMA table_info(${q(t.name)})`).all<{ name: string }>()
      lines.push((info.results ?? []).map((c) => csvCell(c.name)).join(','))
    }
    entries.push([`tables/${t.name}.csv`, enc.encode(lines.join('\r\n') + '\r\n')])
  }
  const files = await filesManifest(env, inst.id)
  entries.push(['files.csv', enc.encode(['key,size_bytes,uploaded_at,etag,bucket', ...files.map((f) => [f.key, f.size, f.uploaded, f.etag, f.bucket].map(csvCell).join(','))].join('\r\n') + '\r\n')])
  entries.push(['README.txt', enc.encode(`Export of ${inst.name} (${inst.slug}), taken ${new Date().toISOString()}.\r\n` +
    `tables/: one CSV per database table, first row the column names. Binary values are written base64:<data>.\r\n` +
    `files.csv: every uploaded file the school holds; ask the provider for the files themselves by key.\r\n` +
    `schema.sql: the table definitions.\r\n`)])
  entries.push(['schema.sql', enc.encode(tables.map((t) => t.sql + ';').join('\n') + '\n')])
  const zip = zipStored(entries)
  const key = exportKey(inst.slug, exportId)
  await backupBucket(env).put(key, zip, { httpMetadata: { contentType: 'application/zip' } })
  return { key, size: zip.byteLength, tables: tables.length, rows, files: files.length }
}

registerJob<{ export_id: string }>('export:school', async (env, job) => {
  const ex = await env.CONTROL.prepare(`SELECT * FROM school_exports WHERE id = ?`).bind(job.payload.export_id).first<{ id: string; institution_id: string; status: string }>()
  if (!ex) throw new SkipRetry('export:school: unknown export')
  if (ex.status === 'ready') return
  const inst = await institutionById(env, ex.institution_id)
  if (!inst) throw new SkipRetry('export:school: unknown school')
  await env.CONTROL.prepare(`UPDATE school_exports SET status = 'running' WHERE id = ?`).bind(ex.id).run()
  try {
    const r = await buildSchoolExport(env, inst, ex.id)
    const at = new Date()
    await env.CONTROL.prepare(`UPDATE school_exports SET status = 'ready', object_key = ?, size_bytes = ?, tables = ?, row_count = ?, files = ?,
        finished_at = ?, expires_at = ?, error = NULL WHERE id = ?`)
      .bind(r.key, r.size, r.tables, r.rows, r.files, at.toISOString(), new Date(at.getTime() + EXPORT_TTL_DAYS * 86400_000).toISOString(), ex.id).run()
  } catch (err) {
    await env.CONTROL.prepare(`UPDATE school_exports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
      .bind(String(err instanceof Error ? err.message : err).slice(0, 2000), new Date().toISOString(), ex.id).run()
    throw err
  }
})

/** Deletes export ZIPs past their expiry. Runs with the nightly fan-out. */
export async function expireExports(env: Env): Promise<number> {
  const r = await env.CONTROL.prepare(`SELECT id, object_key FROM school_exports WHERE status = 'ready' AND expires_at < ?`)
    .bind(new Date().toISOString()).all<{ id: string; object_key: string | null }>()
  for (const x of r.results ?? []) {
    if (x.object_key) await backupBucket(env).delete(x.object_key)
    await env.CONTROL.prepare(`UPDATE school_exports SET status = 'expired' WHERE id = ?`).bind(x.id).run()
  }
  return (r.results ?? []).length
}

// The weekly D1-export copies (weekly_export.ts) register their jobs with these.
import './weekly_export'
