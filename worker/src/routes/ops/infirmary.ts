import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, bool, created, isUUID, notFound, ok, now, readJSON, uuid, uuidParam } from '../../http'
import { instId } from './common'

/* Port of internal/api/infirmary.go (the sick room and the rest of the boarding
   house) plus listHealthRecords from mod_ops.go. Same URLs, query params,
   bodies and JSON as the Go handlers.

   The Postgres CHECK constraints on these tables did not survive the move to
   SQLite; the sentence-level checks the Go handlers performed before each
   write are therefore the only guard, and every one of them is kept. */

// --- small helpers ---------------------------------------------------------------

/** Today in Asia/Kolkata, the only timezone the Go product resolves dates in (indiaToday). */
function indiaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/** ?on_date=, falling back to the Indian date (dayOrToday). */
function dayOrToday(c: Ctx): string {
  const v = (c.url.searchParams.get('on_date') ?? '').trim()
  return v !== '' ? v : indiaToday()
}

/** A query param naming one person: blank is "everyone", a malformed value is a 400 (optionalUUID). */
function optionalUUID(raw: string | null, name: string): string | null {
  const v = (raw ?? '').trim()
  if (v === '') return null
  if (!isUUID(v)) throw badRequest(`${name} must be a uuid`)
  return v
}

function requireUUID(v: unknown, msg: string): string {
  if (!isUUID(v)) throw badRequest(msg)
  return v
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const trimmed = (v: unknown): string => str(v).trim()
/** Go's NULLIF($n,''). */
const nullIfEmpty = (v: unknown): string | null => (str(v) === '' ? null : str(v))
const optInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
/** to_char(ts,'YYYY-MM-DD"T"HH24:MI') on an ISO text column. */
const minuteSQL = (col: string) => `substr(${col}, 1, 16)`
/** Drops keys whose value is null, the way Go's omitempty pointers vanish from the JSON. */
function omitNulls<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}
const s = (v: unknown): string | null => (v == null ? null : String(v))
const n = (v: unknown): number | null => (v == null ? null : Number(v))

/** A D1 unique-index violation (isUniqueViolation). */
const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)

const STUDENT_NAME = `TRIM(st.first_name || ' ' || COALESCE(st.last_name, ''))`
/** NULLIF(concat_ws('-', c.name, sec.name), '') over the child's active enrolment. */
const CLASS_NAME = `NULLIF(TRIM(COALESCE(c.name,'') || '-' || COALESCE(sec.name,''), '-'), '')`
/** The LEFT JOIN LATERAL the Go queries use to find the child's current class. */
const ENROLMENT_JOIN = `LEFT JOIN enrollments en ON en.id = (
        SELECT e.id FROM enrollments e WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1)
    LEFT JOIN classes  c   ON c.id = en.class_id
    LEFT JOIN sections sec ON sec.id = en.section_id`

// --- enumerations (copied from the Go file) ---------------------------------------

const visitOutcomes = ['returned_to_class', 'rested', 'sent_home', 'referred', 'hospitalised', 'observed']
const medicationRoutes = ['oral', 'topical', 'inhaled', 'drops', 'injection', 'other']
const medicationAuthority = ['doctor_prescription', 'parent_consent', 'standing_order', 'emergency']
const campProgrammes = ['rbsk', 'state_school_health', 'ngo', 'dental', 'eye', 'immunisation', 'school_own']
const nightStudyStatuses = ['present', 'absent', 'late', 'excused', 'sick_bay', 'on_outpass']
const roomCheckKinds = ['check_in', 'check_out', 'routine']
const itemConditions = ['good', 'worn', 'damaged', 'missing']

const errParentNotTold = 'a child who leaves the premises cannot be signed out until the parent has been told'
const errNoAuthority = 'say who authorised this dose. A parent by name or the prescribing doctor'
const errNoPrescriptProof = "a prescription needs its number or a scan attached; 'the doctor said so' is not a record"
const errEmergencyNoReason = 'an emergency dose given without anyone\'s permission must say in the notes why it could not wait'
const errNotToldOfIncident = 'a refusal or a reaction has to be told to the parent before it is filed'
const errCheckupHasNoYear = 'this child is not enrolled in any year and no year was named, so the checkup has nothing to belong to'
const errChargeNoNote = 'a charge needs a line saying what was broken; a parent cannot be billed for a number'
const errHostelVisitorBlocked = 'this visitor is on the school\'s block list and must not be admitted or given a boarder'
const errReleaseNeedsTime = 'say when the boarder is due back. A child let off the premises with no hour named is discovered missing at lights-out'
const errShortNeedsNote = 'say what is missing. A bundle counted back short with no note is an argument the warden loses next week'
const errMoreBackThanSent = 'more came back than was ever sent out'

