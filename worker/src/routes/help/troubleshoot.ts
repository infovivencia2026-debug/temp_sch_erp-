/* TROUBLESHOOTERS: checks the server runs instead of asking questions.

   Each answers [{check, ok, detail, fix?}] about the caller ("me"), or, for a
   member of staff who holds the right permission, about someone else in the
   school. The Help Centre runs one from a topic page; what it found goes with
   a request if the person still sends one. A fix is offered only where it is
   safe and the caller may make it (lifting a sign-in lock); everything else
   says which screen to open and who can do it. */
import type { Ctx, Router } from '../../router'
import { badRequest, forbidden, readJSON } from '../../http'
import { can } from '../../identity'
import { resolveScope } from '../teaching/common'
import { CATALOG_ROLES, IMPLEMENTED_FEATURES } from '../admin/static_data'
import { SECTION_MODULE, entitlementFor } from '../misc/shell'
import { schoolUser } from './requests'

export interface Check { check: string; ok: boolean; detail: string; fix?: { action: string; label: string } }
export interface Result { key: string; title: string; about: string; checks: Check[] }

const ok = (check: string, detail: string): Check => ({ check, ok: true, detail })
const bad = (check: string, detail: string, fix?: Check['fix']): Check => ({ check, ok: false, detail, ...(fix ? { fix } : {}) })
const istToday = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)

/** A user of this school by email, phone or username, through CONTROL's sign-in index. */
async function findUser(c: Ctx, identifier: string): Promise<{ id: string; full_name: string; status: string; email: string | null; phone: string | null; must_change_password: number; last_login_at: string | null } | null> {
  const inst = c.id.institution!.id
  const idx = await c.env.CONTROL.prepare(`SELECT user_id FROM login_index WHERE value = ? AND institution_id = ? LIMIT 1`).bind(identifier, inst).first<{ user_id: string }>()
  if (!idx) return null
  return c.db.prepare(`SELECT id, full_name, status, email, phone, must_change_password, last_login_at FROM users WHERE id = ?`).bind(idx.user_id)
    .first<{ id: string; full_name: string; status: string; email: string | null; phone: string | null; must_change_password: number; last_login_at: string | null }>()
}

async function signIn(c: Ctx, who: string): Promise<Result> {
  if (!who) {
    const u = await c.db.prepare(`SELECT email, phone FROM users WHERE id = ?`).bind(c.id.userId).first<{ email: string | null; phone: string | null }>()
    return { key: 'sign_in', title: 'Signing in', about: 'your account', checks: [
      ok('You are signed in now', 'This device has a working sign-in.'),
      u?.email || u?.phone ? ok('A reset link can reach you', `A new-password link goes to the ${u.email ? 'email address' : 'phone number'} the school holds for you.`)
        : bad('A reset link can reach you', 'The school holds no email address or phone number for you, so a forgotten password must be reset by the office.'),
    ] }
  }
  if (!can(c.id, 'access.users.read')) throw forbidden('checking someone else\'s sign-in needs Logins and access')
  const u = await findUser(c, who)
  const checks: Check[] = []
  if (!u) {
    return { key: 'sign_in', title: 'Signing in', about: who, checks: [bad('An account uses this', `No account in this school signs in with "${who}". Check the spelling, or give them a login under Staff, Logins and access.`)] }
  }
  checks.push(ok('An account uses this', `${u.full_name}.`))
  checks.push(u.status === 'active' ? ok('The account is active', 'It is not suspended.') : bad('The account is active', `It is ${u.status}. Reactivate it under Staff, Logins and access.`))
  const roles = await c.db.prepare(`SELECT count(*) AS n FROM user_roles WHERE user_id = ?`).bind(u.id).first<{ n: number }>()
  checks.push((roles?.n ?? 0) > 0 ? ok('It has a role', 'They see screens after signing in.') : bad('It has a role', 'With no role they sign in to an empty app. Give one under Staff, Logins and access.'))
  const lock = await c.env.CONTROL.prepare(`SELECT failures, locked_until FROM login_throttle WHERE key = ?`).bind('id:' + who.toLowerCase()).first<{ failures: number; locked_until: string | null }>()
  const locked = lock?.locked_until && lock.locked_until > new Date().toISOString()
  checks.push(locked
    ? bad('Not locked out', `Too many wrong passwords: sign-in is paused until ${lock!.locked_until!.slice(11, 16)} UTC.`, can(c.id, 'access.users.write') ? { action: 'unlock', label: 'Lift the lock' } : undefined)
    : ok('Not locked out', lock?.failures ? `${lock.failures} wrong attempt(s) recently, under the limit.` : 'No wrong attempts recently.'))
  if (u.must_change_password) checks.push(ok('Password', 'They are on a password the office issued and will be asked to set their own after signing in.'))
  const ev = await c.env.CONTROL.prepare(`SELECT at, outcome FROM login_events WHERE institution_id = ? AND (user_id = ? OR lower(identifier) = lower(?)) ORDER BY at DESC LIMIT 1`)
    .bind(c.id.institution!.id, u.id, who).first<{ at: string; outcome: string }>()
  checks.push(ev ? (ev.outcome === 'success' ? ok('Last attempt', `Signed in successfully on ${ev.at.slice(0, 10)}.`) : bad('Last attempt', `Refused on ${ev.at.slice(0, 10)}: ${ev.outcome.replace(/_/g, ' ')}.`))
    : bad('Last attempt', 'No sign-in attempt is recorded. They may be typing a different email, phone or username.'))
  return { key: 'sign_in', title: 'Signing in', about: u.full_name, checks }
}

