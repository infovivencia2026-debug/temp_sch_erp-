import type { Router } from '../../router'
import { HttpError, badRequest, bool, created, now, ok, readJSON, uuid } from '../../http'
import { fullName, isUUIDish, isUniqueViolation, isYMD, istDate, nz, oneOfStr, placeholders, js, resolveRange, str, todayIST } from './util'
import { school } from '../school'

/* Port of the /admissions group's own handlers: the KPIs and the two lists in
   role_backoffice.go, and the funnel in admissions_funnel.go (sources, leads,
   the quota register, siblings, the waiting list, the RTE lottery, applicant
   messages, open days and the prospectus register). */

const READ = 'admissions.read', WRITE = 'admissions.write'
const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}
const applicationStatuses = ['draft', 'submitted', 'under_review', 'documents_pending', 'test_scheduled', 'interviewed', 'offered', 'accepted', 'rejected', 'withdrawn', 'waitlisted', 'on_hold']

export function registerAdmissionsFunnel(r: Router) {
  r.get('/admissions/dashboard', READ, async (c) => {
    const k = await c.db.prepare(`
      SELECT (SELECT count(*) FROM enquiries) AS enquiries,
             (SELECT count(*) FROM enquiries WHERE status = 'new') AS new_enquiries,
             (SELECT count(*) FROM applications) AS applications,
             (SELECT count(*) FROM applications WHERE status = 'draft') AS incomplete,
             (SELECT count(*) FROM applications WHERE status = 'offered') AS admitted,
             (SELECT count(*) FROM applications WHERE student_id IS NOT NULL) AS enrolled,
             (SELECT count(*) FROM enquiries WHERE next_follow_up IS NOT NULL AND next_follow_up <= ? AND status NOT IN ('applied','lost')) AS follow_ups_due`)
      .bind(todayIST()).first()
    return ok(k)
  })

  r.get('/admissions/enquiries', READ, async (c) => {
    const status = nz(c.url.searchParams.get('status'))
    const rows = await c.db.prepare(`
      SELECT e.id, e.student_name, e.parent_name, e.phone, e.source, e.status, e.next_follow_up, u.full_name AS assigned_to, ${istDate('e.created_at')} AS created_at
        FROM enquiries e LEFT JOIN users u ON u.id = e.assigned_to
       WHERE (? IS NULL OR e.status = ?) ORDER BY e.created_at DESC LIMIT 300`).bind(status, status).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.get('/admissions/applications', READ, async (c) => {
    const status = nz(c.url.searchParams.get('status')), fee = nz(c.url.searchParams.get('fee'))
    const rows = await c.db.prepare(`
      SELECT a.id, a.application_no, ${fullName('a.first_name', 'a.middle_name', 'a.last_name')} AS name, c.name AS class_sought,
             a.parent_name, a.parent_phone, a.is_rte, a.status, ${istDate('a.created_at')} AS created_at,
             a.form_fee_paise, ${istDate('a.form_fee_paid_at')} AS form_fee_paid_at,
             (SELECT count(*) FROM application_documents d WHERE d.application_id = a.id AND d.is_required = 1) AS docs_required,
             (SELECT count(*) FROM application_documents d WHERE d.application_id = a.id AND d.is_required = 1 AND d.status = 'verified') AS docs_verified,
             (SELECT count(*) FROM application_documents d WHERE d.application_id = a.id AND d.status = 'rejected') AS docs_rejected
        FROM applications a LEFT JOIN classes c ON c.id = a.class_sought
       WHERE (? IS NULL OR a.status = ?)
         AND (? IS NULL OR (? = 'unpaid' AND a.form_fee_paise IS NOT NULL AND a.form_fee_paid_at IS NULL) OR (? = 'paid' AND a.form_fee_paid_at IS NOT NULL))
       ORDER BY a.created_at DESC LIMIT 300`).bind(status, status, fee, fee, fee).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, is_rte: bool(v.is_rte) })) })
  })

  // --- where leads come from ---------------------------------------------------

  r.get('/admissions/sources', READ, async (c) => {
    const rng = resolveRange(c.url.searchParams)
    const rows = await c.db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(e.source), ''), 'Not recorded') AS source, count(*) AS enquiries, count(a.id) AS applied,
             SUM(CASE WHEN a.status IN ('offered','accepted') THEN 1 ELSE 0 END) AS offered,
             SUM(CASE WHEN a.status = 'accepted' THEN 1 ELSE 0 END) AS admitted
        FROM enquiries e LEFT JOIN applications a ON a.enquiry_id = e.id
       WHERE ${istDate('e.created_at')} BETWEEN ? AND ? GROUP BY 1 ORDER BY 2 DESC`).bind(rng.from, rng.to)
      .all<{ source: string; enquiries: number; applied: number; offered: number; admitted: number }>()
    return ok({ items: rows.results.map((v) => {
      const out: Record<string, unknown> = { ...v }
      if (v.enquiries >= 5) out.conversion_percent = 100 * v.admitted / v.enquiries
      return out
    }) })
  })

  r.get('/admissions/leads', READ, async (c) => {
    const q = c.url.searchParams
    const today = todayIST()
    const rows = await c.db.prepare(`
      SELECT e.id, e.student_name, e.parent_name, e.phone, c.name AS class_sought, e.source, e.campaign,
             NULLIF(TRIM(COALESCE(e.utm_source,'') || CASE WHEN e.utm_medium IS NULL THEN '' ELSE '/' || e.utm_medium END || CASE WHEN e.utm_campaign IS NULL THEN '' ELSE '/' || e.utm_campaign END, '/'), '') AS utm,
             e.status, u.full_name AS assigned_to, e.next_follow_up, ${istDate('e.created_at')} AS created_at,
             CAST(julianday(?) - julianday(COALESCE(e.last_contacted_at, e.created_at)) AS INTEGER) AS days_silent,
             (e.next_follow_up IS NOT NULL AND e.next_follow_up < ? AND e.status NOT IN ('converted','lost')) AS follow_up_overdue
        FROM enquiries e LEFT JOIN classes c ON c.id = e.class_sought LEFT JOIN users u ON u.id = e.assigned_to
       WHERE (? IS NULL OR e.status = ?) AND (? IS NULL OR e.assigned_to = ?) AND (? IS NOT 1 OR e.assigned_to IS NULL)
       ORDER BY (e.next_follow_up IS NOT NULL AND e.next_follow_up < ?) DESC, COALESCE(e.last_contacted_at, e.created_at) LIMIT 400`)
      .bind(now(), today, nz(q.get('status')), nz(q.get('status')), nz(q.get('assigned_to')), nz(q.get('assigned_to')), q.get('unassigned') === 'true' ? 1 : 0, today)
      .all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, follow_up_overdue: bool(v.follow_up_overdue) })) })
  })

  r.post('/admissions/leads/assign', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const raw = Array.isArray(req.ids) ? (req.ids as unknown[]) : []
    if (raw.length === 0) throw badRequest('choose at least one enquiry')
    const ids = raw.map((v) => { if (!isUUIDish(v)) throw badRequest('every id must be a uuid'); return v })
    const assigned = str(req.assigned_to), follow = str(req.next_follow_up), status = str(req.status), notes = str(req.notes)
    if (assigned !== '' && !isUUIDish(assigned)) throw badRequest('assigned_to must be a uuid')
    if (follow !== '' && !isYMD(follow)) throw badRequest('next_follow_up must be YYYY-MM-DD')
    const t = now()
    const res = await c.db.prepare(`
      UPDATE enquiries
         SET assigned_at = CASE WHEN NULLIF(?,'') IS NOT NULL AND NULLIF(?,'') IS NOT assigned_to THEN ? ELSE assigned_at END,
             assigned_to = COALESCE(NULLIF(?,''), assigned_to),
             next_follow_up = COALESCE(NULLIF(?,''), next_follow_up),
             last_contacted_at = CASE WHEN ? THEN ? ELSE last_contacted_at END,
             status = COALESCE(NULLIF(?,''), status),
             notes = CASE WHEN ? = '' THEN notes ELSE TRIM(COALESCE(notes || char(10), '') || ?) END,
             updated_at = ?
       WHERE id IN (${placeholders(ids.length)})`)
      .bind(assigned, assigned, t, assigned, follow, req.contacted ? 1 : 0, t, status, notes, notes, t, js(ids)).run()
    return ok({ updated: res.meta.changes })
  })

  // --- quota, siblings and the waiting list ------------------------------------

  r.get('/admissions/register', READ, async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(`
      SELECT a.id, a.application_no, ${fullName('a.first_name', 'a.last_name')} AS full_name, c.name AS class_sought,
             a.category, a.quota, a.rte_status, a.status, a.aadhaar_consent, a.apaar_id, a.prior_udise_code,
             NULLIF(${fullName('sib.first_name', 'sib.last_name')}, '') AS sibling, a.alumni_parent_name, a.waitlist_rank
        FROM applications a LEFT JOIN classes c ON c.id = a.class_sought LEFT JOIN students sib ON sib.id = a.sibling_student_id
       WHERE (? IS NULL OR a.quota = ?) AND (? IS NULL OR a.status = ?)
       ORDER BY a.quota, a.waitlist_rank IS NULL, a.waitlist_rank, a.application_no LIMIT 500`)
      .bind(nz(q.get('quota')), nz(q.get('quota')), nz(q.get('status')), nz(q.get('status'))).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const missing: string[] = []
      const rte = v.rte_status as string | null
      if (v.quota === 'rte' && (rte === null || rte === '')) missing.push('RTE status')
      if (v.quota === 'sibling' && v.sibling === null) missing.push('the sibling')
      if (v.quota === 'alumni' && v.alumni_parent_name === null) missing.push('the alumnus')
      if (!bool(v.aadhaar_consent)) missing.push('Aadhaar consent')
      if (v.apaar_id === null || v.apaar_id === '') missing.push('APAAR')
      return omitNull({ ...v, aadhaar_consent: bool(v.aadhaar_consent), missing })
    })
    const quotas = await c.db.prepare(`SELECT quota, count(*) AS applied,
        SUM(CASE WHEN status IN ('offered','accepted') THEN 1 ELSE 0 END) AS offered, SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS admitted
      FROM applications GROUP BY quota ORDER BY quota`).all<{ quota: string; applied: number; offered: number; admitted: number }>()
    let total = 0, rteAdmitted = 0
    for (const v of quotas.results) { total += v.admitted; if (v.quota === 'rte') rteAdmitted = v.admitted }
    return ok({ items, quotas: quotas.results, admitted_total: total, rte_admitted: rteAdmitted,
      rte_percent: total > 0 ? 100 * rteAdmitted / total : 0, rte_short_by: Math.max(0, Math.floor((total + 3) / 4) - rteAdmitted) })
  })

  r.post('/admissions/applications/patch', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const appID = str(req.id)
    if (!isUUIDish(appID)) throw badRequest('id must be a uuid')
    const quota = str(req.quota)
    if (quota !== '' && !oneOfStr(quota, 'general', 'rte', 'ews', 'sibling', 'alumni', 'staff', 'sports', 'management')) throw badRequest('unknown quota ' + quota)
    const gender = req.gender === undefined || req.gender === null ? null : str(req.gender)
    const category = req.category === undefined || req.category === null ? null : str(req.category)
    if (gender !== null && gender !== '' && !oneOfStr(gender, 'male', 'female', 'other')) throw badRequest('unknown gender ' + gender)
    if (category !== null && category !== '' && !oneOfStr(category, 'general', 'obc', 'sc', 'st', 'ews', 'other')) throw badRequest('unknown category ' + category)
    const classSought = str(req.class_sought)
    if (classSought !== '' && !isUUIDish(classSought)) throw badRequest('class_sought must be a uuid')
    const dob = req.date_of_birth === undefined || req.date_of_birth === null ? null : str(req.date_of_birth)
    if (dob !== null && dob !== '' && !isYMD(dob)) throw badRequest('date_of_birth must be YYYY-MM-DD')
    const lastName = req.last_name === undefined || req.last_name === null ? null : str(req.last_name)
    const parentEmail = req.parent_email === undefined || req.parent_email === null ? null : str(req.parent_email)
    const aadhaar = typeof req.aadhaar_consent === 'boolean' ? (req.aadhaar_consent ? 1 : 0) : null
    const rank = typeof req.waitlist_rank === 'number' ? req.waitlist_rank : null
    const sibling = str(req.sibling_student_id)
    if (sibling !== '' && !isUUIDish(sibling)) throw badRequest('sibling_student_id must be a uuid')

    // The one-rank-per-class index was partial in Postgres; asked by hand here.
    if (rank !== null) {
      const taken = await c.db.prepare(`SELECT 1 FROM applications x WHERE x.waitlist_rank = ? AND x.id <> ? AND x.status = 'waitlisted'
          AND x.class_sought = COALESCE(NULLIF(?,''), (SELECT class_sought FROM applications WHERE id = ?)) LIMIT 1`).bind(rank, appID, classSought, appID).first()
      if (taken) throw new HttpError(409, 'another applicant already holds that place on the waiting list', { code: 'rank_taken' })
    }
    // applications_visa_dated: a foreign applicant with a passport on file needs the visa expiry too.
    const cur = await c.db.prepare(`SELECT passport_no, visa_expiry, nationality FROM applications WHERE id = ?`).bind(appID)
      .first<{ passport_no: string | null; visa_expiry: string | null; nationality: string }>()
    if (cur) {
      const passport = nz(req.passport_no) ?? cur.passport_no
      const visa = nz(req.visa_expiry) ?? cur.visa_expiry
      const nationality = nz(req.nationality) ?? cur.nationality
      if (passport !== null && visa === null && nationality !== 'Indian') throw badRequest('a foreign applicant with a passport on file needs the visa expiry too')
    }
    await c.db.prepare(`
      UPDATE applications SET
        quota = COALESCE(NULLIF(?,''), quota), rte_status = COALESCE(NULLIF(?,''), rte_status), aadhaar_consent = COALESCE(?, aadhaar_consent),
        aadhaar_last4 = COALESCE(NULLIF(?,''), aadhaar_last4), apaar_id = COALESCE(NULLIF(?,''), apaar_id), prior_udise_code = COALESCE(NULLIF(?,''), prior_udise_code),
        sibling_student_id = COALESCE(NULLIF(?,''), sibling_student_id), alumni_parent_name = COALESCE(NULLIF(?,''), alumni_parent_name),
        medical_conditions = COALESCE(NULLIF(?,''), medical_conditions), allergies = COALESCE(NULLIF(?,''), allergies), immunisation_upto = COALESCE(NULLIF(?,''), immunisation_upto),
        blood_group = COALESCE(NULLIF(?,''), blood_group), nationality = COALESCE(NULLIF(?,''), nationality), passport_no = COALESCE(NULLIF(?,''), passport_no),
        visa_type = COALESCE(NULLIF(?,''), visa_type), visa_expiry = COALESCE(NULLIF(?,''), visa_expiry), waitlist_rank = COALESCE(?, waitlist_rank),
        first_name = COALESCE(NULLIF(?,''), first_name), class_sought = COALESCE(NULLIF(?,''), class_sought),
        parent_name = COALESCE(NULLIF(?,''), parent_name), parent_phone = COALESCE(NULLIF(?,''), parent_phone),
        last_name = CASE WHEN ? IS NULL THEN last_name ELSE NULLIF(?,'') END,
        date_of_birth = CASE WHEN ? IS NULL THEN date_of_birth ELSE NULLIF(?,'') END,
        gender = CASE WHEN ? IS NULL THEN gender ELSE NULLIF(?,'') END,
        category = CASE WHEN ? IS NULL THEN category ELSE NULLIF(?,'') END,
        parent_email = CASE WHEN ? IS NULL THEN parent_email ELSE NULLIF(?,'') END,
        updated_at = ?
      WHERE id = ?`)
      .bind(quota, str(req.rte_status), aadhaar, str(req.aadhaar_last4), str(req.apaar_id), str(req.prior_udise_code), sibling, str(req.alumni_parent_name),
        str(req.medical_conditions), str(req.allergies), str(req.immunisation_upto), str(req.blood_group), str(req.nationality), str(req.passport_no),
        str(req.visa_type), str(req.visa_expiry), rank, str(req.first_name), classSought, str(req.parent_name), str(req.parent_phone),
        lastName, lastName, dob, dob, gender, gender, category, category, parentEmail, parentEmail, now(), appID).run()
    return ok({ id: appID })
  })

  r.get('/admissions/siblings', READ, async (c) => {
    const appID = c.url.searchParams.get('application_id') ?? ''
    if (!isUUIDish(appID)) throw badRequest('application_id must be a uuid')
    const rows = await c.db.prepare(`
      SELECT st.id AS student_id, ${fullName('st.first_name', 'st.last_name')} AS full_name, st.admission_no AS admission_no, COALESCE(c.name, '-') AS class_name,
             CASE WHEN g.phone = a.parent_phone THEN 'same guardian phone' ELSE 'same parent name' END AS matched_on
        FROM applications a
        JOIN students st ON st.institution_id = a.institution_id AND st.status = 'active'
        LEFT JOIN student_guardians sg ON sg.student_id = st.id
        LEFT JOIN guardians g ON g.id = sg.guardian_id
        LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
        LEFT JOIN sections sec ON sec.id = en.section_id
        LEFT JOIN classes c ON c.id = sec.class_id
       WHERE a.id = ?
         AND ((a.parent_phone IS NOT NULL AND g.phone = a.parent_phone)
           OR (a.parent_name IS NOT NULL AND g.full_name IS NOT NULL AND lower(g.full_name) = lower(a.parent_name)))
       GROUP BY st.id, st.first_name, st.last_name, st.admission_no, c.name, g.phone, a.parent_phone LIMIT 20`).bind(appID).all()
    return ok({ items: rows.results })
  })

  r.post('/admissions/waitlist/promote', WRITE, async (c) => {
    const req = await readJSON(c.req)
    let seats = typeof req.seats === 'number' ? req.seats : 0
    if (seats <= 0) seats = 1
    const classID = str(req.class_id)
    if (!isUUIDish(classID)) throw badRequest('class_id must be a uuid')
    const next = await c.db.prepare(`SELECT id, ${fullName('first_name', 'last_name')} AS name FROM applications WHERE class_sought = ? AND status = 'waitlisted'
        ORDER BY waitlist_rank IS NULL, waitlist_rank, created_at LIMIT ?`).bind(classID, seats).all<{ id: string; name: string }>()
    if (next.results.length > 0) {
      const t = now()
      await c.db.batch(next.results.map((a) => c.db.prepare(`UPDATE applications SET status = 'offered', waitlist_rank = NULL, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
        .bind(c.id.userId, t, t, a.id)))
    }
    // The offer email (notifyApplicationStage) is a side effect the worker does not send: emailed is 0.
    return ok({ promoted: next.results.map((a) => a.name), count: next.results.length, emailed: 0 })
  })

  r.post('/admissions/rte/import', WRITE, async (c) => {
    let file: { text(): Promise<string> } | null = null
    try {
      const form = await c.req.formData()
      const f = form.get('file') as unknown
      if (f && typeof f === 'object' && typeof (f as { text?: unknown }).text === 'function') file = f as { text(): Promise<string> }
    } catch { /* not multipart */ }
    if (!file) throw badRequest("attach the state's allotment list as a CSV")
    const text = await file.text()
    const records = text.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => l.split(',').map((x) => x.replace(/^"|"$/g, '')))
    if (records.length < 2) throw badRequest('that file has no rows under its header')
    let matched = 0
    const unmatched: string[] = []
    const t = now()
    for (let i = 1; i < records.length; i++) {
      const rec = records[i]
      const appNo = (rec[0] ?? '').trim()
      if (appNo === '') continue
      let status = 'selected'
      if (rec.length > 1 && rec[1].trim() !== '') status = rec[1].trim().toLowerCase()
      if (!oneOfStr(status, 'applied', 'eligible', 'selected', 'rejected')) status = 'selected'
      const res = await c.db.prepare(`UPDATE applications SET rte_status = ?, quota = 'rte', is_rte = 1, updated_at = ? WHERE application_no = ?`).bind(status, t, appNo).run()
      if (res.meta.changes === 0) unmatched.push(appNo); else matched++
    }
    return ok({ matched, unmatched, rows: records.length - 1 })
  })

  r.post('/admissions/message', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const message = str(req.message).trim()
    if (message === '') throw badRequest('say what they are being told')
    const raw = Array.isArray(req.ids) ? (req.ids as unknown[]) : []
    const ids = raw.map((v) => { if (!isUUIDish(v)) throw badRequest('every id must be a uuid'); return v })
    if (ids.length === 0) throw badRequest('choose at least one applicant')
    const status = str(req.status)
    if (status !== '' && !applicationStatuses.includes(status)) throw badRequest('unknown status ' + status)
    const hold = str(req.hold_reason).trim()
    if (status === 'on_hold' && hold === '') {
      throw badRequest('say what is being waited on, the fee, a concession decision, a document. Whoever picks this up will not have been in the room')
    }
    const notSent: { id: string; name?: string; reason: string }[] = []
    const t = now()
    for (const appID of ids) {
      const f = await c.db.prepare(`SELECT ${fullName('first_name', 'last_name')} AS name FROM applications WHERE id = ?`).bind(appID).first<{ name: string }>()
      if (!f) { notSent.push({ id: appID, reason: 'no such application' }); continue }
      if (status !== '') {
        await c.db.prepare(`UPDATE applications SET status = ?, updated_at = ?,
            hold_reason = CASE WHEN ? = 'on_hold' THEN NULLIF(?,'') ELSE NULL END,
            held_at = CASE WHEN ? = 'on_hold' THEN ? ELSE NULL END,
            held_by = CASE WHEN ? = 'on_hold' THEN ? ELSE NULL END WHERE id = ?`)
          .bind(status, t, status, hold, status, t, status, c.id.userId, appID).run()
      }
      /* The send (notifyApplicant, email) is a side effect the worker does not perform, and the
         Go handler records a remark only where a message actually went: nothing is recorded. */
      notSent.push({ id: appID, name: f.name, reason: 'email sending is not available in the worker' })
    }
    return ok({ messaged: 0, sent: 0, not_sent: notSent, note: 'Some applicants could not be emailed and were not recorded as told. They are listed in not_sent.' })
  })

  // --- open days ------------------------------------------------------------------

  r.get('/admissions/open-days', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT ev.id, ev.name, ev.on_date, ev.venue, ev.is_published,
             (SELECT count(*) FROM admission_event_slots s2 WHERE s2.event_id = ev.id) AS slots,
             COALESCE((SELECT sum(capacity) FROM admission_event_slots s2 WHERE s2.event_id = ev.id), 0) AS capacity,
             (SELECT count(*) FROM admission_event_bookings b JOIN admission_event_slots s3 ON s3.id = b.slot_id WHERE s3.event_id = ev.id) AS booked,
             (SELECT count(*) FROM admission_event_bookings b JOIN admission_event_slots s3 ON s3.id = b.slot_id WHERE s3.event_id = ev.id AND b.attended_at IS NOT NULL) AS attended,
             COALESCE((SELECT sum(b.children) FROM admission_event_bookings b JOIN admission_event_slots s3 ON s3.id = b.slot_id WHERE s3.event_id = ev.id), 0) AS parents
        FROM admission_events ev ORDER BY ev.on_date DESC LIMIT 50`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, is_published: bool(v.is_published) })) })
  })

  r.post('/admissions/open-days', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const name = str(req.name), onDate = str(req.on_date)
    if (name.trim() === '' || onDate === '') throw badRequest('an open day needs a name and a date')
    if (!isYMD(onDate)) throw badRequest('on_date must be YYYY-MM-DD')
    let capacity = typeof req.capacity === 'number' ? req.capacity : 0
    if (capacity <= 0) capacity = 25
    const id = uuid(), inst = school(c).id
    const stmts = [c.db.prepare(`INSERT INTO admission_events (id, institution_id, name, on_date, venue, is_published, created_at) VALUES (?,?,?,?,NULLIF(?,''),?,?)`)
      .bind(id, inst, name, onDate, str(req.venue), req.is_published ? 1 : 0, now())]
    for (const t of (Array.isArray(req.slot_times) ? (req.slot_times as unknown[]) : [])) {
      const s = str(t).trim()
      if (s === '') continue
      stmts.push(c.db.prepare(`INSERT OR IGNORE INTO admission_event_slots (id, institution_id, event_id, starts_at, capacity) VALUES (?,?,?,?,?)`).bind(uuid(), inst, id, s, capacity))
    }
    try { await c.db.batch(stmts) } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return created({ id })
  })

  r.get('/admissions/open-days/{id}/slots', READ, async (c) => {
    if (!isUUIDish(c.params.id)) throw badRequest('invalid event id')
    const rows = await c.db.prepare(`
      SELECT sl.id, substr(sl.starts_at, 1, 5) AS starts_at, sl.minutes, sl.capacity,
             (SELECT count(*) FROM admission_event_bookings bb WHERE bb.slot_id = sl.id) AS booked,
             MAX(0, sl.capacity - (SELECT count(*) FROM admission_event_bookings bb WHERE bb.slot_id = sl.id)) AS places_left
        FROM admission_event_slots sl WHERE sl.event_id = ? ORDER BY sl.starts_at`).bind(c.params.id).all()
    return ok({ items: rows.results })
  })

  r.get('/admissions/open-days/{id}/bookings', READ, async (c) => {
    if (!isUUIDish(c.params.id)) throw badRequest('invalid event id')
    const rows = await c.db.prepare(`
      SELECT b.id, substr(sl.starts_at, 1, 5) AS starts_at, b.parent_name, b.phone, b.children, (b.attended_at IS NOT NULL) AS attended
        FROM admission_event_bookings b JOIN admission_event_slots sl ON sl.id = b.slot_id
       WHERE sl.event_id = ? ORDER BY sl.starts_at, b.created_at`).bind(c.params.id).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({ ...v, attended: bool(v.attended) })) })
  })

  r.post('/admissions/open-days/book', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const bookingID = str(req.booking_id)
    if (bookingID !== '') {
      if (!isUUIDish(bookingID)) throw badRequest('booking_id must be a uuid')
      await c.db.prepare(`UPDATE admission_event_bookings SET attended_at = ? WHERE id = ?`).bind(now(), bookingID).run()
      return ok({ attended: true })
    }
    const slot = str(req.slot_id)
    if (!isUUIDish(slot)) throw badRequest('slot_id must be a uuid')
    const parent = str(req.parent_name), phone = str(req.phone)
    if (parent.trim() === '' || phone.trim() === '') throw badRequest('a booking needs a name and a phone number')
    let children = typeof req.children === 'number' ? req.children : 0
    if (children <= 0) children = 1
    const enquiry = str(req.enquiry_id)
    if (enquiry !== '' && !isUUIDish(enquiry)) throw badRequest('enquiry_id must be a uuid')
    const full = await c.db.prepare(`SELECT ((SELECT count(*) FROM admission_event_bookings b WHERE b.slot_id = ?) >= sl.capacity) AS full FROM admission_event_slots sl WHERE sl.id = ?`)
      .bind(slot, slot).first<{ full: number }>()
    if (!full) throw badRequest('no such slot')
    if (full.full) throw new HttpError(409, 'that slot is full. Offer them another time', { code: 'slot_full' })
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO admission_event_bookings (id, institution_id, slot_id, enquiry_id, parent_name, phone, children, created_at) VALUES (?,?,?,NULLIF(?,''),?,?,?,?)`)
        .bind(id, school(c).id, slot, enquiry, parent, phone, children, now()).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'that number is already booked into this slot', { code: 'already_booked' })
      throw badRequest(e instanceof Error ? e.message : String(e))
    }
    return created({ id })
  })

  // --- prospectus ------------------------------------------------------------------

  r.get('/admissions/prospectus', READ, async (c) => {
    const rng = resolveRange(c.url.searchParams)
    const rows = await c.db.prepare(`
      SELECT p.id, p.receipt_no, p.on_date, p.buyer_name, p.phone, c.name AS class_sought, p.kind, p.quantity, p.amount_paise, p.mode, u.full_name AS sold_by
        FROM prospectus_sales p LEFT JOIN classes c ON c.id = p.class_sought LEFT JOIN users u ON u.id = p.sold_by
       WHERE p.on_date BETWEEN ? AND ? ORDER BY p.on_date DESC, p.receipt_no DESC LIMIT 400`).bind(rng.from, rng.to).all<Record<string, unknown>>()
    const s = await c.db.prepare(`SELECT COALESCE((SELECT sum(quantity) FROM prospectus_stock), 0) AS received, COALESCE((SELECT sum(quantity) FROM prospectus_sales), 0) AS sold,
        COALESCE((SELECT sum(amount_paise) FROM prospectus_sales WHERE on_date BETWEEN ? AND ?), 0) AS takings`).bind(rng.from, rng.to)
      .first<{ received: number; sold: number; takings: number }>()
    return ok({ items: rows.results.map(omitNull), received: s!.received, sold: s!.sold, in_stock: s!.received - s!.sold, takings_paise: s!.takings })
  })

  r.post('/admissions/prospectus', WRITE, async (c) => {
    const req = await readJSON(c.req)
    let kind = str(req.kind)
    if (kind === '') kind = 'prospectus'
    const stockQty = typeof req.stock_quantity === 'number' ? req.stock_quantity : 0
    const today = todayIST()
    if (stockQty > 0) {
      const unit = typeof req.unit_cost_paise === 'number' && req.unit_cost_paise !== 0 ? req.unit_cost_paise : null
      await c.db.prepare(`INSERT INTO prospectus_stock (id, institution_id, kind, received_on, quantity, unit_cost_paise) VALUES (?,?,?,?,?,?)`)
        .bind(uuid(), school(c).id, kind, today, stockQty, unit).run()
      return created({ received: stockQty })
    }
    const buyer = str(req.buyer_name)
    if (buyer.trim() === '') throw badRequest('who bought it')
    let quantity = typeof req.quantity === 'number' ? req.quantity : 0
    if (quantity <= 0) quantity = 1
    let mode = str(req.mode)
    if (mode === '') mode = 'cash'
    const amount = typeof req.amount_paise === 'number' ? req.amount_paise : 0
    const classID = str(req.class_sought), enquiry = str(req.enquiry_id)
    if (classID !== '' && !isUUIDish(classID)) throw badRequest('class_sought must be a uuid')
    if (enquiry !== '' && !isUUIDish(enquiry)) throw badRequest('enquiry_id must be a uuid')
    const inst = school(c).id
    const year = today.slice(0, 4)
    // Gapless within the year: the next number after the highest receipt of this year.
    const last = await c.db.prepare(`SELECT COALESCE(max(CAST(substr(receipt_no, length('PR/' || ? || '/') + 1) AS INTEGER)), 0) AS n FROM prospectus_sales WHERE institution_id = ? AND receipt_no LIKE 'PR/' || ? || '/%'`)
      .bind(year, inst, year).first<{ n: number }>()
    const receipt = `PR/${year}/${String((last?.n ?? 0) + 1).padStart(4, '0')}`
    try {
      await c.db.prepare(`INSERT INTO prospectus_sales (id, institution_id, receipt_no, on_date, buyer_name, phone, class_sought, enquiry_id, kind, quantity, amount_paise, mode, sold_by)
        VALUES (?,?,?,?,?,NULLIF(?,''),NULLIF(?,''),NULLIF(?,''),?,?,?,?,?)`)
        .bind(uuid(), inst, receipt, today, buyer, str(req.phone), classID, enquiry, kind, quantity, amount, mode, c.id.userId).run()
    } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return created({ receipt_no: receipt })
  })
}