export function registerInfirmary(r: Router): void {
  // --- the clinic's master file (mod_ops.go listHealthRecords) -------------------
  r.get('/ops/health/students', 'welfare.health.read', async (c) => {
    const q = (c.url.searchParams.get('q') ?? '').trim()
    const onlyFlagged = c.url.searchParams.get('flagged') === 'true'
    const rows = await c.db.prepare(`
      SELECT st.id AS student_id, ${STUDENT_NAME} AS name, st.admission_no,
             COALESCE(c.name || '-' || sec.name, '') AS class_name,
             st.blood_group, sh.allergies, sh.chronic_conditions, sh.doctor_name, sh.doctor_phone
        FROM students st
        LEFT JOIN student_health sh ON sh.student_id = st.id
        ${ENROLMENT_JOIN}
       WHERE (? = '' OR ${STUDENT_NAME} LIKE '%' || ? || '%' OR st.admission_no LIKE '%' || ? || '%')
         AND (NOT ? OR sh.allergies IS NOT NULL OR sh.chronic_conditions IS NOT NULL)
       ORDER BY (sh.allergies IS NULL AND sh.chronic_conditions IS NULL), st.admission_no
       LIMIT 300`).bind(q, q, q, onlyFlagged ? 1 : 0).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      student_id: v.student_id, name: v.name, admission_no: v.admission_no,
      class_name: v.class_name === '' ? null : v.class_name,
      blood_group: v.blood_group, allergies: v.allergies, chronic_conditions: v.chronic_conditions,
      doctor_name: v.doctor_name, doctor_phone: v.doctor_phone,
    })) })
  })

  // --- the nurse's day --------------------------------------------------------------
  r.get('/ops/infirmary/visits', 'welfare.health.read', async (c) => {
    const student = optionalUUID(c.url.searchParams.get('student_id'), 'student_id')
    const rows = await c.db.prepare(`
      SELECT v.id, st.id AS student_id, ${STUDENT_NAME} AS student_name, st.admission_no,
             ${CLASS_NAME} AS class_name, v.on_date, ${minuteSQL('v.arrived_at')} AS arrived_at,
             v.complaint, v.temperature_c, v.pulse_bpm, v.bp, v.observations, v.treatment,
             v.rested_minutes, v.outcome, v.referred_to,
             (v.parent_informed_at IS NOT NULL) AS parent_informed, v.seen_by_name,
             sh.allergies, sh.chronic_conditions, st.blood_group,
             (SELECT count(*) FROM medication_administrations m WHERE m.visit_id = v.id) AS doses_given
        FROM infirmary_visits v
        JOIN students st ON st.id = v.student_id
        LEFT JOIN student_health sh ON sh.student_id = st.id
        ${ENROLMENT_JOIN}
       WHERE (? IS NULL AND v.on_date = ? OR ? IS NOT NULL AND v.student_id = ?)
       ORDER BY v.arrived_at DESC
       LIMIT 200`).bind(student, dayOrToday(c), student, student).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      id: v.id, student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no,
      class_name: v.class_name, on_date: v.on_date, arrived_at: v.arrived_at, complaint: v.complaint,
      temperature_c: s(v.temperature_c), pulse_bpm: n(v.pulse_bpm), bp: v.bp, observations: v.observations,
      treatment: v.treatment, rested_minutes: n(v.rested_minutes), outcome: v.outcome, referred_to: v.referred_to,
      parent_informed: bool(v.parent_informed), seen_by: v.seen_by_name,
      allergies: v.allergies, chronic_conditions: v.chronic_conditions, blood_group: v.blood_group,
      doses_given: Number(v.doses_given ?? 0),
    })) })
  })

  r.post('/ops/infirmary/visits', 'welfare.health.write', async (c) => {
    const req = await readJSON(c.req)
    const student = requireUUID(req.student_id, 'student_id must be a uuid')
    if (trimmed(req.complaint) === '') throw badRequest('say what the child came in with')
    const outcome = str(req.outcome) || 'returned_to_class'
    if (!visitOutcomes.includes(outcome)) throw badRequest('unknown outcome ' + outcome)
    const parentInformed = req.parent_informed === true
    if ((outcome === 'sent_home' || outcome === 'hospitalised') && !parentInformed) throw badRequest(errParentNotTold)
    if ((outcome === 'referred' || outcome === 'hospitalised') && trimmed(req.referred_to) === '')
      throw badRequest('name where the child was sent. A referral to nobody is not a referral')

    const id = uuid(); const ts = now()
    await c.db.prepare(`
      INSERT INTO infirmary_visits
          (id, institution_id, student_id, on_date, arrived_at, complaint, temperature_c, pulse_bpm, bp,
           observations, treatment, rested_minutes, outcome, referred_to, parent_informed_at,
           seen_by, seen_by_name, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, instId(c), student, indiaToday(), ts, str(req.complaint), nullIfEmpty(req.temperature_c),
        optInt(req.pulse_bpm), nullIfEmpty(req.bp), nullIfEmpty(req.observations), nullIfEmpty(req.treatment),
        optInt(req.rested_minutes), outcome, nullIfEmpty(req.referred_to), parentInformed ? ts : null,
        c.id.userId, c.id.fullName, ts).run()
    return created({ id, outcome })
  })

  // --- the medication register -------------------------------------------------------
  r.get('/ops/infirmary/medications', 'welfare.health.read', async (c) => {
    const student = optionalUUID(c.url.searchParams.get('student_id'), 'student_id')
    const incidents = c.url.searchParams.get('incidents') === 'true' ? 1 : 0
    const rows = await c.db.prepare(`
      SELECT m.id, st.id AS student_id, ${STUDENT_NAME} AS student_name, st.admission_no,
             m.medicine, m.dose, m.route, m.authority, m.authorised_by_name, m.authority_ref, m.authorised_on,
             (m.authority_file_id IS NOT NULL) AS has_prescription_file, m.administered_by_name,
             ${minuteSQL('m.administered_at')} AS administered_at, m.witnessed_by_name, m.refused,
             m.adverse_reaction, (m.parent_informed_at IS NOT NULL) AS parent_informed, m.notes, sh.allergies
        FROM medication_administrations m
        JOIN students st ON st.id = m.student_id
        LEFT JOIN student_health sh ON sh.student_id = st.id
       WHERE (? IS NOT NULL AND m.student_id = ?
              OR ? IS NULL AND ? AND (m.refused OR m.adverse_reaction IS NOT NULL)
              OR ? IS NULL AND NOT ? AND substr(m.administered_at, 1, 10) = ?)
       ORDER BY m.administered_at DESC
       LIMIT 200`).bind(student, student, student, incidents, student, incidents, dayOrToday(c)).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      id: v.id, student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no,
      medicine: v.medicine, dose: v.dose, route: v.route, authority: v.authority,
      authorised_by_name: v.authorised_by_name, authority_ref: v.authority_ref, authorised_on: v.authorised_on,
      has_prescription_file: bool(v.has_prescription_file), administered_by_name: v.administered_by_name,
      administered_at: v.administered_at, witnessed_by_name: v.witnessed_by_name, refused: bool(v.refused),
      adverse_reaction: v.adverse_reaction, parent_informed: bool(v.parent_informed), notes: v.notes,
      allergies: v.allergies,
    })) })
  })

  r.post('/ops/infirmary/medications', 'welfare.health.write', async (c) => {
    const req = await readJSON(c.req)
    const student = requireUUID(req.student_id, 'student_id must be a uuid')
    if (trimmed(req.medicine) === '' || trimmed(req.dose) === '') throw badRequest('name the medicine and the dose given')
    const route = str(req.route) || 'oral'
    if (!medicationRoutes.includes(route)) throw badRequest('unknown route ' + route)
    const authority = str(req.authority)
    if (!medicationAuthority.includes(authority))
      throw badRequest('authority must be doctor_prescription, parent_consent, standing_order or emergency')
    if (trimmed(req.authorised_by_name) === '') throw badRequest(errNoAuthority)
    if (authority === 'doctor_prescription' && trimmed(req.authority_ref) === '' && str(req.authority_file_id) === '')
      throw badRequest(errNoPrescriptProof)
    if (authority === 'emergency' && trimmed(req.notes) === '') throw badRequest(errEmergencyNoReason)
    const refused = req.refused === true
    const parentInformed = req.parent_informed === true
    if ((refused || trimmed(req.adverse_reaction) !== '') && !parentInformed) throw badRequest(errNotToldOfIncident)
    const administeredBy = trimmed(req.administered_by_name) === '' ? c.id.fullName : str(req.administered_by_name)
    // Postgres would reject a non-uuid visit_id / file id at the cast; we do the same before the write.
    const visitId = nullIfEmpty(req.visit_id)
    if (visitId !== null && !isUUID(visitId)) throw badRequest('visit_id must be a uuid')
    const fileId = nullIfEmpty(req.authority_file_id)
    if (fileId !== null && !isUUID(fileId)) throw badRequest('authority_file_id must be a uuid')

    const id = uuid(); const ts = now()
    const administeredAt = nullIfEmpty(req.administered_at) ?? ts
    await c.db.prepare(`
      INSERT INTO medication_administrations
          (id, institution_id, student_id, visit_id, medicine, dose, route, authority, authorised_by_name,
           authority_ref, authority_file_id, authorised_on, administered_by, administered_by_name,
           administered_at, witnessed_by_name, refused, adverse_reaction, parent_informed_at, notes, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, instId(c), student, visitId, str(req.medicine), str(req.dose), route, authority,
        str(req.authorised_by_name), nullIfEmpty(req.authority_ref), fileId, nullIfEmpty(req.authorised_on),
        c.id.userId, administeredBy, administeredAt, nullIfEmpty(req.witnessed_by_name), refused ? 1 : 0,
        nullIfEmpty(req.adverse_reaction), parentInformed ? ts : null, nullIfEmpty(req.notes), ts).run()
    return created({ id, authority })
  })

  // --- the annual checkup -------------------------------------------------------------
  r.get('/ops/infirmary/checkups', 'welfare.health.read', async (c) => {
    const year = optionalUUID(c.url.searchParams.get('academic_year_id'), 'academic_year_id')
    const camp = optionalUUID(c.url.searchParams.get('camp_id'), 'camp_id')
    const rows = await c.db.prepare(`
      SELECT hc.id, st.id AS student_id, ${STUDENT_NAME} AS student_name, st.admission_no,
             ${CLASS_NAME} AS class_name, ay.name AS academic_year, hc.on_date, hcamp.name AS camp,
             hc.height_cm, hc.weight_kg, hc.bmi, hc.vision_left, hc.vision_right, hc.wears_spectacles,
             hc.hearing, hc.dental, hc.dental_notes, hc.haemoglobin_gdl, hc.immunisation_upto_date,
             hc.referred_to, hc.remarks, hc.examined_by
        FROM health_checkups hc
        JOIN students st ON st.id = hc.student_id
        JOIN academic_years ay ON ay.id = hc.academic_year_id
        LEFT JOIN health_camps hcamp ON hcamp.id = hc.camp_id
        ${ENROLMENT_JOIN}
       WHERE (? IS NULL OR hc.academic_year_id = ?) AND (? IS NULL OR hc.camp_id = ?)
       ORDER BY hc.on_date DESC, st.admission_no
       LIMIT 400`).bind(year, year, camp, camp).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      id: v.id, student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no,
      class_name: v.class_name, academic_year: v.academic_year, on_date: v.on_date, camp: v.camp,
      height_cm: s(v.height_cm), weight_kg: s(v.weight_kg), bmi: s(v.bmi),
      vision_left: v.vision_left, vision_right: v.vision_right, wears_spectacles: bool(v.wears_spectacles),
      hearing: v.hearing, dental: v.dental, dental_notes: v.dental_notes, haemoglobin_gdl: s(v.haemoglobin_gdl),
      immunisation_upto_date: v.immunisation_upto_date == null ? null : bool(v.immunisation_upto_date),
      referred_to: v.referred_to, remarks: v.remarks, examined_by: v.examined_by,
    })) })
  })

  /* An upsert on (institution, student, year); COALESCE keeps what an earlier
     visit filled in. bmi was a Postgres generated column: recomputed here from
     the merged height and weight in the same batch. */
  r.post('/ops/infirmary/checkups', 'welfare.health.write', async (c) => {
    const req = await readJSON(c.req)
    const student = requireUUID(req.student_id, 'student_id must be a uuid')
    const onDate = str(req.on_date) || indiaToday()
    const campId = nullIfEmpty(req.camp_id)
    if (campId !== null && !isUUID(campId)) throw badRequest('camp_id must be a uuid')
    const namedYear = nullIfEmpty(req.academic_year_id)
    if (namedYear !== null && !isUUID(namedYear)) throw badRequest('academic_year_id must be a uuid')

    const yearRow = await c.db.prepare(`
      SELECT COALESCE(?,
        (SELECT e.academic_year_id FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' ORDER BY e.created_at DESC LIMIT 1),
        (SELECT ay.id FROM academic_years ay WHERE ay.is_current ORDER BY ay.starts_on DESC LIMIT 1)) AS id`)
      .bind(namedYear, student).first<{ id: string | null }>()
    const year = yearRow?.id ?? null
    if (!year) throw badRequest(errCheckupHasNoYear)

    const inst = instId(c); const ts = now()
    const immunised = typeof req.immunisation_upto_date === 'boolean' ? (req.immunisation_upto_date ? 1 : 0) : null
    const vals = {
      height: nullIfEmpty(req.height_cm), weight: nullIfEmpty(req.weight_kg),
      vl: nullIfEmpty(req.vision_left), vr: nullIfEmpty(req.vision_right),
      hearing: nullIfEmpty(req.hearing), dental: nullIfEmpty(req.dental), dentalNotes: nullIfEmpty(req.dental_notes),
      hb: nullIfEmpty(req.haemoglobin_gdl), referredTo: nullIfEmpty(req.referred_to),
      remarks: nullIfEmpty(req.remarks), examinedBy: nullIfEmpty(req.examined_by),
    }
    const existing = await c.db.prepare(`SELECT id FROM health_checkups WHERE institution_id = ? AND student_id = ? AND academic_year_id = ?`)
      .bind(inst, student, year).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const write = existing
      ? c.db.prepare(`
          UPDATE health_checkups
             SET camp_id = COALESCE(?, camp_id), on_date = ?,
                 height_cm = COALESCE(?, height_cm), weight_kg = COALESCE(?, weight_kg),
                 vision_left = COALESCE(?, vision_left), vision_right = COALESCE(?, vision_right),
                 wears_spectacles = ?, hearing = COALESCE(?, hearing), dental = COALESCE(?, dental),
                 dental_notes = COALESCE(?, dental_notes), haemoglobin_gdl = COALESCE(?, haemoglobin_gdl),
                 immunisation_upto_date = COALESCE(?, immunisation_upto_date),
                 referred_to = COALESCE(?, referred_to), remarks = COALESCE(?, remarks),
                 examined_by = COALESCE(?, examined_by), updated_at = ?
           WHERE id = ?`)
          .bind(campId, onDate, vals.height, vals.weight, vals.vl, vals.vr, req.wears_spectacles === true ? 1 : 0,
            vals.hearing, vals.dental, vals.dentalNotes, vals.hb, immunised, vals.referredTo, vals.remarks,
            vals.examinedBy, ts, id)
      : c.db.prepare(`
          INSERT INTO health_checkups
              (id, institution_id, student_id, academic_year_id, camp_id, on_date, height_cm, weight_kg,
               vision_left, vision_right, wears_spectacles, hearing, dental, dental_notes, haemoglobin_gdl,
               immunisation_upto_date, referred_to, remarks, examined_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(id, inst, student, year, campId, onDate, vals.height, vals.weight, vals.vl, vals.vr,
            req.wears_spectacles === true ? 1 : 0, vals.hearing, vals.dental, vals.dentalNotes, vals.hb,
            immunised, vals.referredTo, vals.remarks, vals.examinedBy, ts, ts)
    await c.db.batch([
      write,
      // The generated column: round(weight / (height/100)^2, 2), null unless both are positive.
      c.db.prepare(`
        UPDATE health_checkups
           SET bmi = CASE WHEN CAST(height_cm AS REAL) > 0 AND CAST(weight_kg AS REAL) > 0
                          THEN printf('%.2f', CAST(weight_kg AS REAL) / ((CAST(height_cm AS REAL) / 100.0) * (CAST(height_cm AS REAL) / 100.0)))
                     END
         WHERE id = ?`).bind(id),
    ])
    return ok({ id })
  })

  // --- health programme camps -----------------------------------------------------------
  r.get('/ops/infirmary/camps', 'welfare.health.read', async (c) => {
    const rows = await c.db.prepare(`
      SELECT hc.id, hc.name, hc.programme, hc.agency, hc.doctor_lead, hc.on_date, hc.ends_on, hc.venue, hc.notes,
             (SELECT count(*) FROM health_camp_attendance a WHERE a.camp_id = hc.id) AS seen,
             (SELECT count(*) FROM health_camp_attendance a WHERE a.camp_id = hc.id AND a.referred) AS referred,
             (SELECT count(*) FROM health_camp_attendance a
               WHERE a.camp_id = hc.id AND a.referred AND a.follow_up_done_at IS NULL) AS follow_ups_outstanding,
             (SELECT count(*) FROM health_checkups k WHERE k.camp_id = hc.id) AS checkups_filed
        FROM health_camps hc
       ORDER BY hc.on_date DESC
       LIMIT 100`).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      id: v.id, name: v.name, programme: v.programme, agency: v.agency, doctor_lead: v.doctor_lead,
      on_date: v.on_date, ends_on: v.ends_on, venue: v.venue, notes: v.notes,
      seen: Number(v.seen), referred: Number(v.referred),
      follow_ups_outstanding: Number(v.follow_ups_outstanding), checkups_filed: Number(v.checkups_filed),
    })) })
  })

  r.post('/ops/infirmary/camps', 'welfare.health.write', async (c) => {
    const req = await readJSON(c.req)
    const name = str(req.name)
    if (name.trim() === '') throw badRequest('the camp needs a name')
    const programme = str(req.programme) || 'school_own'
    if (!campProgrammes.includes(programme)) throw badRequest('unknown programme ' + programme)
    const onDate = str(req.on_date) || indiaToday()
    const id = uuid()
    await c.db.prepare(`
      INSERT INTO health_camps (id, institution_id, name, programme, agency, doctor_lead, on_date, ends_on, venue, notes, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, instId(c), name, programme, nullIfEmpty(req.agency), nullIfEmpty(req.doctor_lead), onDate,
        nullIfEmpty(req.ends_on), nullIfEmpty(req.venue), nullIfEmpty(req.notes), now()).run()
    return created({ id, name })
  })

  r.get('/ops/infirmary/camps/{id}/seen', 'welfare.health.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid camp id')
    const camp = c.params.id
    const rows = await c.db.prepare(`
      SELECT a.id, st.id AS student_id, ${STUDENT_NAME} AS student_name, st.admission_no,
             ${CLASS_NAME} AS class_name, a.findings, a.treatment_given, a.referred, a.referred_to,
             a.follow_up_on, (a.follow_up_done_at IS NOT NULL) AS followed_up, a.follow_up_note,
             (a.referred AND a.follow_up_done_at IS NULL AND a.follow_up_on IS NOT NULL AND a.follow_up_on < ?) AS follow_up_overdue
        FROM health_camp_attendance a
        JOIN students st ON st.id = a.student_id
        ${ENROLMENT_JOIN}
       WHERE a.camp_id = ?
       ORDER BY (a.referred AND a.follow_up_done_at IS NULL) DESC,
                (a.follow_up_on IS NULL), a.follow_up_on, st.admission_no
       LIMIT 500`).bind(indiaToday(), camp).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      id: v.id, student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no,
      class_name: v.class_name, findings: v.findings, treatment_given: v.treatment_given,
      referred: bool(v.referred), referred_to: v.referred_to, follow_up_on: v.follow_up_on,
      followed_up: bool(v.followed_up), follow_up_note: v.follow_up_note, follow_up_overdue: bool(v.follow_up_overdue),
    })) })
  })

  /* Upsert on (camp, student): a recheck corrects the first look; closing a
     referral out comes through the same door. follow_up_done_at is only ever
     set, never cleared. */
  r.post('/ops/infirmary/camps/{id}/seen', 'welfare.health.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid camp id')
    const camp = c.params.id
    const req = await readJSON(c.req)
    const student = requireUUID(req.student_id, 'student_id must be a uuid')
    const referred = req.referred === true
    if (referred && trimmed(req.referred_to) === '')
      throw badRequest('name where the child was referred. A referral to nobody is not a referral')

    const ts = now()
    const doneAt = req.followed_up === true ? ts : null
    const existing = await c.db.prepare(`SELECT id FROM health_camp_attendance WHERE camp_id = ? AND student_id = ?`)
      .bind(camp, student).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    if (existing) {
      await c.db.prepare(`
        UPDATE health_camp_attendance
           SET findings = COALESCE(?, findings), treatment_given = COALESCE(?, treatment_given),
               referred = ?, referred_to = COALESCE(?, referred_to), follow_up_on = COALESCE(?, follow_up_on),
               follow_up_done_at = COALESCE(follow_up_done_at, ?), follow_up_note = COALESCE(?, follow_up_note)
         WHERE id = ?`)
        .bind(nullIfEmpty(req.findings), nullIfEmpty(req.treatment_given), referred ? 1 : 0,
          nullIfEmpty(req.referred_to), nullIfEmpty(req.follow_up_on), doneAt, nullIfEmpty(req.follow_up_note), id).run()
    } else {
      await c.db.prepare(`
        INSERT INTO health_camp_attendance
            (id, institution_id, camp_id, student_id, findings, treatment_given, referred, referred_to,
             follow_up_on, follow_up_done_at, follow_up_note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, instId(c), camp, student, nullIfEmpty(req.findings), nullIfEmpty(req.treatment_given),
          referred ? 1 : 0, nullIfEmpty(req.referred_to), nullIfEmpty(req.follow_up_on), doneAt,
          nullIfEmpty(req.follow_up_note), ts).run()
    }
    return ok({ id, camp_id: camp })
  })

  // --- night study roll call -----------------------------------------------------------
  r.get('/ops/hostel/night-study', 'operations.hostel.read', async (c) => {
    const session = c.url.searchParams.get('session') === 'evening' ? 'evening' : 'night'
    const rows = await c.db.prepare(`
      SELECT st.id AS student_id, ${STUDENT_NAME} AS student_name, st.admission_no, hb.name AS block, hr.room_no,
             n.id, COALESCE(n.status, '') AS status, n.minutes_late, n.remarks, n.hall,
             ${minuteSQL('n.marked_at')} AS marked_at, u.full_name AS marked_by,
             EXISTS (SELECT 1 FROM hostel_outpasses o WHERE o.student_id = st.id AND o.status = 'out') AS on_outpass
        FROM hostel_allocations ha
        JOIN students st ON st.id = ha.student_id
        JOIN hostel_rooms hr ON hr.id = ha.room_id
        JOIN hostel_blocks hb ON hb.id = hr.block_id
        LEFT JOIN night_study_attendance n ON n.student_id = st.id AND n.on_date = ? AND n.session = ?
        LEFT JOIN users u ON u.id = n.marked_by
       WHERE ha.vacated_on IS NULL
       ORDER BY hb.name, hr.room_no, st.admission_no
       LIMIT 1000`).bind(dayOrToday(c), session).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no,
      block: v.block, room_no: v.room_no, id: v.id, status: v.status, minutes_late: n(v.minutes_late),
      remarks: v.remarks, hall: v.hall, marked_at: v.marked_at, marked_by: v.marked_by, on_outpass: bool(v.on_outpass),
    })) })
  })

  /* One sitting saved at once; each mark upserts on (institution, student, date, session). */
  r.post('/ops/hostel/night-study', 'operations.hostel.write', async (c) => {
    const req = await readJSON<{ on_date?: string; session?: string; hall?: string; marks?: Array<Record<string, unknown>> }>(c.req)
    const onDate = str(req.on_date) || indiaToday()
    const session = str(req.session) || 'night'
    if (session !== 'evening' && session !== 'night') throw badRequest('session must be evening or night')
    const marks = Array.isArray(req.marks) ? req.marks : []
    if (marks.length === 0) throw badRequest('nothing to mark')
    for (const m of marks) {
      if (!isUUID(m.student_id)) throw badRequest('student_id must be a uuid')
      if (!nightStudyStatuses.includes(str(m.status))) throw badRequest('unknown status ' + str(m.status))
      if (m.status === 'excused' && trimmed(m.remarks) === '') throw badRequest(`say why ${m.student_id} is excused from prep`)
    }
    const inst = instId(c); const ts = now(); const hall = nullIfEmpty(req.hall)
    await c.db.batch(marks.map((m) => c.db.prepare(`
      INSERT INTO night_study_attendance
          (id, institution_id, student_id, on_date, session, hall, status, minutes_late, remarks, marked_by, marked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (institution_id, student_id, on_date, session) DO UPDATE
         SET hall = excluded.hall, status = excluded.status, minutes_late = excluded.minutes_late,
             remarks = excluded.remarks, marked_by = excluded.marked_by, marked_at = excluded.marked_at`)
      .bind(uuid(), inst, m.student_id as string, onDate, session, hall, str(m.status), optInt(m.minutes_late),
        nullIfEmpty(m.remarks), c.id.userId, ts)))
    return ok({ on_date: onDate, session, marked: marks.length })
  })

  // --- room inventory checklists ----------------------------------------------------------
  r.get('/ops/hostel/room-checks', 'operations.hostel.read', async (c) => {
    const room = optionalUUID(c.url.searchParams.get('room_id'), 'room_id')
    const kind = nullIfEmpty(c.url.searchParams.get('kind'))
    const rows = await c.db.prepare(`
      SELECT rc.id, hr.id AS room_id, hb.name AS block, hr.room_no, st.id AS student_id,
             NULLIF(TRIM(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')), '') AS student_name,
             st.admission_no, rc.kind, rc.on_date, u.full_name AS checked_by, rc.boarder_signed, rc.remarks,
             (SELECT count(*) FROM room_inventory_items i WHERE i.check_id = rc.id) AS items,
             (SELECT count(*) FROM room_inventory_items i WHERE i.check_id = rc.id AND i.condition IN ('damaged','missing')) AS faults,
             (SELECT COALESCE(sum(i.charge_paise),0) FROM room_inventory_items i WHERE i.check_id = rc.id) AS charge_paise
        FROM room_inventory_checks rc
        JOIN hostel_rooms hr ON hr.id = rc.room_id
        JOIN hostel_blocks hb ON hb.id = hr.block_id
        LEFT JOIN students st ON st.id = rc.student_id
        LEFT JOIN users u ON u.id = rc.checked_by
       WHERE (? IS NULL OR rc.room_id = ?) AND (? IS NULL OR rc.kind = ?)
       ORDER BY rc.on_date DESC, hb.name, hr.room_no
       LIMIT 200`).bind(room, room, kind, kind).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      id: v.id, room_id: v.room_id, block: v.block, room_no: v.room_no, student_id: v.student_id,
      student_name: v.student_name, admission_no: v.admission_no, kind: v.kind, on_date: v.on_date,
      checked_by: v.checked_by, boarder_signed: bool(v.boarder_signed), remarks: v.remarks,
      items: Number(v.items), faults: Number(v.faults), charge_paise: Number(v.charge_paise),
    })) })
  })

  r.get('/ops/hostel/room-checks/{id}/items', 'operations.hostel.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid check id')
    const rows = await c.db.prepare(`
      SELECT id, item, expected, found, condition, damage_note, charge_paise
        FROM room_inventory_items WHERE check_id = ? ORDER BY lower(item)`).bind(c.params.id).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      id: v.id, item: v.item, expected: Number(v.expected), found: Number(v.found), condition: v.condition,
      damage_note: v.damage_note, charge_paise: Number(v.charge_paise),
    })) })
  })

  /* One inspection and its whole checklist, lines replaced not merged. Upsert
     on (institution, room, student-or-none, kind, date); the Postgres
     expression index is not in the SQLite schema, so the lookup is done here. */
  r.post('/ops/hostel/room-checks', 'operations.hostel.write', async (c) => {
    const req = await readJSON<Record<string, unknown> & { items?: Array<Record<string, unknown>> }>(c.req)
    const room = requireUUID(req.room_id, 'room_id must be a uuid')
    const kind = str(req.kind)
    if (!roomCheckKinds.includes(kind)) throw badRequest('kind must be check_in, check_out or routine')
    const onDate = str(req.on_date) || indiaToday()
    const studentId = nullIfEmpty(req.student_id)
    if (studentId !== null && !isUUID(studentId)) throw badRequest('student_id must be a uuid')
    const items = (Array.isArray(req.items) ? req.items : []).map((it) => {
      const item = str(it.item)
      if (item.trim() === '') throw badRequest('every line needs the name of the thing checked')
      const condition = str(it.condition) || 'good'
      if (!itemConditions.includes(condition)) throw badRequest('unknown condition ' + condition)
      let expected = optInt(it.expected) ?? 0
      if (expected === 0) expected = 1
      const found = optInt(it.found) ?? 0
      if (found > expected) throw badRequest('more ' + item + ' found than the room is meant to have')
      const charge = optInt(it.charge_paise) ?? 0
      const damageNote = str(it.damage_note)
      if (charge > 0 && damageNote.trim() === '') throw badRequest(errChargeNoNote)
      return { item, expected, found, condition, damageNote: nullIfEmpty(damageNote), charge }
    })

    const inst = instId(c); const ts = now(); const signed = req.boarder_signed === true ? 1 : 0
    const existing = await c.db.prepare(`
      SELECT id FROM room_inventory_checks
       WHERE institution_id = ? AND room_id = ? AND COALESCE(student_id, '') = COALESCE(?, '') AND kind = ? AND on_date = ?`)
      .bind(inst, room, studentId, kind, onDate).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const head = existing
      ? c.db.prepare(`UPDATE room_inventory_checks SET checked_by = ?, boarder_signed = ?, remarks = ? WHERE id = ?`)
          .bind(c.id.userId, signed, nullIfEmpty(req.remarks), id)
      : c.db.prepare(`
          INSERT INTO room_inventory_checks
              (id, institution_id, room_id, student_id, kind, on_date, checked_by, boarder_signed, remarks, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .bind(id, inst, room, studentId, kind, onDate, c.id.userId, signed, nullIfEmpty(req.remarks), ts)
    await c.db.batch([
      head,
      c.db.prepare(`DELETE FROM room_inventory_items WHERE check_id = ?`).bind(id),
      ...items.map((it) => c.db.prepare(`
        INSERT INTO room_inventory_items (id, institution_id, check_id, item, expected, found, condition, damage_note, charge_paise)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(uuid(), inst, id, it.item, it.expected, it.found, it.condition, it.damageNote, it.charge)),
    ])
    return ok({ id, items: items.length })
  })

  // --- the hostel visitor log ---------------------------------------------------------------
  r.get('/ops/hostel/visits', 'operations.hostel.read', async (c) => {
    const all = c.url.searchParams.get('all') === 'true' ? 1 : 0
    const onSite = c.url.searchParams.get('on_site') === 'true' ? 1 : 0
    const rows = await c.db.prepare(`
      SELECT hv.id, v.pass_no, v.full_name AS visitor_name, v.phone, hv.relationship,
             st.id AS student_id, ${STUDENT_NAME} AS student_name, st.admission_no, hb.name AS block, hr.room_no,
             ${minuteSQL('v.in_at')} AS in_at, ${minuteSQL('v.out_at')} AS out_at, hv.met_in, hv.boarder_released,
             ${minuteSQL('hv.expected_back')} AS expected_back, ${minuteSQL('hv.returned_at')} AS returned_at,
             up.full_name AS permitted_by, (v.out_at IS NULL) AS on_site,
             (hv.boarder_released AND hv.returned_at IS NULL AND hv.expected_back < ?) AS overdue, hv.remarks
        FROM hostel_visits hv
        JOIN visitors v ON v.id = hv.visitor_id
        JOIN students st ON st.id = hv.student_id
        LEFT JOIN hostel_allocations ha ON ha.student_id = hv.student_id AND ha.vacated_on IS NULL
        LEFT JOIN hostel_rooms hr ON hr.id = ha.room_id
        LEFT JOIN hostel_blocks hb ON hb.id = hr.block_id
        LEFT JOIN users up ON up.id = hv.permitted_by
       WHERE (? OR v.on_date = ?) AND (NOT ? OR v.out_at IS NULL)
       ORDER BY (v.out_at IS NULL) DESC, v.in_at DESC
       LIMIT 200`).bind(now(), all, dayOrToday(c), onSite).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      id: v.id, pass_no: v.pass_no, visitor_name: v.visitor_name, phone: v.phone, relationship: v.relationship,
      student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no,
      block: v.block, room_no: v.room_no, in_at: v.in_at, out_at: v.out_at, met_in: v.met_in,
      boarder_released: bool(v.boarder_released), expected_back: v.expected_back, returned_at: v.returned_at,
      permitted_by: v.permitted_by, on_site: bool(v.on_site), overdue: bool(v.overdue), remarks: v.remarks,
    })) })
  })

  /* The gate pass goes into visitors, the same table the front desk writes to,
     and the block list is re-checked here rather than assumed. */
  r.post('/ops/hostel/visits', 'operations.hostel.write', async (c) => {
    const req = await readJSON(c.req)
    const student = requireUUID(req.student_id, 'student_id must be a uuid')
    const name = str(req.full_name); const relationship = str(req.relationship); const phone = str(req.phone)
    if (name.trim() === '' || relationship.trim() === '')
      throw badRequest('name the visitor and how they are related to the boarder')
    const released = req.boarder_released === true
    const expectedBack = str(req.expected_back)
    if (released && expectedBack === '') throw badRequest(errReleaseNeedsTime)

    const today = indiaToday()
    const blocked = await c.db.prepare(`
      SELECT COALESCE(max(reason), '') AS reason FROM visitor_blocklist
       WHERE lower(full_name) = lower(?) AND (phone IS NULL OR ? = '' OR phone = ?)
         AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`)
      .bind(name, phone, phone, today, today).first<{ reason: string }>()
    if (blocked && blocked.reason !== '') throw new HttpError(409, errHostelVisitorBlocked, { code: 'visitor_blocked' })

    const inst = instId(c); const ts = now()
    const visitorId = uuid(); const id = uuid()
    // The day's next pass number. Postgres allocated it inside the insert's own
    // transaction; here the read and the two inserts share one batch.
    const nextPass = await c.db.prepare(`
      SELECT printf('%03d', COALESCE(max(CAST(pass_no AS INTEGER)), 0) + 1) AS pass_no
        FROM visitors v WHERE v.institution_id = ? AND v.on_date = ? AND v.pass_no GLOB '[0-9]*' AND v.pass_no NOT GLOB '*[^0-9]*'`)
      .bind(inst, today).first<{ pass_no: string }>()
    const pass = nextPass?.pass_no ?? '001'
    await c.db.batch([
      c.db.prepare(`
        INSERT INTO visitors (id, institution_id, pass_no, full_name, phone, id_type, id_last4, purpose, student_id,
                              on_date, in_at, issued_by, remarks)
        VALUES (?,?,?,?,?,?,?,'Hostel visit',?,?,?,?,?)`)
        .bind(visitorId, inst, pass, name, nullIfEmpty(phone), nullIfEmpty(req.id_type), nullIfEmpty(req.id_last4),
          student, today, ts, c.id.userId, nullIfEmpty(req.remarks)),
      c.db.prepare(`
        INSERT INTO hostel_visits (id, institution_id, visitor_id, student_id, relationship, permitted_by, met_in,
                                   boarder_released, expected_back, remarks, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, inst, visitorId, student, relationship, c.id.userId, nullIfEmpty(req.met_in), released ? 1 : 0,
          nullIfEmpty(expectedBack), nullIfEmpty(req.remarks), ts),
    ])
    return created({ id, pass_no: pass })
  })

  /* Closes the visit: the visitor leaves, and a boarder who was released comes back. */
  r.post('/ops/hostel/visits/{id}/out', 'operations.hostel.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid visit id')
    const visitId = c.params.id
    const ts = now()
    const hv = await c.db.prepare(`SELECT visitor_id FROM hostel_visits WHERE id = ?`).bind(visitId).first<{ visitor_id: string }>()
    if (!hv) throw notFound()
    await c.db.batch([
      c.db.prepare(`UPDATE hostel_visits SET returned_at = CASE WHEN boarder_released THEN COALESCE(returned_at, ?) END WHERE id = ?`)
        .bind(ts, visitId),
      c.db.prepare(`UPDATE visitors SET out_at = COALESCE(out_at, ?), closed_by = ? WHERE id = ?`)
        .bind(ts, c.id.userId, hv.visitor_id),
    ])
    return ok({ id: visitId, status: 'closed' })
  })

  // --- laundry ------------------------------------------------------------------------------
  r.get('/ops/hostel/laundry', 'operations.hostel.read', async (c) => {
    const student = optionalUUID(c.url.searchParams.get('student_id'), 'student_id')
    const status = nullIfEmpty(c.url.searchParams.get('status'))
    const rows = await c.db.prepare(`
      SELECT l.id, st.id AS student_id, ${STUDENT_NAME} AS student_name, st.admission_no, hb.name AS block, hr.room_no,
             l.token_no, l.vendor, l.sent_on, l.due_on, l.items_sent, l.item_detail, l.returned_on, l.items_returned,
             l.status, l.charge_paise, l.damage_note,
             (l.status = 'sent' AND l.due_on IS NOT NULL AND l.due_on < ?) AS overdue
        FROM hostel_laundry l
        JOIN students st ON st.id = l.student_id
        LEFT JOIN hostel_allocations ha ON ha.student_id = l.student_id AND ha.vacated_on IS NULL
        LEFT JOIN hostel_rooms hr ON hr.id = ha.room_id
        LEFT JOIN hostel_blocks hb ON hb.id = hr.block_id
       WHERE (? IS NULL OR l.student_id = ?) AND (? IS NULL OR l.status = ?)
       ORDER BY (l.status = 'sent') DESC, l.sent_on DESC
       LIMIT 300`).bind(indiaToday(), student, student, status, status).all()
    return ok({ items: rows.results.map((v) => omitNulls({
      id: v.id, student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no,
      block: v.block, room_no: v.room_no, token_no: v.token_no, vendor: v.vendor, sent_on: v.sent_on, due_on: v.due_on,
      items_sent: Number(v.items_sent), item_detail: v.item_detail, returned_on: v.returned_on,
      items_returned: n(v.items_returned), status: v.status, charge_paise: Number(v.charge_paise),
      damage_note: v.damage_note, overdue: bool(v.overdue),
    })) })
  })

  r.post('/ops/hostel/laundry', 'operations.hostel.write', async (c) => {
    const req = await readJSON(c.req)
    const student = requireUUID(req.student_id, 'student_id must be a uuid')
    const token = str(req.token_no)
    if (token.trim() === '') throw badRequest('the bundle needs the token number handed to the boarder')
    const items = optInt(req.items_sent) ?? 0
    if (items <= 0) throw badRequest('count the items going out. A bundle with no count settles no argument')
    const sentOn = str(req.sent_on) || indiaToday()
    const id = uuid()
    try {
      await c.db.prepare(`
        INSERT INTO hostel_laundry (id, institution_id, student_id, token_no, vendor, sent_on, due_on, items_sent,
                                    item_detail, charge_paise, recorded_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, instId(c), student, token, nullIfEmpty(req.vendor), sentOn, nullIfEmpty(req.due_on), items,
          nullIfEmpty(req.item_detail), optInt(req.charge_paise) ?? 0, c.id.userId, now()).run()
    } catch (e) {
      // The token is on a physical tag the boarder keeps: one number, one bundle, per day.
      if (isUniqueViolation(e)) throw new HttpError(409, `token ${token} is already on a bundle sent today`, { code: 'token_in_use' })
      throw badRequest(e instanceof Error ? e.message : String(e))
    }
    return created({ id, token_no: token })
  })

  /* Counts a bundle back in; the status is derived from the count, never taken from the client. */
  r.post('/ops/hostel/laundry/{id}/return', 'operations.hostel.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid laundry id')
    const batchId = c.params.id
    const req = await readJSON(c.req)
    const back = optInt(req.items_returned) ?? 0
    if (back < 0) throw badRequest('items_returned cannot be negative')
    const returnedOn = str(req.returned_on) || indiaToday()
    const damageNote = str(req.damage_note)
    const charge = optInt(req.charge_paise)

    const row = await c.db.prepare(`SELECT items_sent FROM hostel_laundry WHERE id = ?`).bind(batchId).first<{ items_sent: number }>()
    if (!row) throw notFound()
    const sent = Number(row.items_sent)
    if (back > sent) throw badRequest(errMoreBackThanSent)
    if (back < sent && damageNote.trim() === '') throw badRequest(errShortNeedsNote)
    const status = back === 0 ? 'lost' : back < sent ? 'short' : 'returned'
    await c.db.prepare(`
      UPDATE hostel_laundry
         SET returned_on = ?, items_returned = ?, status = ?, damage_note = ?, charge_paise = COALESCE(?, charge_paise)
       WHERE id = ?`).bind(returnedOn, back, status, nullIfEmpty(damageNote), charge, batchId).run()
    return ok({ id: batchId, status })
  })
}