async function messages(c: Ctx, who: string): Promise<Result> {
  let uid = c.id.userId, name = 'you'
  if (who) {
    if (!can(c.id, 'access.users.read')) throw forbidden('checking someone else\'s messages needs Logins and access')
    const u = await findUser(c, who)
    if (!u) return { key: 'messages', title: 'Messages not arriving', about: who, checks: [bad('An account uses this', `No account in this school signs in with "${who}".`)] }
    uid = u.id; name = u.full_name
  }
  const [u, push, recent, guardian] = await Promise.all([
    c.db.prepare(`SELECT email, phone, status FROM users WHERE id = ?`).bind(uid).first<{ email: string | null; phone: string | null; status: string }>(),
    c.db.prepare(`SELECT count(*) AS n, max(updated_at) AS at FROM push_tokens WHERE user_id = ?`).bind(uid).first<{ n: number; at: string | null }>(),
    c.db.prepare(`SELECT count(*) AS n, sum(read_at IS NULL) AS unread FROM notifications WHERE user_id = ? AND created_at >= ?`).bind(uid, new Date(Date.now() - 7 * 86_400_000).toISOString()).first<{ n: number; unread: number | null }>(),
    c.db.prepare(`SELECT g.phone FROM guardians g WHERE g.user_id = ? LIMIT 1`).bind(uid).first<{ phone: string | null }>(),
  ])
  const phone = u?.phone || guardian?.phone
  const checks: Check[] = [
    u?.status === 'active' ? ok('The account is active', 'Messages are addressed to it.') : bad('The account is active', 'A suspended account receives nothing.'),
    phone ? ok('A mobile number is on record', 'SMS and WhatsApp go to it.') : bad('A mobile number is on record', 'Without one, SMS and WhatsApp cannot reach them. Add it on the student\'s record, under Parents and guardians.'),
    (push?.n ?? 0) > 0 ? ok('The app can ring this phone', `Registered for notifications, last on ${String(push!.at).slice(0, 10)}.`)
      : bad('The app can ring this phone', 'No phone has the app installed and signed in, so notifications only show inside the app. Install the school\'s app and allow notifications.'),
    (recent?.n ?? 0) > 0 ? ok('Messages reached the app this week', `${recent!.n} in the last 7 days, ${recent!.unread ?? 0} not yet opened.`)
      : bad('Messages reached the app this week', 'Nothing was addressed to this account in the last 7 days. Check that the message was sent to their class or to them.'),
  ]
  return { key: 'messages', title: 'Messages not arriving', about: name, checks }
}

