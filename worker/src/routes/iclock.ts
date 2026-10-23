import type { Env } from '../env'
import { tenantDb, type Institution } from '../tenant'
import { now, uuid } from '../http'
import { parsePunchTime, rollUpImportedDay } from './setup/imports'

/* AN eSSL / ZKTeco READER PUSHING ITS PUNCHES (owner, 2026-10-13: "I don't
   have a static IP, how can I use biometric?").

   The school needs no static IP and no port opened: the reader is set to a
   cloud server (Menu > Comm. > Cloud Server Setting / ADMS) and calls us.
   This is the "iclock" push protocol those readers speak:

     GET  /iclock/cdata?SN=…            hello; we answer with the options
     POST /iclock/cdata?SN=…&table=ATTLOG   punches, one per line:
                                          PIN <tab> 2026-10-13 08:40:55 <tab> status <tab> verify …
     GET  /iclock/getrequest?SN=…       "any commands for me?" -- none
     POST /iclock/devicecmd?SN=…        a command's result -- noted, ignored

   A reader is known by its serial number, registered by the school in
   Attendance devices > Biometric readers; that registration is what says
   which school it belongs to. An unknown or switched-off reader is answered
   politely and nothing it sends is kept. Each punch is matched to the member
   of staff whose device user id it carries, stored once, and rolled into the
   day's staff attendance exactly as an uploaded punch file is
   (setup/imports.ts rollUpImportedDay). */

/** The module_settings row that holds a reader's pending "send me your history". */
export const HISTORY_KEY = (deviceId: string) => `biometric_history:${deviceId}`

/** [user id, time, status, verify] from either line format a reader uses:
    "7<tab>2026-10-12 08:41:02<tab>0<tab>1" or "PIN=7<tab>Time=2026-10-12 08:41:02<tab>Status=0<tab>Verify=1". */
function punchFields(line: string): string[] | null {
  const t = line.trim()
  if (!t) return null
  if (/=/.test(t)) {
    const kv = new Map<string, string>()
    for (const part of t.replace(/^\S+\s+(?=\S+=)/, '').split(/\t|\s{2,}/)) {
      const i = part.indexOf('=')
      if (i > 0) kv.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim())
    }
    const pin = kv.get('pin') ?? kv.get('userid') ?? kv.get('user_id'), time = kv.get('time') ?? kv.get('datetime') ?? kv.get('checktime')
    return pin && time ? [pin, time, kv.get('status') ?? '', kv.get('verify') ?? kv.get('verifytype') ?? ''] : null
  }
  const f = t.split('\t').map((x) => x.trim())
  return f.length >= 2 && f[0] && f[1] ? f : null
}

const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } })

/* THE READER'S OWN USER LIST.

   Punches carry only the id enrolled on the reader (YPS0006), which need not
   be anything the office uses. The reader also holds the name typed in at
   enrolment, and sends its list in one of two shapes depending on firmware:
     USER PIN=YPS0006<tab>Name=Ravi Kumar<tab>Pri=0<tab>Card=...   (OPERLOG)
     user uid=6<tab>pin=YPS0006<tab>name=Ravi Kumar<tab>privilege=0 (USERINFO)
   Both are read here. Readers hold no phone numbers. */
function userFields(line: string): { pin: string; name: string; card: string; pri: number | null } | null {
  const t = line.trim()
  if (!/\bpin=/i.test(t) || !/\bname=/i.test(t)) return null
  const kv = new Map<string, string>()
  for (const part of t.replace(/^user\s+/i, '').split(/\t/)) {
    const i = part.indexOf('=')
    if (i > 0) kv.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim())
  }
  const pin = (kv.get('pin') ?? '').toUpperCase()
  if (!pin) return null
  const pri = Number(kv.get('pri') ?? kv.get('privilege'))
  return { pin, name: kv.get('name') ?? '', card: kv.get('card') ?? kv.get('cardno') ?? '', pri: Number.isFinite(pri) ? pri : null }
}

/** A name reduced to its words, lower case, letters only, sorted. */
const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1).sort().join(' ')

/* LINK BY NAME. Every reader id that no staff record carries yet is matched to
   the member of staff whose name is the same words (in any order); a reader
   name cut short by the machine's field length matches when its words are all
   in exactly one staff name. Anything matching none or more than one is left
   for the office, under "Fingers nobody claims". Returns the employees linked. */
