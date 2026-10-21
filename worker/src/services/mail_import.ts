import PostalMime from 'postal-mime'
import type { Env } from '../env'
import { institutionById, tenantDb } from '../tenant'
import { enqueue, registerJob } from './jobs'
import { Imap, ImapRefused, sentFolder } from './imap'
import { alreadyHave, messageIdOf, storeMail, type StoredFolder } from './mail'
import { openSecretEnv } from './messaging'

/* A member of staff's own mailbox on the school's mail server
   (routes/comms/inbox.ts, "Connect your mailbox").

   The school sets the server once (mail_server); each person saves their own
   mailbox password (mail_connections.secret, sealed under CREDENTIAL_KEY).
   With it their mail leaves through the server as them, and their old mail
   is copied in: INBOX into inbox, the Sent folder into sent.

   The copy runs as queue jobs of a few messages each (a Worker invocation has
   limits on time and memory). Each job logs in, counts what is left in both
   folders, copies up to CHUNK messages in UID order, saves the last UID done
   per folder in import_cursor and queues the next job. A job that finds the
   connection gone or the import not running stops. Pressing Import again
   later carries on from the saved UIDs, so only newer mail is copied; a
   message already in the mailbox by Message-ID is skipped. */

export const IMPORT_JOB = 'mail:import'
const CHUNK = 25
const CHUNK_MS = 60_000
const MAX_MESSAGE = 30 << 20

export interface MailServer { imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; smtp_security: 'tls' | 'starttls' }

export async function mailServer(db: D1Database): Promise<MailServer> {
  const r = await db.prepare(`SELECT imap_host, imap_port, smtp_host, smtp_port, smtp_security FROM mail_server WHERE id = 'school'`).first<MailServer>()
  return r
    ? { ...r, imap_port: Number(r.imap_port), smtp_port: Number(r.smtp_port), smtp_security: r.smtp_security === 'starttls' ? 'starttls' : 'tls' }
    : { imap_host: '', imap_port: 993, smtp_host: '', smtp_port: 465, smtp_security: 'tls' }
}

/** The person's saved mailbox password, or null when not connected. */
export async function mailboxPassword(env: Env, db: D1Database, user: string): Promise<string | null> {
  const r = await db.prepare('SELECT secret FROM mail_connections WHERE user_id = ?').bind(user).first<{ secret: ArrayBuffer }>()
  return r ? openSecretEnv(env, r.secret) : null
}

/** Why a login failed, in words for the person; the server's reply is kept
    (it never holds the password: see services/imap.ts). */
export function loginProblem(e: unknown): { status: 400 | 502; message: string } {
  const msg = e instanceof Error ? e.message : String(e)
  if (e instanceof ImapRefused && msg.startsWith('login: ')) return { status: 400, message: 'the mail server refused the sign-in: ' + msg.slice(7) }
  if (e instanceof ImapRefused) return { status: 502, message: 'the mail server said: ' + msg }
  return { status: 502, message: 'could not reach the mail server: ' + msg }
}

/** Signs in and out again; throws as Imap does. */
export async function testLogin(server: MailServer, address: string, password: string): Promise<void> {
  const c = await Imap.open({ host: server.imap_host, port: server.imap_port }, 20_000)
  try { await c.login(address, password) } finally { await c.logout() }
}

interface FolderCursor { name: string; target: StoredFolder; uidvalidity: number; last_uid: number }
interface Cursor { folders: FolderCursor[] }

const readCursor = (raw: string | null): Cursor => {
  try { const v = JSON.parse(raw ?? ''); if (v && Array.isArray(v.folders)) return v as Cursor } catch { /* new */ }
  return { folders: [] }
}

/** The date a message was sent, else now. */
function dateOf(raw: string | undefined): string {
  const t = raw ? Date.parse(raw) : NaN
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString()
}