async function feeReceipt(c: Ctx, receipt: string): Promise<Result> {
  if (receipt) {
    if (!can(c.id, 'finance.invoices.read')) throw forbidden('looking up a receipt needs the fee screens')
    const p = await c.db.prepare(`SELECT receipt_no, amount_paise, status, paid_on, mode FROM payments WHERE receipt_no = ? COLLATE NOCASE LIMIT 1`).bind(receipt).first<{ receipt_no: string; amount_paise: number; status: string; paid_on: string; mode: string }>()
    if (!p) return { key: 'fee_receipt', title: 'Fee receipt', about: receipt, checks: [bad('The receipt exists', `No payment carries receipt ${receipt}. Search the student under Fees, Collections.`)] }
    return { key: 'fee_receipt', title: 'Fee receipt', about: receipt, checks: [
      ok('The receipt exists', `₹${(p.amount_paise / 100).toLocaleString('en-IN')} by ${p.mode} on ${p.paid_on}.`),
      p.status === 'success' ? ok('The payment went through', 'It counts towards the dues.') : bad('The payment went through', `Its status is ${p.status}. It does not count until it succeeds or is reconciled.`),
    ] }
  }
  const sc = await resolveScope(c)
  if (!sc.studentIds.length) return { key: 'fee_receipt', title: 'Fee receipts', about: 'your children', checks: [bad('A child is linked to your account', 'Receipts show for children linked to you. Ask the office to link your child.')] }
  const rows = await c.db.prepare(`SELECT s.first_name, (SELECT count(*) FROM payments p WHERE p.student_id = s.id AND p.status = 'success' AND p.paid_on >= date('now', '-120 days')) AS paid,
      (SELECT count(*) FROM payments p WHERE p.student_id = s.id AND p.status = 'success' AND p.receipt_no IS NULL) AS no_receipt,
      (SELECT count(*) FROM payments p WHERE p.student_id = s.id AND p.status NOT IN ('success') AND p.paid_on >= date('now', '-120 days')) AS pending
    FROM students s WHERE s.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(sc.studentIds)).all<{ first_name: string; paid: number; no_receipt: number; pending: number }>()
  const checks: Check[] = []
  for (const r of rows.results) {
    checks.push(r.paid > 0 ? ok(`Payments for ${r.first_name}`, `${r.paid} in the last four months, each with its receipt under Fees.`) : bad(`Payments for ${r.first_name}`, 'None recorded in the last four months. A payment made at the bank or online can take a day to appear; bring the bank reference to the office if it does not.'))
    if (r.pending) checks.push(bad(`Unconfirmed payment for ${r.first_name}`, `${r.pending} payment(s) not yet confirmed. The receipt appears once the office confirms it.`))
    if (r.no_receipt) checks.push(bad(`Receipt number for ${r.first_name}`, `${r.no_receipt} payment(s) have no receipt number yet. Report this; the office issues it.`))
  }
  return { key: 'fee_receipt', title: 'Fee receipts', about: 'your children', checks }
}

async function screen(c: Ctx, path: string): Promise<Result> {
  const m = /^\/([a-z_]+)\/([a-z0-9_]+)\/([a-z0-9_]+)/.exec(path)
  if (!m) throw badRequest('give the address of the screen, as /role/section/screen')
  const [, role, section, feature] = m
  const key = `${role}.${section}.${feature}`
  const cat = CATALOG_ROLES.find((r) => r.key === role)
  const sec = cat?.sections.find((s) => s.slug === section)
  const f = sec?.features.find((x) => x.slug === feature)
  if (!f) {
    const elsewhere = CATALOG_ROLES.flatMap((r) => r.sections.flatMap((s) => s.features.filter((x) => x.slug === feature).map(() => r.name)))
    return { key: 'screen', title: 'A screen is missing', about: path, checks: [bad('The screen exists', elsewhere.length
      ? `There is no such screen in this workspace. It exists for: ${[...new Set(elsewhere)].join(', ')}.` : 'No screen has that address. It may have been renamed: search for it by name.')] }
  }
  const ent = await entitlementFor(c)
  const mod = SECTION_MODULE[section]
  const checks: Check[] = [
    ok('The screen exists', `${f.name}, under ${sec!.name}.`),
    IMPLEMENTED_FEATURES.has(key) ? ok('It is built', 'It opens in this version of the app.') : bad('It is built', 'It is planned and not built yet, so it shows as "Not available yet".'),
    c.id.roles.includes(role) ? ok('You hold that role', cat!.name) : bad('You hold that role', `Your account does not hold the ${cat!.name} role. The office gives roles under Staff, Logins and access.`),
    c.id.permissions.has(key) ? ok('Your role includes it', 'Granted.') : bad('Your role includes it', 'Your role does not include this screen. The office can add it under Staff, Roles.'),
    !mod || ent.all || ent.modules.has(mod) ? ok("The school's plan includes it", ent.planName || 'Included.') : bad("The school's plan includes it", `${ent.planName || 'The plan'} does not include ${mod}. The school's administrator can ask XULO support about it.`),
  ]
  return { key: 'screen', title: 'A screen is missing', about: f.name, checks }
}