export async function linkReaderUsersByName(db: D1Database, inst: string, deviceId: string): Promise<string[]> {
  const users = await db.prepare(`SELECT u.device_user_id AS pin, u.name FROM biometric_device_users u
      WHERE u.device_id = ? AND COALESCE(u.name, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.institution_id = ? AND upper(CAST(e.device_user_id AS TEXT)) = u.device_user_id)`)
    .bind(deviceId, inst).all<{ pin: string; name: string }>()
  if (!users.results.length) return linkReaderUsersByCode(db, inst)
  const staff = await db.prepare(`SELECT id, TRIM(first_name || ' ' || COALESCE(last_name, '')) AS name FROM employees
      WHERE institution_id = ? AND device_user_id IS NULL`).bind(inst).all<{ id: string; name: string }>()
  const keyed = staff.results.map((s) => ({ id: s.id, key: nameKey(s.name), words: new Set(nameKey(s.name).split(' ')) }))
  /* THE PIN THAT IS THE STAFF CODE (owner, 2026-10-14: "i dont see their past
     attendance and today's also").

     At Yajur the reader was enrolled with each person's staff code as their
     PIN -- T063 is T063 on the machine -- and named them "T,PRANAY". The name
     pass below reduces "M,NANDINI" to one word and "MADISHETTY NANDINI" to
     two, and will never match them; T064 sat unlinked for a day while her
     neighbours linked by name. A PIN equal to a staff code is that person,
     full stop. Settled first, as one SQL statement -- the same selection is
     checkable against the database directly, and it is the database's
     answer that counts. */
  const byCode = await linkReaderUsersByCode(db, inst)
  const taken = new Set<string>(byCode)
  const links: { emp: string; pin: string }[] = []
  for (const u of users.results) {
    const k = nameKey(u.name)
    if (!k) continue
    let hits = keyed.filter((s) => s.key === k)
    if (hits.length === 0) {
      const words = k.split(' ')
      if (words.length >= 2) hits = keyed.filter((s) => words.every((w) => s.words.has(w)))
    }
    if (hits.length !== 1 || taken.has(hits[0].id)) continue
    taken.add(hits[0].id)
    links.push({ emp: hits[0].id, pin: u.pin })
  }
  if (links.length) await db.batch(links.map((l) => db.prepare(`UPDATE employees SET device_user_id = ? WHERE id = ? AND device_user_id IS NULL`).bind(l.pin, l.emp)))
  return [...byCode, ...links.map((l) => l.emp)]
}

/** Every unlinked active employee whose staff code is an unclaimed reader PIN is linked to it. Returns the employees linked. */
export async function linkReaderUsersByCode(db: D1Database, inst: string): Promise<string[]> {
  const who = await db.prepare(`SELECT e.id FROM employees e
      WHERE e.institution_id = ?1 AND e.status = 'active' AND e.device_user_id IS NULL AND COALESCE(e.employee_code, '') <> ''
        AND EXISTS (SELECT 1 FROM biometric_device_users u WHERE u.institution_id = e.institution_id
                      AND upper(trim(u.device_user_id)) = upper(trim(e.employee_code)))
        AND NOT EXISTS (SELECT 1 FROM employees x WHERE x.institution_id = e.institution_id AND x.id <> e.id
                          AND upper(trim(CAST(x.device_user_id AS TEXT))) = upper(trim(e.employee_code)))`).bind(inst).all<{ id: string }>()
  if (!who.results.length) return []
  await db.prepare(`UPDATE employees SET device_user_id = (
        SELECT u.device_user_id FROM biometric_device_users u
         WHERE u.institution_id = employees.institution_id AND upper(trim(u.device_user_id)) = upper(trim(employees.employee_code)) LIMIT 1)
      WHERE id IN (SELECT value FROM json_each(?1)) AND device_user_id IS NULL`).bind(JSON.stringify(who.results.map((r) => r.id))).run()
  return who.results.map((r) => r.id)
}

/* MATCH THE PUNCHES ALREADY HERE, AND ROLL RECENT DAYS INTO ATTENDANCE.

   A punch that arrived before its owner was linked is stored with no
   employee. Matched here in one statement, then the last 75 days of those
   punches are written into staff attendance exactly as rollUpImportedDay
   would, one day at a time per person -- but as two set-based statements, so
   a reader's two years of history does not run past the Worker's per-request
   query limit. Older days stay stored and matched, not rewritten into
   attendance: their months are long since paid. A day the office marked by
   hand (any source but 'device') is never touched. */
