import type { Ctx, Router } from '../../router'
import { Messenger, MessagingError, scopeOf } from '../../services/messaging'
import { HttpError, badRequest, bool, clampInt, created, notFound, now, ok, readJSON, uuid } from '../../http'
import { fullName, isUUIDish, isYMD, mergeModuleConfig, moduleConfig, nextNumber, nz, oneOfStr, placeholders, js, str, todayIST, workingYear, workingYearSQL } from './util'
import { can } from '../../identity'
import { syncTransportFeeComponent } from '../ops/transport_office'

/* Port of the /admissions/workflow group: mod_admissions.go (enquiry ->
   application -> assessment -> merit -> seat -> offer -> enrolment),
   admission_fees.go, admission_documents.go, admissions_stages.go,
   admission_approval.go and applicant_messages.go. */

const READ = 'admissions.read', WRITE = 'admissions.write'
const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}
const enquirySources = ['walk_in', 'phone', 'website', 'referral', 'campaign', 'other']
const defaultChecklist: { type: string; required: boolean }[] = [
  { type: 'Birth certificate', required: true }, { type: 'Aadhaar card', required: true }, { type: 'Passport photograph', required: true },
  { type: 'Address proof', required: true }, { type: 'Transfer certificate', required: false }, { type: 'Previous report card', required: false },
  { type: 'Caste certificate', required: false }, { type: 'Income certificate', required: false }, { type: 'Medical / immunisation record', required: false },
]
const admissionApprovalKey = 'enrolment_needs_approval'

async function admissionApprovalRequired(db: D1Database): Promise<boolean> {
  const cfg = await moduleConfig(db, 'admissions')
  return cfg[admissionApprovalKey] === 'true' || cfg[admissionApprovalKey] === true
}

/** Seeds the paperwork checklist for one application (idempotent on (application_id, doc_type)). */
async function checklistStmts(db: D1Database, inst: string, appID: string): Promise<D1PreparedStatement[]> {
  const have = await db.prepare(`SELECT doc_type FROM application_documents WHERE application_id = ?`).bind(appID).all<{ doc_type: string }>()
  const seen = new Set(have.results.map((d) => d.doc_type))
  const t = now()
  return defaultChecklist.filter((d) => !seen.has(d.type)).map((d) =>
    db.prepare(`INSERT INTO application_documents (id, institution_id, application_id, doc_type, is_required, status, created_at, updated_at) VALUES (?,?,?,?,?,'pending',?,?)`)
      .bind(uuid(), inst, appID, d.type, d.required ? 1 : 0, t, t))
}

/** assign_person_code trigger: S + six digits, unique within the school. */
async function studentPersonCode(db: D1Database, inst: string): Promise<string> {
  for (;;) {
    const candidate = 'S' + String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
    const taken = await db.prepare(`SELECT 1 FROM students WHERE institution_id = ? AND person_code = ?`).bind(inst, candidate).first()
    if (!taken) return candidate
  }
}