/** One chunk of a person's import. Returns true when more is left. */
export async function runImportChunk(env: Env, db: D1Database, institutionId: string, user: string): Promise<boolean> {
  const conn = await db.prepare(`SELECT c.secret, c.import_state, c.import_done, c.import_cursor, ma.address
      FROM mail_connections c JOIN mail_addresses ma ON ma.user_id = c.user_id WHERE c.user_id = ?`)
    .bind(user).first<{ secret: ArrayBuffer; import_state: string; import_done: number; import_cursor: string | null; address: string }>()
  if (!conn || (conn.import_state !== 'queued' && conn.import_state !== 'running')) return false
  const server = await mailServer(db)
  const save = (state: string, done: number, total: number, cursor: Cursor, error: string | null) => db.prepare(`UPDATE mail_connections
      SET import_state = ?, import_done = ?, import_total = ?, import_cursor = ?, import_error = ?, import_updated_at = ? WHERE user_id = ?`)
    .bind(state, done, total, JSON.stringify(cursor), error, new Date().toISOString(), user).run()

  const cursor = readCursor(conn.import_cursor)
  let done = Number(conn.import_done)
  let total = done
  if (!server.imap_host) { await save('failed', done, total, cursor, 'the school has not set its mail server yet'); return false }

  let c: Imap | null = null
  try {
    const password = await openSecretEnv(env, conn.secret)
    c = await Imap.open({ host: server.imap_host, port: server.imap_port })
    await c.login(conn.address, password)
    if (!cursor.folders.length) {
      cursor.folders.push({ name: 'INBOX', target: 'inbox', uidvalidity: 0, last_uid: 0 })
      const sent = sentFolder(await c.list())
      if (sent) cursor.folders.push({ name: sent, target: 'sent', uidvalidity: 0, last_uid: 0 })
    }
    // What is left in each folder. A changed UIDVALIDITY means the server
    // renumbered the folder: start it again; Message-IDs stop duplicates.
    const left: { f: FolderCursor; uids: number[] }[] = []
    for (const f of cursor.folders) {
      const { uidvalidity } = await c.select(f.name)
      if (uidvalidity !== f.uidvalidity) { f.uidvalidity = uidvalidity; f.last_uid = 0 }
      left.push({ f, uids: (await c.uids()).filter((u) => u > f.last_uid) })
    }
    total = done + left.reduce((n, x) => n + x.uids.length, 0)
    await save('running', done, total, cursor, null)

    const started = Date.now()
    let n = 0
    for (const { f, uids } of left) {
      if (!uids.length) continue
      await c.select(f.name)
      for (const uid of uids) {
        if (n >= CHUNK || Date.now() - started > CHUNK_MS) break
        const m = await c.fetch(uid)
        if (m && m.body.byteLength <= MAX_MESSAGE) {
          const mail = await PostalMime.parse(m.body, { attachmentEncoding: 'arraybuffer' })
          if (!(await alreadyHave(db, user, messageIdOf(mail), f.target))) {
            await storeMail(env, db, institutionId, user, f.target, mail, {
              fallbackFrom: f.target === 'sent' ? conn.address : '', receivedAt: dateOf(mail.date),
              read: f.target === 'sent' || m.flags.some((x) => x.toLowerCase() === '\\seen'),
            })
          }
        }
        f.last_uid = uid
        done++; n++
        await save('running', done, total, cursor, null)
      }
      if (n >= CHUNK || Date.now() - started > CHUNK_MS) break
    }
    await c.logout(); c = null
    const more = done < total
    // Disconnected meanwhile: the row is gone and this writes nothing.
    await save(more ? 'running' : 'done', done, total, cursor, null)
    return more
  } catch (e) {
    if (c) await c.close()
    const why = loginProblem(e).message
    await save('failed', done, total, cursor, why.slice(0, 500))
    return false
  }
}

registerJob<{ user_id: string }>(IMPORT_JOB, async (env, job) => {
  const inst = job.institution_id ? await institutionById(env, job.institution_id) : null
  if (!inst) return
  const db = tenantDb(env, inst)
  if (await runImportChunk(env, db, inst.id, job.payload.user_id)) {
    await enqueue(env, IMPORT_JOB, { user_id: job.payload.user_id }, { institution_id: inst.id })
  }
})