export async function resolveStoredPunches(db: D1Database, inst: string): Promise<{ matched: number; days: number }> {
  const m = await db.prepare(`UPDATE biometric_punches SET employee_id = (
        SELECT e.id FROM employees e WHERE e.institution_id = biometric_punches.institution_id
          AND upper(CAST(e.device_user_id AS TEXT)) = biometric_punches.device_user_id)
      WHERE institution_id = ? AND employee_id IS NULL
        AND EXISTS (SELECT 1 FROM employees e WHERE e.institution_id = biometric_punches.institution_id
          AND upper(CAST(e.device_user_id AS TEXT)) = biometric_punches.device_user_id)`).bind(inst).run()
  const since = new Date(Date.now() - 75 * 86400_000).toISOString()
  const day = `date(datetime(p.punched_at, '+330 minutes'))`
  const [ins] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO staff_attendance (id, institution_id, user_id, on_date, status, check_in, check_out, source, device_ref, created_at)
        SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
               ?1, g.user_id, g.d, 'present', g.fi, CASE WHEN julianday(g.la) - julianday(g.fi) >= 5.0 / 1440 THEN g.la END, 'device', g.serial, ?3
          FROM (SELECT e.user_id, ${day} AS d, MIN(p.punched_at) AS fi, MAX(p.punched_at) AS la, MAX(bd.serial) AS serial
                  FROM biometric_punches p JOIN employees e ON e.id = p.employee_id JOIN biometric_devices bd ON bd.id = p.device_id
                 WHERE p.institution_id = ?1 AND p.punched_at >= ?2 AND e.user_id IS NOT NULL
                 GROUP BY e.user_id, d) g`).bind(inst, since, now()),
    db.prepare(`UPDATE staff_attendance SET
          check_in = MIN(COALESCE(check_in, '9999'), (SELECT MIN(p.punched_at) FROM biometric_punches p JOIN employees e ON e.id = p.employee_id
              WHERE e.user_id = staff_attendance.user_id AND ${day} = staff_attendance.on_date)),
          check_out = (SELECT CASE WHEN julianday(MAX(p.punched_at)) - julianday(MIN(p.punched_at)) >= 5.0 / 1440 THEN MAX(p.punched_at) END FROM biometric_punches p JOIN employees e ON e.id = p.employee_id
              WHERE e.user_id = staff_attendance.user_id AND ${day} = staff_attendance.on_date),
          status = 'present'
        WHERE institution_id = ?1 AND source = 'device' AND on_date >= date(?2, '+330 minutes')
          AND EXISTS (SELECT 1 FROM biometric_punches p JOIN employees e ON e.id = p.employee_id
              WHERE e.user_id = staff_attendance.user_id AND ${day} = staff_attendance.on_date)`).bind(inst, since),
  ])
  /* Said out loud, because the one time this quietly wrote nothing it took
     an afternoon to find out. */
  console.log(JSON.stringify({ iclock: 'resolve-stored-punches', inst, matched: m.meta.changes ?? 0, days: ins.meta.changes ?? 0, since }))
  return { matched: m.meta.changes ?? 0, days: ins.meta.changes ?? 0 }
}

/** The module_settings row that holds a reader's pending "send me your user list". */
export const USERS_KEY = (deviceId: string) => `biometric_users:${deviceId}`

/* Which school a serial belongs to, kept for the life of this isolate. */
const known = new Map<string, { inst: Institution; deviceId: string; active: boolean; at: number }>()

async function findDevice(env: Env, serial: string) {
  const hit = known.get(serial)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit
  const schools = await env.CONTROL.prepare(`SELECT * FROM institutions`).all<Institution>()
  for (const inst of schools.results) {
    let db: D1Database
    try { db = tenantDb(env, inst) } catch { continue }
    try {
      const d = await db.prepare(`SELECT id, is_active FROM biometric_devices WHERE serial = ?`).bind(serial).first<{ id: string; is_active: number }>()
      if (d) {
        const v = { inst, deviceId: d.id, active: !!d.is_active, at: Date.now() }
        known.set(serial, v)
        return v
      }
    } catch { /* a school without the table yet */ }
  }
  return null
}

const CLOCK_KEY = (deviceId: string) => `iclock_clock:${deviceId}`
const CLOCK_EVERY_MS = 6 * 3600_000

/** India time in the readers' packed form: seconds counted on a calendar of 31-day months from 2000. */
export function zkTime(d: Date): number {
  const t = new Date(d.getTime() + 330 * 60_000)
  const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1, day = t.getUTCDate()
  return ((y - 2000) * 12 * 31 + (mo - 1) * 31 + day - 1) * 86400 + (t.getUTCHours() * 60 + t.getUTCMinutes()) * 60 + t.getUTCSeconds()
}

export async function handleIclock(env: Env, req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/iclock/')) return null
  const serial = (url.searchParams.get('SN') ?? '').trim()
  if (!serial) return text('OK')
  const dev = await findDevice(env, serial)
  /* eSSL firmware (the X2008 among them) calls the same endpoints with .aspx
     on the end: /iclock/getrequest.aspx, /iclock/cdata.aspx. Matched without
     it, the reader's check-ins were seen but Fetch history was never handed
     to it and every punch it pushed was answered OK and dropped. */
  const path = url.pathname.replace(/\/+$/, '').replace(/\.aspx$/i, '')
  const db = dev ? tenantDb(env, dev.inst) : null
  if (db && dev) {
    const fw = url.searchParams.get('pushver') ?? url.searchParams.get('FWVersion')
    await db.prepare(`UPDATE biometric_devices SET last_seen_at = ?, firmware = COALESCE(?, firmware) WHERE id = ?`).bind(now(), fw, dev.deviceId).run()
  }

  if (path === '/iclock/cdata' && req.method === 'GET') {
    /* The reader's settings: send every punch at once (Realtime), from the
       start of its log, and check in every 30 seconds. */
    return text([
      `GET OPTION FROM: ${serial}`, 'ATTLOGStamp=0', 'OPERLOGStamp=9999', 'ATTPHOTOStamp=None', 'ErrorDelay=60', 'Delay=30',
      'TransTimes=00:00;14:05', 'TransInterval=1', 'TransFlag=TransData AttLog', 'TimeZone=5.5', 'Realtime=1', 'Encrypt=None',
    ].join('\n') + '\n')
  }

  /* Punches: the live push (cdata, table=ATTLOG) and the answer to a
     history request (querydata, tablename=ATTLOG / transaction). */
  const table = (url.searchParams.get('table') ?? url.searchParams.get('tablename') ?? '').toUpperCase()
  if ((path === '/iclock/cdata' || path === '/iclock/querydata') && req.method === 'POST') {
    const body = await req.text()
    /* The user list, in either shape, from whichever table the firmware files
       it under. Kept, then linked by name, then the punches already stored
       for anybody newly linked are matched. */
    if (db && dev && dev.active) {
      const users = body.split('\n').map(userFields).filter((u): u is NonNullable<ReturnType<typeof userFields>> => !!u)
      if (users.length) {
        const inst = dev.inst.id
        for (let i = 0; i < users.length; i += 50) {
          await db.batch(users.slice(i, i + 50).map((u) => db.prepare(`INSERT INTO biometric_device_users (institution_id, device_id, device_user_id, name, card, privilege, updated_at)
              VALUES (?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?)
              ON CONFLICT (device_id, device_user_id) DO UPDATE SET name = excluded.name, card = excluded.card, privilege = excluded.privilege, updated_at = excluded.updated_at`)
            .bind(inst, dev.deviceId, u.pin, u.name, u.card, u.pri, now())))
        }
        const linked = await linkReaderUsersByName(db, inst, dev.deviceId)
        if (linked.length) await resolveStoredPunches(db, inst)
        console.log(JSON.stringify({ iclock: 'users', serial, received: users.length, linked: linked.length }))
        if (!(table === 'ATTLOG' || table === 'TRANSACTION')) return text(`OK: ${users.length}`)
      }
    }
    const isPunches = table === 'ATTLOG' || table === 'TRANSACTION' || (path === '/iclock/querydata' && /time=/i.test(body))
    if (!isPunches || !db || !dev || !dev.active) return text(`OK: ${body.split('\n').filter((l) => l.trim()).length}`)
    const inst = dev.inst.id
    let n = 0
    let orphans = 0
    const days = new Map<string, string>() // employee -> a punch time on that day, to roll up once each
    for (const line of body.split('\n')) {
      const f = punchFields(line)
      if (!f) continue
      let at: string
      try { at = parsePunchTime(f[1]) } catch { continue }
      if (Date.parse(at) > Date.now() + 24 * 3600_000) continue
      const uid = f[0].toUpperCase()
      const emp = await db.prepare(`SELECT id FROM employees WHERE upper(CAST(device_user_id AS TEXT)) = ?`).bind(uid).first<{ id: string }>()
      const res = await db.prepare(`INSERT OR IGNORE INTO biometric_punches (id, institution_id, device_id, device_user_id, employee_id, punched_at, status_code, verify_mode, raw, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst, dev.deviceId, uid, emp?.id ?? null, at, Number(f[2]) || null, Number(f[3]) || null, line.slice(0, 300), now()).run()
      n++
      if (emp && res.meta.changes) days.set(emp.id + '\0' + at.slice(0, 10), at)
      if (!emp) orphans++
    }
    for (const [k, at] of days) await rollUpImportedDay({ db, inst }, k.split('\0')[0], at, serial)
    /* A PUNCH FROM SOMEBODY WE HAVE NOT LINKED TRIES THE LINK (owner,
       2026-10-14: "show staff past registry and their in and out after they
       created with history").

       Linking only ran when the reader sent its user list, and this reader
       has sent it once. A member of staff added after that -- or one the
       name pass missed -- punched every morning into a record nobody owned,
       and nothing would ever revisit it. So a punch with no owner is the
       cue: try the linker, and if anybody is newly linked, match what they
       have already punched and roll the recent days into attendance. Only
       when an orphan was seen, so an ordinary push costs nothing extra. */
    if (orphans > 0) {
      const linked = await linkReaderUsersByName(db, inst, dev.deviceId)
      if (linked.length) await resolveStoredPunches(db, inst)
      console.log(JSON.stringify({ iclock: 'orphan-punches', serial, orphans, linked: linked.length }))
    }
    await db.prepare(`UPDATE biometric_devices SET last_push_at = ? WHERE id = ?`).bind(now(), dev.deviceId).run()
    return text(`OK: ${n}`)
  }

  /* "Any commands for me?" Only one: send everything you hold, when the
     school pressed Fetch history (setup/staff.ts). Asked both ways, since
     firmware differs: DATA QUERY for newer readers, CHECK (re-upload from
     stamp 0, which is what we hand out) for older ones. Asked once. */
  if (path === '/iclock/getrequest' && db && dev && dev.active) {
    const id = Math.floor(Date.now() / 1000) % 100000
    /* The user list first: it is small, and the names are what link the
       punches that follow to staff. Asked both ways, as with punches. */
    const ukey = USERS_KEY(dev.deviceId)
    const wantUsers = await db.prepare(`SELECT 1 AS x FROM module_settings WHERE module = ? AND enabled = 1`).bind(ukey).first()
    if (wantUsers) {
      await db.prepare(`UPDATE module_settings SET enabled = 0, config = ? WHERE module = ?`).bind(JSON.stringify({ sent_at: now() }), ukey).run()
      return text(`C:${id + 2}:DATA QUERY USERINFO\nC:${id + 3}:DATA QUERY USER\n`)
    }
    const key = HISTORY_KEY(dev.deviceId)
    const want = await db.prepare(`SELECT 1 AS x FROM module_settings WHERE module = ? AND enabled = 1`).bind(key).first()
    if (want) {
      await db.prepare(`UPDATE module_settings SET enabled = 0, config = ? WHERE module = ?`).bind(JSON.stringify({ sent_at: now() }), key).run()
      return text(`C:${id}:DATA QUERY ATTLOG StartTime=2000-01-01 00:00:00\tEndTime=2099-12-31 23:59:59\nC:${id + 1}:CHECK\n`)
    }
    /* The reader's clock. Nothing else sets it, and a reader left to its own
       clock drifts by minutes a month, so late marks stop meaning anything.
       Set on first contact and every six hours after, to India time. */
    const ckey = CLOCK_KEY(dev.deviceId)
    const last = await db.prepare(`SELECT config FROM module_settings WHERE module = ?`).bind(ckey).first<{ config: string | null }>()
    const at = Date.parse((JSON.parse(last?.config ?? '{}') as { sent_at?: string }).sent_at ?? '')
    if (!(at > Date.now() - CLOCK_EVERY_MS)) {
      await db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, ?, 0, ?)
          ON CONFLICT (institution_id, module) DO UPDATE SET config = excluded.config`).bind(dev.inst.id, ckey, JSON.stringify({ sent_at: now() })).run()
      return text(`C:${id + 4}:SET OPTIONS DateTime=${zkTime(new Date())}\n`)
    }
  }

  // devicecmd (a command's result) and anything else.
  return text('OK')
}