export function registerAdmissionsWorkflow(r: Router) {
  r.get('/admissions/workflow/merit', READ, async (c) => {
    const q = c.url.searchParams
    const testWeight = clampInt(q.get('test_weight'), 70, 0, 100)
    const interviewWeight = 100 - testWeight
    const classID = nz(q.get('class_id'))
    const rows = await c.db.prepare(`
      WITH scored AS (
        SELECT a.id, a.application_no, ${fullName('a.first_name', 'a.middle_name', 'a.last_name')} AS name, c.name AS class_name, a.category, a.is_rte, a.status,
               (SELECT round(100.0 * max(CAST(aa.score AS REAL)) / NULLIF(max(CAST(aa.max_score AS REAL)), 0), 2) FROM admission_assessments aa WHERE aa.application_id = a.id AND aa.kind = 'entrance_test') AS test_pct,
               (SELECT round(100.0 * max(CAST(aa.score AS REAL)) / NULLIF(max(CAST(aa.max_score AS REAL)), 0), 2) FROM admission_assessments aa WHERE aa.application_id = a.id AND aa.kind = 'interview') AS int_pct
          FROM applications a LEFT JOIN classes c ON c.id = a.class_sought
         WHERE (? IS NULL OR a.class_sought = ?) AND a.status NOT IN ('rejected','withdrawn'))
      SELECT id AS application_id, application_no, name, class_name AS class_sought, category, is_rte, test_pct AS test_percent, int_pct AS interview_percent,
             round(COALESCE(test_pct,0) * ? / 100.0 + COALESCE(int_pct,0) * ? / 100.0, 2) AS merit_score,
             rank() OVER (ORDER BY COALESCE(test_pct,0) * ? / 100.0 + COALESCE(int_pct,0) * ? / 100.0 DESC) AS rank, status
        FROM scored ORDER BY merit_score DESC, application_no`)
      .bind(classID, classID, testWeight, interviewWeight, testWeight, interviewWeight).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, is_rte: bool(v.is_rte) })) })
  })

  r.get('/admissions/workflow/seats', READ, async (c) => {
    const explicit = nz((c.url.searchParams.get('academic_year_id') ?? '').trim())
    const rows = await c.db.prepare(`
      WITH yr AS (SELECT COALESCE(?, ${workingYearSQL}) AS id)
      SELECT c.id AS class_id, c.name AS class_name,
             COALESCE(sum(sec.capacity), 0) AS capacity,
             (SELECT count(*) FROM enrollments e WHERE e.class_id = c.id AND e.status = 'active' AND e.academic_year_id = (SELECT id FROM yr)) AS enrolled,
             (SELECT count(*) FROM applications a LEFT JOIN admission_sessions ss ON ss.id = a.admission_session_id
               WHERE a.class_sought = c.id AND a.status IN ('offered','accepted') AND COALESCE(ss.academic_year_id, (SELECT id FROM yr)) = (SELECT id FROM yr)) AS offered,
             MAX(0, COALESCE(sum(sec.capacity),0)
               - (SELECT count(*) FROM enrollments e WHERE e.class_id = c.id AND e.status='active' AND e.academic_year_id = (SELECT id FROM yr))
               - (SELECT count(*) FROM applications a LEFT JOIN admission_sessions ss ON ss.id = a.admission_session_id
                   WHERE a.class_sought = c.id AND a.status IN ('offered','accepted') AND COALESCE(ss.academic_year_id, (SELECT id FROM yr)) = (SELECT id FROM yr))) AS available,
             (COALESCE(sum(sec.capacity),0) / 4) AS rte_quota,
             (SELECT count(*) FROM students st JOIN enrollments e2 ON e2.student_id = st.id AND e2.class_id = c.id AND e2.academic_year_id = (SELECT id FROM yr) WHERE st.is_rte = 1) AS rte_filled
        FROM classes c LEFT JOIN sections sec ON sec.class_id = c.id AND sec.academic_year_id = (SELECT id FROM yr)
       GROUP BY c.id ORDER BY c.level`).bind(explicit, c.id.userId).all()
    return ok({ items: rows.results })
  })

  r.get('/admissions/workflow/funnel', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT 'Enquiries' AS stage, count(*) AS count FROM enquiries
      UNION ALL SELECT 'Applications received', count(*) FROM applications
      UNION ALL SELECT 'Assessed', count(DISTINCT application_id) FROM admission_assessments
      UNION ALL SELECT 'Offered or accepted', count(*) FROM applications WHERE status IN ('offered','accepted')
      UNION ALL SELECT 'Enrolled', count(*) FROM applications WHERE student_id IS NOT NULL`).all()
    return ok({ items: rows.results })
  })

  r.post('/admissions/workflow/enquiries', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const studentName = str(req.student_name), phone = str(req.phone)
    if (studentName.trim() === '' || phone.trim() === '') throw badRequest('student_name and phone are required')
    let source = str(req.source)
    if (source === '') source = 'walk_in'
    if (!enquirySources.includes(source)) throw badRequest('source must be one of: ' + enquirySources.join(', '))
    let classSought = nz(req.class_sought)
    if (classSought !== null && !isUUIDish(classSought.trim())) {
      const resolved = await c.db.prepare(`SELECT id FROM classes WHERE lower(name) = lower(?)`).bind(classSought.trim()).first<{ id: string }>()
      if (!resolved) throw badRequest('class_sought must be a class id or the name of a class this school runs')
      classSought = resolved.id
    }
    const campus = await c.db.prepare(`SELECT id FROM campuses ORDER BY created_at LIMIT 1`).first<{ id: string }>()
    if (!campus) throw badRequest('this school has no campus yet')
    const assigned = nz(req.assigned_to)
    if (assigned !== null && !isUUIDish(assigned)) throw badRequest('assigned_to must be a uuid')
    const follow = nz(req.next_follow_up)
    if (follow !== null && !isYMD(follow)) throw badRequest('next_follow_up must be YYYY-MM-DD')
    const id = uuid(), t = now()
    await c.db.prepare(`INSERT INTO enquiries (id, institution_id, campus_id, student_name, parent_name, phone, email, class_sought, source, campaign, next_follow_up, notes, assigned_to, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`)
      .bind(id, c.id.institution!.id, campus.id, studentName, nz(req.parent_name), phone, nz(req.email), classSought, source, nz(req.campaign), follow, nz(req.notes), assigned, t, t).run()
    /* sendEnquiryApplicationLink: the open form's link on WhatsApp, SMS and email; a channel that
       could not be queued is named, never a failed enquiry. The family's watch-it login
       (issueEnquiryLogin) is not issued by the worker. */
    const linkFailed = await sendEnquiryLink(c, id, studentName, str(req.parent_name), phone, str(req.email))
    return created({ id, status: 'new', link_not_sent: linkFailed,
      parent_login: { note: 'parent login is not issued by the worker' } })
  })

  r.put('/admissions/workflow/enquiries/{id}', WRITE, async (c) => {
    if (!isUUIDish(c.params.id)) throw badRequest('invalid enquiry id')
    const req = await readJSON(c.req)
    const status = str(req.status)
    if (!['new', 'contacted', 'visit_scheduled', 'applied', 'lost'].includes(status)) throw badRequest('invalid status: ' + status)
    const lost = str(req.lost_reason)
    if (status === 'lost' && lost.trim() === '') throw badRequest('lost_reason is required when marking an enquiry lost')
    let notes = str(req.notes)
    if (lost !== '') notes = (notes + '\nLost: ' + lost).trim()
    const follow = nz(req.next_follow_up)
    if (follow !== null && !isYMD(follow)) throw badRequest('next_follow_up must be YYYY-MM-DD')
    const res = await c.db.prepare(`UPDATE enquiries SET status = ?, next_follow_up = COALESCE(?, next_follow_up),
        notes = CASE WHEN ? IS NULL THEN notes ELSE COALESCE(notes || char(10), '') || ? END, updated_at = ? WHERE id = ?`)
      .bind(status, follow, nz(notes), nz(notes), now(), c.params.id).run()
    if (res.meta.changes === 0) throw notFound()
    return ok({ id: c.params.id, status })
  })

  r.post('/admissions/workflow/applicant-messages', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const ids = Array.isArray(req.application_ids) ? (req.application_ids as unknown[]) : []
    if (ids.length === 0) throw badRequest('choose at least one applicant to write to')
    const kind = str(req.kind)
    if (!['offer', 'documents', 'test', 'regret'].includes(kind)) throw badRequest('that is not one of the messages this office sends')
    if ((kind === 'documents' || kind === 'test') && str(req.detail).trim() === '') {
      throw badRequest('say which documents, or when the test is. Without it the message only tells the family to come and ask')
    }
    const channel = str(req.channel).trim() || 'sms'
    const detail = str(req.detail).trim()
    const school = (await c.db.prepare(`SELECT name FROM institutions LIMIT 1`).first<{ name: string }>())?.name ?? ''
    const idList = ids.map((x) => String(x))
    const list = idList.length ? (await c.db.prepare(`SELECT a.id, a.application_no AS no, trim(COALESCE(a.first_name,'') || ' ' || COALESCE(a.last_name,'')) AS child,
        a.parent_name AS parent, a.parent_phone AS phone, COALESCE(a.parent_email, '') AS email, COALESCE(cl.name, '') AS class
        FROM applications a LEFT JOIN classes cl ON cl.id = a.class_sought WHERE a.id IN (${placeholders(idList.length)})`).bind(js(idList))
      .all<{ id: string; no: string; child: string; parent: string | null; phone: string | null; email: string; class: string }>()).results : []
    const out = { sent: 0, skipped: [] as string[] }
    const ms = new Messenger(scopeOf(c))
    for (const t of list) {
      const to = (channel === 'email' ? t.email : t.phone) ?? ''
      if (to.trim() === '') { out.skipped.push(`${t.no} ${t.child}, no ${channel === 'email' ? 'email address' : 'phone number'} on the application`); continue }
      try {
        const res = await ms.queue({ channel, template_code: 'admissions.' + kind, recipient: to,
          vars: { parent: t.parent ?? '', child: t.child, class: t.class, school, application_no: t.no, detail },
          source_kind: 'admission_' + kind, source_id: t.id, occurrence_key: detail })
        if (res.duplicate) { out.skipped.push(`${t.no} ${t.child}, already told this`); continue }
        out.sent++
      } catch (e) { out.skipped.push(`${t.no} ${t.child} - ${(e as Error).message}`) }
    }
    await ms.kick()
    return ok(out)
  })

  r.get('/admissions/workflow/applications/{id}/fees', READ, async (c) => {
    const appID = c.params.id
    const out: Record<string, unknown> = { instalment_no: 1, lines: [] as unknown[], total_paise: 0, priced: false }
    const fs = await c.db.prepare(`
      SELECT fs.id AS structure_id, fs.name AS structure_name, c.name AS class_name
        FROM applications a JOIN classes c ON c.id = a.class_sought
        JOIN fee_structures fs ON fs.is_active = 1 AND (fs.class_id = a.class_sought OR fs.class_id IS NULL)
       WHERE a.id = ? ORDER BY (fs.class_id IS NOT NULL) DESC, fs.created_at DESC LIMIT 1`).bind(appID)
      .first<{ structure_id: string; structure_name: string; class_name: string }>()
    if (!fs) {
      const cls = await c.db.prepare(`SELECT c.name FROM applications a JOIN classes c ON c.id = a.class_sought WHERE a.id = ?`).bind(appID).first<{ name: string }>()
      if (cls) out.class_name = cls.name
      return ok(out)
    }
    out.fee_structure_id = fs.structure_id; out.fee_structure_name = fs.structure_name; out.class_name = fs.class_name
    const lines = await c.db.prepare(`SELECT fh.name AS head, COALESCE(fh.code, '') AS description, fsi.amount_paise, fh.is_refundable, fh.service
        FROM fee_structure_items fsi JOIN fee_heads fh ON fh.id = fsi.fee_head_id
       WHERE fsi.fee_structure_id = ? AND fsi.instalment_no = 1 ORDER BY fh.is_refundable, fh.name`).bind(fs.structure_id)
      .all<{ head: string; description: string; amount_paise: number; is_refundable: number; service: string | null }>()
    let total = 0
    out.lines = lines.results.map((l) => {
      if (l.service === null) total += l.amount_paise
      return omitNull({ head: l.head, description: l.description || undefined, amount_paise: l.amount_paise, is_refundable: bool(l.is_refundable), service: l.service })
    })
    out.total_paise = total
    out.priced = lines.results.length > 0
    return ok(out)
  })

  r.get('/admissions/workflow/applications/{id}/documents', READ, async (c) => {
    const appID = c.params.id
    const exists = await c.db.prepare(`SELECT 1 FROM applications WHERE id = ?`).bind(appID).first()
    if (exists) {
      const seed = await checklistStmts(c.db, c.id.institution!.id, appID)
      if (seed.length > 0) await c.db.batch(seed)
    }
    const rows = await c.db.prepare(`
      SELECT d.id, d.doc_type, d.is_required, d.status, d.note, d.file_id, f.original_name AS file_name, f.content_type, f.size_bytes, u.full_name AS verified_by, date(d.verified_at) AS verified_at
        FROM application_documents d LEFT JOIN files f ON f.id = d.file_id AND f.deleted_at IS NULL LEFT JOIN users u ON u.id = d.verified_by
       WHERE d.application_id = ? ORDER BY d.is_required DESC, d.doc_type`).bind(appID).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => {
      const by = v.verified_by as string | null
      return omitNull({ ...v, is_required: bool(v.is_required), verified_by: by && by.trim() !== '' ? by : null })
    }) })
  })

  r.post('/admissions/workflow/applications/{id}/documents/{docID}', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const status = str(req.status).trim()
    if (!oneOfStr(status, 'pending', 'received', 'verified', 'rejected')) throw badRequest('status must be pending, received, verified or rejected')
    if (status === 'rejected' && str(req.note).trim() === '') throw badRequest('say what is wrong with it. The parent has to know what to bring back')
    const verdict = status === 'verified' || status === 'rejected'
    const t = now()
    const res = await c.db.prepare(`UPDATE application_documents SET status = ?, note = NULLIF(TRIM(?), ''), file_id = COALESCE(NULLIF(?, ''), file_id),
        verified_by = CASE WHEN ? THEN ? END, verified_at = CASE WHEN ? THEN ? END, updated_at = ? WHERE id = ?`)
      .bind(status, str(req.note), str(req.file_id), verdict ? 1 : 0, c.id.userId, verdict ? 1 : 0, t, t, c.params.docID).run()
    if (res.meta.changes === 0) throw new HttpError(404, "that document is not on this application's checklist", { code: 'not_found' })
    return ok({ ok: true })
  })

  r.get('/admissions/workflow/stages', READ, async (c) => {
    const cfg = await moduleConfig(c.db, 'admissions')
    return ok({ entrance_test: typeof cfg.entrance_test === 'boolean' ? cfg.entrance_test : true, interview: typeof cfg.interview === 'boolean' ? cfg.interview : true })
  })

  r.put('/admissions/workflow/stages', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const st = { entrance_test: !!req.entrance_test, interview: !!req.interview }
    await mergeModuleConfig(c.db, c.id.institution!.id, 'admissions', st).run()
    return ok(st)
  })

  r.post('/admissions/workflow/applications', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const first = str(req.first_name), parent = str(req.parent_name), phone = str(req.parent_phone), classSought = str(req.class_sought)
    if (first === '' || parent === '' || phone === '' || classSought === '') throw badRequest('first_name, parent_name, parent_phone and class_sought are required')
    if (!isUUIDish(classSought)) throw badRequest('class_sought must be a class uuid')
    const campus = await c.db.prepare(`SELECT institution_id, id FROM campuses ORDER BY created_at LIMIT 1`).first<{ institution_id: string; id: string }>()
    if (!campus) throw badRequest('this school has no campus yet')
    const appNo = await nextNumber(c.db, campus.institution_id, 'application')
    const appID = uuid(), t = now()
    const feePaise = typeof req.form_fee_paise === 'number' ? req.form_fee_paise : null
    const feePaid = req.form_fee_paid === true && feePaise !== null ? t : null
    const enquiryID = nz(req.enquiry_id)
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO applications (id, institution_id, campus_id, enquiry_id, application_no, first_name, middle_name, last_name, date_of_birth, gender, category, class_sought,
          parent_name, parent_phone, parent_email, address, previous_school, is_rte, status, form_fee_paise, form_fee_paid_at, form_fee_receipt, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?,?,?,?,?)`)
        .bind(appID, campus.institution_id, campus.id, enquiryID, appNo, first, nz(req.middle_name), nz(req.last_name), nz(req.date_of_birth), nz(req.gender), nz(req.category), classSought,
          parent, phone, nz(req.parent_email), nz(req.address), nz(req.previous_school), req.is_rte ? 1 : 0, feePaise, feePaid, nz(req.form_fee_receipt), t, t),
    ]
    for (const d of defaultChecklist) {
      stmts.push(c.db.prepare(`INSERT INTO application_documents (id, institution_id, application_id, doc_type, is_required, status, created_at, updated_at) VALUES (?,?,?,?,?,'pending',?,?)`)
        .bind(uuid(), campus.institution_id, appID, d.type, d.required ? 1 : 0, t, t))
    }
    if (enquiryID !== null) stmts.push(c.db.prepare(`UPDATE enquiries SET status = 'applied', updated_at = ? WHERE id = ?`).bind(t, enquiryID))
    await c.db.batch(stmts)
    // The acknowledgement email and the parent login are side effects the worker does not perform.
    return created({ id: appID, application_no: appNo, status: 'submitted', acknowledged: false, note: 'The acknowledgement could not be queued: email sending is not available in the worker' })
  })

  r.post('/admissions/workflow/applications/{id}/assessment', WRITE, async (c) => {
    if (!isUUIDish(c.params.id)) throw badRequest('invalid application id')
    const req = await readJSON(c.req)
    const kind = str(req.kind)
    if (kind !== 'entrance_test' && kind !== 'interview') throw badRequest('kind must be entrance_test or interview')
    const score = typeof req.score === 'number' ? String(req.score) : null
    const max = typeof req.max_score === 'number' ? String(req.max_score) : null
    await c.db.prepare(`INSERT INTO admission_assessments (id, institution_id, application_id, kind, scheduled_at, score, max_score, remarks, conducted_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(uuid(), c.id.institution!.id, c.params.id, kind, nz(req.scheduled_at), score, max, nz(req.remarks), c.id.userId, now()).run()
    return created({ application_id: c.params.id, kind })
  })

  r.post('/admissions/workflow/applications/{id}/decision', WRITE, async (c) => {
    const appID = c.params.id
    if (!isUUIDish(appID)) throw badRequest('invalid application id')
    const req = await readJSON(c.req)
    const decision = str(req.decision), remarks = str(req.remarks)
    if (decision === 'on_hold' && remarks.trim() === '') throw badRequest('say what is being waited on, the fee, a concession decision, a document')
    if (!['offered', 'rejected', 'waitlisted', 'on_hold'].includes(decision)) throw badRequest('decision must be offered, rejected, waitlisted or on_hold')
    if (decision === 'offered') {
      const working = await workingYear(c.db, c.id.userId, c.url.searchParams.get('academic_year_id') ?? '')
      const avail = await c.db.prepare(`
        WITH yr AS (SELECT COALESCE((SELECT ss.academic_year_id FROM applications a JOIN admission_sessions ss ON ss.id = a.admission_session_id WHERE a.id = ?), ?) AS id)
        SELECT MAX(0, COALESCE((SELECT sum(sec.capacity) FROM sections sec WHERE sec.class_id = a.class_sought AND sec.academic_year_id = (SELECT id FROM yr)), 0)
                 - (SELECT count(*) FROM enrollments e WHERE e.class_id = a.class_sought AND e.status='active' AND e.academic_year_id = (SELECT id FROM yr))
                 - (SELECT count(*) FROM applications a2 LEFT JOIN admission_sessions s2 ON s2.id = a2.admission_session_id
                     WHERE a2.class_sought = a.class_sought AND a2.status IN ('offered','accepted') AND COALESCE(s2.academic_year_id, (SELECT id FROM yr)) = (SELECT id FROM yr))) AS available
          FROM applications a WHERE a.id = ?`).bind(appID, working, appID).first<{ available: number }>()
      if (!avail) throw notFound()
      if (avail.available <= 0) throw new HttpError(409, 'no seats remain in that class; waitlist the applicant instead', { code: 'no_seats' })
    }
    const t = now()
    const res = await c.db.prepare(`UPDATE applications SET status = ?, decided_by = ?, decided_at = ?, remarks = COALESCE(?, remarks), updated_at = ?,
        hold_reason = CASE WHEN ? = 'on_hold' THEN NULLIF(TRIM(?), '') ELSE NULL END,
        held_at = CASE WHEN ? = 'on_hold' THEN ? ELSE NULL END,
        held_by = CASE WHEN ? = 'on_hold' THEN ? ELSE NULL END WHERE id = ?`)
      .bind(decision, c.id.userId, t, nz(remarks), t, decision, remarks, decision, t, decision, c.id.userId, appID).run()
    if (res.meta.changes === 0) throw notFound()
    return ok({ id: appID, status: decision, note: 'the family was not told: email sending is not available in the worker' })
  })

  r.get('/admissions/workflow/pending-admissions', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT a.id, a.application_no, ${fullName('a.first_name', 'a.last_name')} AS name, COALESCE(c.name, '') AS class_sought,
             COALESCE(a.parent_name, '') AS parent_name, COALESCE(a.parent_phone, '') AS phone, COALESCE(a.decided_at, '') AS offered_on,
             COALESCE((SELECT CAST(sum(i.amount_paise) AS TEXT) FROM fee_structure_items i WHERE i.fee_structure_id = (
                 SELECT fs.id FROM fee_structures fs WHERE fs.is_active = 1 AND (fs.class_id = a.class_sought OR fs.class_id IS NULL)
                  ORDER BY (fs.class_id IS NOT NULL) DESC, fs.created_at DESC LIMIT 1)), '0') AS fee_paise,
             COALESCE((SELECT fc.kind FROM fee_concessions fc WHERE fc.application_id = a.id ORDER BY fc.created_at DESC LIMIT 1), '') AS concession_kind,
             COALESCE((SELECT CASE WHEN fc.percent IS NOT NULL THEN fc.percent || '%' ELSE CAST(fc.amount_paise / 100 AS TEXT) END FROM fee_concessions fc WHERE fc.application_id = a.id ORDER BY fc.created_at DESC LIMIT 1), '') AS concession_value,
             COALESCE((SELECT fc.status FROM fee_concessions fc WHERE fc.application_id = a.id ORDER BY fc.created_at DESC LIMIT 1), '') AS concession_status,
             (a.enrolment_approved_at IS NOT NULL) AS enrolment_approved
        FROM applications a LEFT JOIN classes c ON c.id = a.class_sought
       WHERE a.status = 'offered' AND a.student_id IS NULL
       ORDER BY a.decided_at IS NULL, a.decided_at, a.application_no`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({ ...v, offered_on: str(v.offered_on).slice(0, 10), enrolment_approved: bool(v.enrolment_approved) })) })
  })

  r.post('/admissions/workflow/pending-admissions/{id}/decide', 'admissions.approve', async (c) => {
    if (!isUUIDish(c.params.id)) throw badRequest('invalid application id')
    const req = await readJSON(c.req)
    const approved = req.approved === true || req.decision === 'approved'
    const note = str(req.note).trim()
    if (!approved && note === '') throw badRequest('say what has to happen first, the desk has to tell the family something')
    const t = now()
    const res = await c.db.prepare(`UPDATE applications SET enrolment_approved_by = ?, enrolment_approved_at = ?, enrolment_note = NULLIF(?,''), updated_at = ? WHERE id = ? AND status = 'offered'`)
      .bind(approved ? c.id.userId : null, approved ? t : null, note, t, c.params.id).run()
    if (res.meta.changes === 0) throw new HttpError(409, 'that application is not waiting on an admission decision', { code: 'not_pending' })
    return ok({ approved })
  })

  r.get('/admissions/workflow/admission-approval', 'institution.settings.write', async (c) => ok({ required: await admissionApprovalRequired(c.db) }))

  r.put('/admissions/workflow/admission-approval', 'institution.settings.write', async (c) => {
    const req = await readJSON(c.req)
    const required = req.required === true
    await mergeModuleConfig(c.db, c.id.institution!.id, 'admissions', { [admissionApprovalKey]: required ? 'true' : 'false' }).run()
    return ok({ required })
  })

  r.post('/admissions/workflow/applications/{id}/enrol', 'students.write', async (c) => {
    const appID = c.params.id
    if (!isUUIDish(appID)) throw badRequest('invalid application id')
    const req = await readJSON(c.req)
    const concessionPaise = typeof req.concession_paise === 'number' ? req.concession_paise : 0
    if (concessionPaise !== 0 && !can(c.id, 'finance.fees.write')) {
      throw new HttpError(403, 'you can enrol this child, but not decide what they pay. Ask accounts to record the concession. The admission does not have to wait for it.', { code: 'not_your_price' })
    }
    const sectionID = str(req.section_id)
    if (!isUUIDish(sectionID)) throw badRequest('section_id must be a uuid')
    const transport = (req.transport && typeof req.transport === 'object') ? (req.transport as Record<string, unknown>) : null
    // admissionTransport.wanted(): a bus only when both the route and the pickup stop are named.
    const wantsBus = !!transport && str(transport.route_id).trim() !== '' && str(transport.pickup_stop_id).trim() !== ''
    let bus: { route: string; pickup: string; drop: string } | null = null
    if (wantsBus) {
      const route = str(transport!.route_id).trim(), pickup = str(transport!.pickup_stop_id).trim()
      const drop = str(transport!.drop_stop_id).trim() || pickup
      if (!isUUIDish(route) || !isUUIDish(pickup) || !isUUIDish(drop)) throw badRequest('route_id and pickup_stop_id must be uuids')
      bus = { route, pickup, drop }
    }

    const waiting = await c.db.prepare(`SELECT count(*) AS n FROM fee_concessions WHERE application_id = ? AND status = 'pending'`).bind(appID).first<{ n: number }>()
    if ((waiting?.n ?? 0) > 0) {
      throw new HttpError(409, 'the fee is not settled: a concession on this applicant is still waiting on the principal. Enrolling now would bill the family in full, and the waiver could not be applied afterwards', { code: 'concession_pending' })
    }
    if (await admissionApprovalRequired(c.db)) {
      const a = await c.db.prepare(`SELECT (enrolment_approved_at IS NOT NULL) AS approved FROM applications WHERE id = ?`).bind(appID).first<{ approved: number }>()
      if (!a) throw notFound()
      if (!a.approved) {
        throw new HttpError(409, 'this school asks the principal to approve every new joining, and this one is still waiting. It is on their approvals with the fee and any concession beside it', { code: 'admission_not_approved' })
      }
    }
    const app = await c.db.prepare(`SELECT institution_id, campus_id, class_sought, first_name, middle_name, last_name, date_of_birth, gender, category, parent_name, parent_phone, is_rte, status, student_id
        FROM applications WHERE id = ?`).bind(appID).first<Record<string, unknown>>()
    if (!app) throw notFound()
    const welcome = { note: 'parent login is not issued by the worker' }
    if (app.student_id) return created({ student_id: app.student_id, admission_no: '', status: 'enrolled', invoice_no: '', net_paise: 0, parent_login: welcome })
    if (app.status !== 'offered' && app.status !== 'accepted') throw badRequest('only an offered application can be enrolled')

    const inst = str(app.institution_id), campusID = str(app.campus_id), classID = str(app.class_sought), phone = str(app.parent_phone)
    const yearID = await workingYear(c.db, c.id.userId, str(req.academic_year_id))
    const admissionNo = await nextNumber(c.db, inst, 'admission')
    const studentID = uuid(), t = now(), today = todayIST()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, middle_name, last_name, date_of_birth, gender, category, is_rte, admission_date, status, person_code, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`)
        .bind(studentID, inst, campusID, admissionNo, app.first_name, app.middle_name, app.last_name, app.date_of_birth, app.gender, app.category, app.is_rte, today, await studentPersonCode(c.db, inst), t, t),
      c.db.prepare(`INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, enrolled_on, status, created_at) VALUES (?,?,?,?,?,?,?,'active',?)`)
        .bind(uuid(), inst, studentID, yearID, classID, sectionID, today, t),
    ]

    // The guardian the enquiry already made, else one holding a login on this number, else an upsert by (phone, full_name).
    let guardianID = (await c.db.prepare(`SELECT e.guardian_id FROM applications a JOIN enquiries e ON e.id = a.enquiry_id WHERE a.id = ? AND e.guardian_id IS NOT NULL`).bind(appID).first<{ guardian_id: string }>())?.guardian_id ?? ''
    if (guardianID === '' && phone !== '') {
      guardianID = (await c.db.prepare(`SELECT id FROM guardians WHERE phone = ? AND user_id IS NOT NULL ORDER BY created_at LIMIT 1`).bind(phone).first<{ id: string }>())?.id ?? ''
    }
    if (guardianID === '') {
      const existing = await c.db.prepare(`SELECT id FROM guardians WHERE institution_id = ? AND phone IS ? AND full_name = ? LIMIT 1`).bind(inst, nz(phone), app.parent_name).first<{ id: string }>()
      if (existing) guardianID = existing.id
      else {
        guardianID = uuid()
        stmts.push(c.db.prepare(`INSERT INTO guardians (id, institution_id, full_name, relation, phone, created_at) VALUES (?,?,?,'father',?,?)`).bind(guardianID, inst, app.parent_name, nz(phone), t))
      }
    }
    stmts.push(c.db.prepare(`INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary) VALUES (?,?,?,1)`).bind(studentID, guardianID, inst))

    let billedNo = '', billedPaise = 0
    if (!req.no_invoice) {
      let structureID = str(req.fee_structure_id)
      if (structureID === '') {
        structureID = (await c.db.prepare(`SELECT id FROM fee_structures WHERE is_active = 1 AND (class_id = ? OR class_id IS NULL) ORDER BY (class_id IS NOT NULL) DESC, created_at DESC LIMIT 1`)
          .bind(classID).first<{ id: string }>())?.id ?? ''
      }
      stmts.push(c.db.prepare(`UPDATE fee_concessions SET student_id = ?, academic_year_id = COALESCE(academic_year_id, ?) WHERE application_id = ? AND student_id IS NULL`).bind(studentID, yearID, appID))
      const conc = await c.db.prepare(`SELECT kind, COALESCE(reason,'') AS reason, percent, amount_paise, pay_by FROM fee_concessions WHERE application_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1`)
        .bind(appID).first<{ kind: string; reason: string; percent: string | null; amount_paise: number | null; pay_by: string | null }>()
      const wholeYear = conc?.kind === 'full_payment'
      if (structureID !== '') {
        const services = Array.isArray(req.services) ? (req.services as unknown[]).map(str) : []
        const lines = await c.db.prepare(`SELECT fsi.fee_head_id, fh.name, fsi.amount_paise FROM fee_structure_items fsi JOIN fee_heads fh ON fh.id = fsi.fee_head_id
            WHERE fsi.fee_structure_id = ? AND (? OR fsi.instalment_no = 1) AND (fh.service IS NULL OR fh.service IN (${placeholders()}))`)
          .bind(structureID, wholeYear ? 1 : 0, js(services)).all<{ fee_head_id: string; name: string; amount_paise: number }>()
        const invoiceNo = await nextNumber(c.db, inst, 'invoice')
        const invoiceID = uuid()
        const payBy = conc?.kind === 'full_payment' && conc.pay_by ? conc.pay_by : today
        const gross = lines.results.reduce((s, l) => s + l.amount_paise, 0)
        // The waiver lands on the largest line rather than being spread.
        let waiver = concessionPaise, waiverWhy = str(req.concession_reason)
        if (waiver === 0 && conc && (conc.percent !== null || conc.amount_paise !== null)) {
          if (conc.amount_paise !== null) waiver = conc.amount_paise
          else {
            const bp = Math.floor(Number(conc.percent) * 100 + 0.5)
            waiver = Math.floor((gross * bp + 5000) / 10000)
          }
          waiverWhy = conc.kind.split('_').join(' ') + (conc.reason !== '' ? ': ' + conc.reason : '')
        }
        let discount = 0
        const sorted = [...lines.results].sort((a, b2) => b2.amount_paise - a.amount_paise)
        const lineStmts = sorted.map((l, i) => {
          let d = 0, desc = l.name
          if (i === 0 && waiver > 0) {
            d = Math.min(l.amount_paise, waiver)
            if (waiverWhy.trim() !== '') desc = l.name + ' (' + waiverWhy.trim() + ')'
          }
          discount += d
          return c.db.prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise, discount_paise) VALUES (?,?,?,?,?,?,?)`)
            .bind(uuid(), inst, invoiceID, l.fee_head_id, desc, l.amount_paise, d)
        })
        // net_paise was generated in Postgres (gross - discount + fine); written here.
        stmts.push(c.db.prepare(`INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, instalment_no, issued_on, due_on, gross_paise, discount_paise, net_paise, status, covers_year, created_at, updated_at)
          VALUES (?,?,?,?,?,?,1,?,?,?,?,?,'unpaid',?,?,?)`).bind(invoiceID, inst, campusID, studentID, yearID, invoiceNo, today, payBy, gross, discount, gross - discount, wholeYear ? 1 : 0, t, t))
        stmts.push(...lineStmts)
        billedNo = invoiceNo; billedPaise = gross - discount
      }
    }
    /* allocateAtAdmission (admission_transport.go): the seat and its fare in the
       same batch as the admission. Both stops must be on the route. */
    if (bus) {
      const n = await c.db.prepare(`SELECT count(*) AS n FROM route_stops WHERE route_id = ? AND id IN (?, ?)`).bind(bus.route, bus.pickup, bus.drop).first<{ n: number }>()
      const need = bus.pickup === bus.drop ? 1 : 2
      if ((n?.n ?? 0) < need) throw badRequest('that stop is not on that route. Two routes often pass the same corner, so check which one the family was given')
      const stop = await c.db.prepare(`SELECT fare_paise FROM route_stops WHERE id = ?`).bind(bus.pickup).first<{ fare_paise: number | null }>()
      const fare = stop?.fare_paise === null || stop?.fare_paise === undefined ? null : Number(stop.fare_paise)
      const allocId = uuid()
      // A fresh student has no earlier allocation to end, so the Go UPDATE is a no-op here.
      stmts.push(c.db.prepare(`INSERT INTO transport_allocations (id, institution_id, student_id, academic_year_id, route_id, pickup_stop_id, drop_stop_id, valid_from)
          VALUES (?,?,?,?,?,?,?,?)`).bind(allocId, inst, studentID, yearID, bus.route, bus.pickup, bus.drop, today))
      stmts.push(...(await syncTransportFeeComponent(c, inst, studentID, { allocId, yearId: yearID, fare, route: bus.route, stop: bus.pickup })))
    }
    stmts.push(c.db.prepare(`UPDATE applications SET status = 'accepted', student_id = ?, updated_at = ? WHERE id = ?`).bind(studentID, t, appID))
    stmts.push(c.db.prepare(`UPDATE enquiries SET status = 'applied', updated_at = ? WHERE id = (SELECT enquiry_id FROM applications WHERE id = ?)`).bind(t, appID))
    await c.db.batch(stmts)
    return created({ student_id: studentID, admission_no: admissionNo, status: 'enrolled', invoice_no: billedNo, net_paise: billedPaise, parent_login: welcome })
  })
}