async function attendance(c: Ctx, day: string): Promise<Result> {
  const on = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : istToday()
  const sc = await resolveScope(c)
  const checks: Check[] = []
  if (sc.studentIds.length) {
    const rows = await c.db.prepare(`SELECT s.first_name, e.section_id,
        (SELECT a.status FROM student_attendance a WHERE a.student_id = s.id AND a.on_date = ? AND a.period_id IS NULL LIMIT 1) AS day_status,
        (SELECT count(*) FROM student_attendance a WHERE a.section_id = e.section_id AND a.on_date = ?) AS marked
      FROM students s LEFT JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
      WHERE s.id IN (SELECT value FROM json_each(?))`).bind(on, on, JSON.stringify(sc.studentIds)).all<{ first_name: string; section_id: string | null; day_status: string | null; marked: number }>()
    for (const r of rows.results) {
      if (!r.section_id) { checks.push(bad(`${r.first_name} is in a class`, 'Not enrolled in a section this year, so there is no register to mark. Ask the office.')); continue }
      checks.push(r.day_status ? ok(`${r.first_name} on ${on}`, `Marked ${r.day_status}.`)
        : r.marked ? bad(`${r.first_name} on ${on}`, 'The class register is marked but not for this child. Tell the class teacher.')
        : bad(`${r.first_name} on ${on}`, 'The class teacher has not marked the register for this day yet. It shows once they do.'))
    }
    return { key: 'attendance', title: 'Attendance not showing', about: on, checks }
  }
  if (sc.classTeacherOf.length) {
    const rows = await c.db.prepare(`SELECT sec.id, sec.name, (SELECT count(*) FROM student_attendance a WHERE a.section_id = sec.id AND a.on_date = ?) AS marked
      FROM sections sec WHERE sec.id IN (SELECT value FROM json_each(?))`).bind(on, JSON.stringify(sc.classTeacherOf)).all<{ id: string; name: string; marked: number }>()
    for (const r of rows.results) checks.push(r.marked ? ok(`Section ${r.name} on ${on}`, `${r.marked} marks saved.`) : bad(`Section ${r.name} on ${on}`, 'Not marked yet. Open Attendance, Take attendance, and press Save. A register saved offline is sent when the phone is back online.'))
    return { key: 'attendance', title: 'Attendance not showing', about: on, checks }
  }
  return { key: 'attendance', title: 'Attendance not showing', about: on, checks: [bad('A class or child to check', 'Your account has no child and no class of its own. Ask the office which register you are looking for.')] }
}

export function registerTroubleshooters(r: Router): void {
  r.get('/help/troubleshoot/{key}', 'auth', async (c) => {
    schoolUser(c)
    const q = c.url.searchParams
    const who = (q.get('who') ?? '').trim()
    let res: Result
    switch (c.params.key) {
      case 'sign_in': res = await signIn(c, who); break
      case 'messages': res = await messages(c, who); break
      case 'fee_receipt': res = await feeReceipt(c, (q.get('receipt') ?? '').trim()); break
      case 'screen': res = await screen(c, (q.get('route') ?? '').trim()); break
      case 'attendance': res = await attendance(c, (q.get('date') ?? '').trim()); break
      default: throw badRequest('unknown troubleshooter')
    }
    return new Response(JSON.stringify(res), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  })

  /* The one fix that is safe to make in one press: lifting a sign-in lock.
     The password is not touched; the person still has to know it. */
  r.post('/help/troubleshoot/sign_in/fix', 'access.users.write', async (c) => {
    schoolUser(c)
    const req = await readJSON<{ who?: string; action?: string }>(c.req)
    const who = String(req.who ?? '').trim()
    if (req.action !== 'unlock' || !who) throw badRequest('nothing to fix')
    if (!(await findUser(c, who))) throw badRequest('no account in this school signs in with that')
    await c.env.CONTROL.prepare(`DELETE FROM login_throttle WHERE key = ?`).bind('id:' + who.toLowerCase()).run()
    return new Response(JSON.stringify({ fixed: true }), { headers: { 'content-type': 'application/json; charset=utf-8' } })
  })
}
