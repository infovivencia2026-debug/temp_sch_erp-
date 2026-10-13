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

export async function handleIclock(env: Env, req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/iclock/')) return null
  const serial = (url.searchParams.get('SN') ?? '').trim()
  if (!serial) return text('OK')
  const dev = await findDevice(env, serial)
  const path = url.pathname.replace(/\/+$/, '')
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
    const isPunches = table === 'ATTLOG' || table === 'TRANSACTION' || (path === '/iclock/querydata' && /time=/i.test(body))
    if (!isPunches || !db || !dev || !dev.active) return text(`OK: ${body.split('\n').filter((l) => l.trim()).length}`)
    const inst = dev.inst.id
    let n = 0
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
    }
    for (const [k, at] of days) await rollUpImportedDay({ db, inst }, k.split('\0')[0], at, serial)
    await db.prepare(`UPDATE biometric_devices SET last_push_at = ? WHERE id = ?`).bind(now(), dev.deviceId).run()
    return text(`OK: ${n}`)
  }

  /* "Any commands for me?" Only one: send everything you hold, when the
     school pressed Fetch history (setup/staff.ts). Asked both ways, since
     firmware differs: DATA QUERY for newer readers, CHECK (re-upload from
     stamp 0, which is what we hand out) for older ones. Asked once. */
  if (path === '/iclock/getrequest' && db && dev && dev.active) {
    const key = HISTORY_KEY(dev.deviceId)
    const want = await db.prepare(`SELECT 1 AS x FROM module_settings WHERE module = ? AND enabled = 1`).bind(key).first()
    if (want) {
      await db.prepare(`UPDATE module_settings SET enabled = 0, config = ? WHERE module = ?`).bind(JSON.stringify({ sent_at: now() }), key).run()
      const id = Math.floor(Date.now() / 1000) % 100000
      return text(`C:${id}:DATA QUERY ATTLOG StartTime=2000-01-01 00:00:00\tEndTime=2099-12-31 23:59:59\nC:${id + 1}:CHECK\n`)
    }
  }

  // devicecmd (a command's result) and anything else.
  return text('OK')
}