/** sendEnquiryApplicationLink (enquiry_invite.go). */
async function sendEnquiryLink(c: Ctx, enquiryId: string, studentName: string, parentName: string, phone: string, email: string): Promise<string[] | null> {
  phone = phone.trim(); email = email.trim()
  if (phone === '' && email === '') return null
  const today = todayIST()
  const f = await c.db.prepare(`SELECT f.slug, i.name FROM admission_forms f JOIN institutions i ON i.id = f.institution_id
      WHERE f.is_open = 1 AND (f.opens_on IS NULL OR f.opens_on <= ?1) AND (f.closes_on IS NULL OR f.closes_on >= ?1)
        AND EXISTS (SELECT 1 FROM admission_form_versions v WHERE v.form_id = f.id AND v.status = 'published')
      ORDER BY f.updated_at DESC LIMIT 1`).bind(today).first<{ slug: string; name: string }>().catch(() => null)
  if (!f) return null
  const vars = { school_name: f.name, student_name: studentName, parent_name: parentName.trim() !== '' ? parentName : 'Sir/Madam',
    apply_url: new URL(c.req.url).origin + '/admissions/apply/' + f.slug }
  const failed: string[] = []
  const ms = new Messenger(scopeOf(c))
  for (const channel of ['whatsapp', 'sms', 'email']) {
    const to = channel === 'email' ? email : phone
    if (to === '') continue
    try {
      await ms.queue({ channel, template_code: 'admissions.enquiry_link', vars, recipient: to, source_kind: 'enquiry', source_id: enquiryId, occurrence_key: 'apply_link:' + channel })
    } catch (e) {
      let why = (e as Error).message
      if (e instanceof MessagingError && e.code === 'provider_not_configured') { const i = why.lastIndexOf(': '); if (i >= 0) why = why.slice(i + 2).trim() + ' (set it up under Integrations)' }
      else if (e instanceof MessagingError && e.code === 'no_recipient') why = 'no usable address or number'
      failed.push(channel + ': ' + why)
    }
  }
  await ms.kick()
  return failed.length ? failed : null
}
