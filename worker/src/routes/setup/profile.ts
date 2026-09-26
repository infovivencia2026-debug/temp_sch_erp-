import type { Router } from '../../router'
import type { Ctx } from '../../router'
import { badRequest, conflict, created, notFound, ok, readJSON, uuid, uuidParam, now, bool } from '../../http'
import { requireInstitution, instId, nullStr, deriveShortName, isDigits, isUniqueViolation, trim } from './common'

/* Port of setup_profile.go (institution, campuses, payments, options),
   board_presets.go and custom_options.go. */

/* --- board presets ---------------------------------------------------------- */

interface GradeBandPreset { grade: string; min_percent: number; max_percent: number; grade_point?: number }
interface BoardPreset {
  value: string; label: string; group: string; scale_name: string; pass_mark: number
  assessment: string; leaving_doc: string; notes?: string; bands: GradeBandPreset[]
}

const band = (grade: string, min: number, max: number, gp: number): GradeBandPreset =>
  gp > 0 ? { grade, min_percent: min, max_percent: max, grade_point: gp } : { grade, min_percent: min, max_percent: max }

const cbseNinePoint = [band('A1', 91, 100, 10), band('A2', 81, 90.99, 9), band('B1', 71, 80.99, 8), band('B2', 61, 70.99, 7),
  band('C1', 51, 60.99, 6), band('C2', 41, 50.99, 5), band('D', 33, 40.99, 4), band('E', 0, 32.99, 0)]
const letterFive = [band('A', 75, 100, 0), band('B', 60, 74.99, 0), band('C', 45, 59.99, 0), band('D', 35, 44.99, 0), band('E', 0, 34.99, 0)]
const divisionScale = [band('Distinction', 75, 100, 0), band('First', 60, 74.99, 0), band('Second', 50, 59.99, 0),
  band('Pass', 35, 49.99, 0), band('Fail', 0, 34.99, 0)]
const TC = 'Transfer Certificate (TC)'

const state = (value: string, label: string, group: string, scale: string, pass: number, assessment: string,
  bands: GradeBandPreset[], leaving = TC, notes?: string): BoardPreset =>
  ({ value, label, group, scale_name: scale, pass_mark: pass, assessment, leaving_doc: leaving, bands, ...(notes ? { notes } : {}) })

export const boardPresets: BoardPreset[] = [
  { value: 'CBSE', label: 'CBSE', group: 'National', scale_name: 'CBSE nine-point', pass_mark: 33,
    assessment: 'Two terms, each with internal assessment and a term examination', leaving_doc: TC,
    notes: 'CBSE grades Class 10 and Class 12 differently. This sets the Secondary scale; change it for the senior classes if your school reports them separately.',
    bands: cbseNinePoint },
  { value: 'CISCE', label: 'CISCE (ICSE / ISC)', group: 'National', scale_name: 'ICSE letter', pass_mark: 35,
    assessment: 'Internal assessment across the year with a final examination', leaving_doc: TC, bands: letterFive },
  { value: 'NIOS', label: 'NIOS (Open Schooling)', group: 'National', scale_name: 'NIOS letter', pass_mark: 33,
    assessment: 'Continuous, with examinations on demand', leaving_doc: TC, bands: letterFive },
  { value: 'IB', label: 'International Baccalaureate', group: 'International', scale_name: 'IB 1–7', pass_mark: 40,
    assessment: 'Continuous internal assessment against criteria', leaving_doc: 'School Leaving Certificate',
    notes: 'IB reports 1–7 against criteria rather than a percentage. The bands below are an approximation for schools that also keep a percentage; edit them to your own conversion.',
    bands: [band('7', 85, 100, 7), band('6', 75, 84.99, 6), band('5', 65, 74.99, 5), band('4', 55, 64.99, 4),
      band('3', 45, 54.99, 3), band('2', 35, 44.99, 2), band('1', 0, 34.99, 1)] },
  { value: 'CAIE', label: 'Cambridge (CAIE)', group: 'International', scale_name: 'Cambridge A*–G', pass_mark: 40,
    assessment: 'Examination series, with coursework where the syllabus sets it', leaving_doc: 'School Leaving Certificate',
    bands: [band('A*', 90, 100, 0), band('A', 80, 89.99, 0), band('B', 70, 79.99, 0), band('C', 60, 69.99, 0),
      band('D', 50, 59.99, 0), band('E', 40, 49.99, 0), band('U', 0, 39.99, 0)] },
  state('BSE Telangana', 'BSE Telangana (SSC)', 'Telangana', 'Telangana SSC grades', 35, 'Formative and summative assessment across the year', letterFive),
  state('TSBIE', 'TSBIE (Telangana Intermediate)', 'Telangana', 'Intermediate divisions', 35, 'First and second year public examinations', divisionScale),
  state('BSEAP', 'BSEAP (Andhra Pradesh SSC)', 'Andhra Pradesh', 'AP SSC grades', 35, 'Formative and summative assessment across the year', letterFive),
  state('BIEAP', 'BIEAP (AP Intermediate)', 'Andhra Pradesh', 'Intermediate divisions', 35, 'First and second year public examinations', divisionScale),
  state('KSEAB', 'KSEAB (Karnataka SSLC / PUC)', 'Karnataka', 'Karnataka divisions', 35, 'Internal assessment with a public examination', divisionScale),
  state('TN State Board', 'Tamil Nadu State Board', 'Tamil Nadu', 'Tamil Nadu grades', 35, 'Quarterly, half-yearly and annual examinations', letterFive),
  state('Kerala SSLC', 'Kerala (SSLC / DHSE)', 'Kerala', 'Kerala A+ to E', 30, 'Continuous evaluation with terminal examinations',
    [band('A+', 90, 100, 9), band('A', 80, 89.99, 8), band('B+', 70, 79.99, 7), band('B', 60, 69.99, 6), band('C+', 50, 59.99, 5),
      band('C', 40, 49.99, 4), band('D+', 30, 39.99, 3), band('D', 20, 29.99, 2), band('E', 0, 19.99, 1)]),
  state('Maharashtra State Board', 'Maharashtra (MSBSHSE)', 'Maharashtra', 'Maharashtra divisions', 35, 'Terminal examinations with internal marks',
    divisionScale, 'Leaving Certificate (LC)', 'Maharashtra calls it a Leaving Certificate rather than a Transfer Certificate.'),
  state('GSEB', 'Gujarat (GSEB)', 'Gujarat', 'Gujarat grades', 33, 'Terminal examinations with internal marks', letterFive, 'Leaving Certificate (LC)'),
  state('RBSE', 'Rajasthan (RBSE)', 'Rajasthan', 'Rajasthan divisions', 33, 'Half-yearly and annual examinations', divisionScale),
  state('UP Board', 'Uttar Pradesh (UPMSP)', 'Uttar Pradesh', 'UP divisions', 33, 'Half-yearly and annual examinations', divisionScale),
  state('MP Board', 'Madhya Pradesh (MPBSE)', 'Madhya Pradesh', 'MP divisions', 33, 'Half-yearly and annual examinations', divisionScale),
  state('WBBSE', 'West Bengal (WBBSE / WBCHSE)', 'West Bengal', 'West Bengal grades', 25, 'Continuous evaluation with an annual examination', letterFive),
  state('BSEB', 'Bihar (BSEB)', 'Bihar', 'Bihar divisions', 33, 'Annual examination with internal marks', divisionScale),
  state('PSEB', 'Punjab (PSEB)', 'Punjab', 'Punjab grades', 33, 'Terminal examinations with internal marks', letterFive),
  state('HBSE', 'Haryana (HBSE)', 'Haryana', 'Haryana grades', 33, 'Terminal examinations with internal marks', letterFive),
  state('CGBSE', 'Chhattisgarh (CGBSE)', 'Chhattisgarh', 'Chhattisgarh divisions', 33, 'Half-yearly and annual examinations', divisionScale),
  state('BSEO', 'Odisha (BSE Odisha / CHSE)', 'Odisha', 'Odisha grades', 33, 'Continuous evaluation with an annual examination', letterFive),
  state('JAC', 'Jharkhand (JAC)', 'Jharkhand', 'Jharkhand divisions', 33, 'Annual examination with internal marks', divisionScale),
  state('SEBA', 'Assam (SEBA / AHSEC)', 'Assam', 'Assam grades', 30, 'Terminal examinations with internal marks', letterFive),
  state('Other State Board', 'Another board, set the grading yourself', 'Other', 'School grading scale', 35, 'As your school sets it', letterFive, TC,
    'Nothing is assumed. Build the grade bands your board uses, and add your board by name at the bottom of the list so reports can tell it apart.'),
]

/* --- option lists ------------------------------------------------------------ */

export interface Option { value: string; label: string }
const opt = (value: string, label: string): Option => ({ value, label })
const optionsOf = (...names: string[]): Option[] => names.map((n) => opt(n, n))

export const managementTypes: Option[] = [opt('government', 'Government'), opt('aided', 'Aided'), opt('private_unaided', 'Private unaided'),
  opt('model_school', 'Model school'), opt('gurukul', 'Gurukul / residential'), opt('kgbv', 'KGBV'), opt('central', 'Central government (KV, JNV)')]
export const schoolCategories: Option[] = [opt('primary', 'Primary (I–V)'), opt('upper_primary', 'Upper primary (I–VIII)'),
  opt('high_school', 'High school (I–X)'), opt('higher_secondary', 'Higher secondary (I–XII)'), opt('composite', 'Composite')]
export const affiliationBoards: Option[] = boardPresets.map((b) => opt(b.value, b.label))
export const indianStates = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry']
export const telanganaDistricts = ['Adilabad', 'Bhadradri Kothagudem', 'Hanumakonda', 'Hyderabad', 'Jagtial', 'Jangaon',
  'Jayashankar Bhupalpally', 'Jogulamba Gadwal', 'Kamareddy', 'Karimnagar', 'Khammam', 'Komaram Bheem Asifabad', 'Mahabubabad',
  'Mahabubnagar', 'Mancherial', 'Medak', 'Medchal-Malkajgiri', 'Mulugu', 'Nagarkurnool', 'Nalgonda', 'Narayanpet', 'Nirmal',
  'Nizamabad', 'Peddapalli', 'Rajanna Sircilla', 'Rangareddy', 'Sangareddy', 'Siddipet', 'Suryapet', 'Vikarabad', 'Wanaparthy',
  'Warangal', 'Yadadri Bhuvanagiri']
const mediumOptions = [opt('telugu', 'Telugu'), opt('english', 'English'), opt('urdu', 'Urdu'), opt('hindi', 'Hindi'), opt('other', 'Other')]
const bloodGroupOptions = [opt('A+', 'A+'), opt('A-', 'A−'), opt('B+', 'B+'), opt('B-', 'B−'), opt('AB+', 'AB+'), opt('AB-', 'AB−'), opt('O+', 'O+'), opt('O-', 'O−')]
const subjectTypeOptions = [opt('scholastic', 'Scholastic'), opt('co_scholastic', 'Co-scholastic')]

/** The whole customisable vocabulary; null where the school defines it all itself. */
const customisableKinds: Record<string, Option[] | null> = {
  affiliation_board: affiliationBoards, school_category: schoolCategories, management_type: managementTypes,
  medium: mediumOptions, religion: null, mother_tongue: null, caste_category: null, blood_group: bloodGroupOptions,
  document_type: null, subject_type: subjectTypeOptions, fee_head_type: null, staff_designation: null,
  leaving_reason: null, concession_reason: null, state: optionsOf(...indianStates), district: optionsOf(...telanganaDistricts),
  employee_type: null, qualification: null, department_type: null, room_type: null, vehicle_type: null, stop_landmark: null,
  item_category: null, book_category: null, hostel_block_type: null, visitor_purpose: null, complaint_type: null,
  activity_type: null, exam_type: null, lead_source: null, relation: null, nationality: null, payment_mode: null,
  expense_head: null, health_condition: null, achievement_type: null, absence_reason: null,
}

const kindLabels: Record<string, string> = {
  affiliation_board: 'Affiliation boards', school_category: 'School categories', management_type: 'Management types',
  medium: 'Media of instruction', religion: 'Religions', mother_tongue: 'Mother tongues', caste_category: 'Caste categories',
  blood_group: 'Blood groups', document_type: 'Document types', subject_type: 'Subject types', fee_head_type: 'Fee head types',
  staff_designation: 'Staff designations', leaving_reason: 'Reasons for leaving', concession_reason: 'Concession reasons',
  state: 'States and union territories', district: 'Districts', employee_type: 'Employment types', qualification: 'Qualifications',
  department_type: 'Department types', room_type: 'Room types', vehicle_type: 'Vehicle types', stop_landmark: 'Bus stop landmarks',
  item_category: 'Stores item categories', book_category: 'Book categories', hostel_block_type: 'Hostel block types',
  visitor_purpose: 'Visitor purposes', complaint_type: 'Complaint types', activity_type: 'Activity types',
  exam_type: 'Examination types', lead_source: 'Enquiry sources', relation: 'Guardian relations', nationality: 'Nationalities',
  payment_mode: 'Payment modes', expense_head: 'Expense heads', health_condition: 'Health conditions',
  achievement_type: 'Achievement types', absence_reason: 'Absence reasons',
}

interface CustomOption { id?: string; kind?: string; value: string; label: string; sequence?: number; custom?: boolean }

async function customOptionsFor(c: Ctx, kind: string): Promise<CustomOption[]> {
  if (!c.id.institution) return []
  const rows = await c.db.prepare(`SELECT id, value, label, sequence FROM custom_options WHERE kind = ? AND active = 1 ORDER BY sequence, label`)
    .bind(kind).all<{ id: string; value: string; label: string; sequence: number }>()
  return rows.results.map((r) => ({ id: r.id, value: r.value, label: r.label, ...(r.sequence ? { sequence: r.sequence } : {}), custom: true }))
}

/** On the built-in list, or on this school's own. */
export async function allowsValue(c: Ctx, kind: string, value: string): Promise<boolean> {
  if (value === '') return true
  if ((customisableKinds[kind] ?? []).some((o) => o.value === value)) return true
  return (await customOptionsFor(c, kind)).some((o) => o.value === value)
}

function optionValue(label: string): string {
  let out = ''
  let prevDash = false
  for (const ch of label.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) { out += ch; prevDash = false }
    else if (!prevDash && out.length > 0) { out += '_'; prevDash = true }
  }
  return out.replace(/^_+|_+$/g, '')
}

/* --- institution profile ------------------------------------------------------ */

const vpaRe = /^[A-Za-z0-9._-]{3,}@[A-Za-z0-9]{2,}$/
const merchantCodeRe = /^[0-9]{4}$/
const errBadVPA = 'the UPI ID should look like name@bank, for example vivencia@sbi'

type Profile = Record<string, unknown>

export function registerProfile(r: Router): void {
  r.get('/setup/institution', 'institution.read', async (c) => {
    requireInstitution(c)
    const p = await c.db.prepare(`SELECT name, short_name, udise_code, affiliation_board, affiliation_no, state, district, mandal,
        village_or_ward, school_category, management_type, child_info_code, mid_day_meal, timezone, upi_vpa, upi_payee_name
        FROM institutions WHERE id = ?`).bind(instId(c)).first<Profile>()
    if (!p) throw new Error('institution row missing')
    const out: Profile = { name: p.name, short_name: p.short_name }
    for (const k of ['udise_code', 'affiliation_board', 'affiliation_no', 'state', 'district', 'mandal', 'village_or_ward',
      'school_category', 'management_type', 'child_info_code']) if (p[k] !== null && p[k] !== undefined) out[k] = p[k]
    out.mid_day_meal = bool(p.mid_day_meal)
    out.timezone = p.timezone
    if (p.upi_vpa) out.upi_vpa = p.upi_vpa
    if (p.upi_payee_name) out.upi_payee_name = p.upi_payee_name
    return ok(out)
  })

  r.get('/setup/institution/options', 'institution.read', () => ok({
    management_types: managementTypes, school_categories: schoolCategories, affiliation_boards: affiliationBoards,
    telangana_districts: telanganaDistricts, states: indianStates,
  }))

  r.get('/setup/boards', 'institution.read', () => ok({ items: boardPresets }))

  r.post('/setup/boards/apply', 'institution.settings.write', async (c) => {
    const req = await readJSON<{ board?: string }>(c.req)
    const want = trim(req.board)
    const preset = boardPresets.find((b) => b.value.toLowerCase() === want.toLowerCase())
    if (!preset) {
      throw badRequest('there is no ready-made grading scale for that board. Build the bands your board uses under ' +
        'Academics → Grading, and they will be used everywhere marks are graded')
    }
    const existing = await c.db.prepare(`SELECT id FROM grading_scales WHERE name = ?`).bind(preset.scale_name).first<{ id: string }>()
    let scaleId = existing?.id ?? ''
    if (!existing) {
      const haveDefault = await c.db.prepare(`SELECT 1 AS x FROM grading_scales WHERE is_default = 1`).first()
      scaleId = uuid()
      const stmts = [c.db.prepare(`INSERT INTO grading_scales (id, institution_id, name, is_default) VALUES (?, ?, ?, ?)`)
        .bind(scaleId, instId(c), preset.scale_name, haveDefault ? 0 : 1)]
      for (const b of preset.bands) {
        stmts.push(c.db.prepare(`INSERT INTO grade_bands (id, institution_id, grading_scale_id, grade, min_percent, max_percent, grade_point) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(uuid(), instId(c), scaleId, b.grade, String(b.min_percent), String(b.max_percent), b.grade_point && b.grade_point > 0 ? String(b.grade_point) : null))
      }
      await c.db.batch(stmts)
    }
    return ok({ scale_id: scaleId, scale_name: preset.scale_name, bands: preset.bands.length, already_existed: !!existing })
  })

  r.get('/setup/option-kinds', 'institution.read', () => {
    const items = Object.entries(customisableKinds)
      .map(([kind, builtin]) => ({ kind, label: kindLabels[kind] ?? '', builtins: builtin?.length ?? 0 }))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    return ok({ items })
  })

  r.get('/setup/options', 'institution.read', async (c) => {
    const kind = (c.url.searchParams.get('kind') ?? '').trim()
    if (!(kind in customisableKinds)) throw badRequest('unknown option list: ' + kind)
    const builtin = customisableKinds[kind] ?? []
    const items: CustomOption[] = builtin.map((o) => ({ value: o.value, label: o.label }))
    items.push(...(await customOptionsFor(c, kind)))
    return ok({ items })
  })

  r.post('/setup/options', 'institution.settings.write', async (c) => {
    requireInstitution(c)
    const req = await readJSON<{ kind?: string; label?: string; value?: string; sequence?: number }>(c.req)
    const kind = trim(req.kind)
    const label = trim(req.label)
    if (!(kind in customisableKinds)) throw badRequest('unknown option list: ' + kind)
    if (label === '') throw badRequest('the option needs a label')
    let value = trim(req.value)
    if (value === '') value = optionValue(label)
    if (value === '') throw badRequest('that label has no letters or digits to make a value from')
    for (const o of customisableKinds[kind] ?? []) {
      if (o.value.toLowerCase() === value.toLowerCase() || o.label.toLowerCase() === label.toLowerCase()) {
        throw badRequest('that one is already on the standard list as ' + o.label)
      }
    }
    // The unique index on (institution_id, kind, value) is a partial one in
    // Postgres; checked here so a duplicate reads as the 409 it was.
    const dup = await c.db.prepare(`SELECT 1 AS x FROM custom_options WHERE kind = ? AND value = ? COLLATE NOCASE`).bind(kind, value).first()
    if (dup) throw conflict('your school already has that one')
    const id = uuid()
    const t = now()
    const sequence = Number(req.sequence ?? 0) || 0
    try {
      await c.db.prepare(`INSERT INTO custom_options (id, institution_id, kind, value, label, sequence, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, instId(c), kind, value, label, sequence, t, t).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('your school already has that one')
      throw e
    }
    const out: CustomOption = { id, kind, value, label, custom: true }
    if (sequence) out.sequence = sequence
    return created(out)
  })

  r.del('/setup/options/{id}', 'institution.settings.write', async (c) => {
    requireInstitution(c)
    const oid = uuidParam(c.params.id)
    // custom_options_touch trigger: updated_at moves with the row.
    const res = await c.db.prepare(`UPDATE custom_options SET active = 0, updated_at = ? WHERE id = ?`).bind(now(), oid).run()
    if (!res.meta.changes) throw notFound('no such option')
    return ok({ id: oid, active: false })
  })

  r.put('/setup/institution', 'institution.write', async (c) => {
    requireInstitution(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = trim(req.name)
    if (name === '') throw badRequest("the school's name is required")
    const udise = trim(req.udise_code)
    if (udise !== '' && !isDigits(udise, 11)) throw badRequest('udise code must be 11 digits')
    const fields: Array<[string, string]> = [
      ['management_type', trim(req.management_type)], ['school_category', trim(req.school_category)],
      ['affiliation_board', trim(req.affiliation_board)],
    ]
    for (const [kind, value] of fields) {
      if (!(await allowsValue(c, kind, value))) {
        throw badRequest('that is not one of your ' + kindLabels[kind] + '. Add it to the list first, then choose it')
      }
    }
    let short = trim(req.short_name)
    if (short === '') short = deriveShortName(name)
    // institutions_touch trigger: updated_at is stamped here.
    await c.db.prepare(`UPDATE institutions SET name = ?, short_name = ?, udise_code = ?, affiliation_board = ?, affiliation_no = ?,
        state = ?, district = ?, mandal = ?, village_or_ward = ?, school_category = ?, management_type = ?, child_info_code = ?,
        mid_day_meal = ?, updated_at = ? WHERE id = ?`)
      .bind(name, short, nullStr(udise), nullStr(trim(req.affiliation_board)), nullStr(trim(req.affiliation_no)),
        nullStr(trim(req.state)), nullStr(trim(req.district)), nullStr(trim(req.mandal)), nullStr(trim(req.village_or_ward)),
        nullStr(trim(req.school_category)), nullStr(trim(req.management_type)), nullStr(trim(req.child_info_code)),
        req.mid_day_meal === true ? 1 : 0, now(), instId(c)).run()
    return ok({ name, short_name: short })
  })

  r.get('/setup/payments', 'institution.read', async (c) => {
    requireInstitution(c)
    const row = await c.db.prepare(`SELECT COALESCE(upi_vpa,'') AS upi_vpa, COALESCE(upi_payee_name,'') AS upi_payee_name,
        COALESCE(upi_merchant_code,'') AS upi_merchant_code, name FROM institutions WHERE id = ?`).bind(instId(c))
      .first<{ upi_vpa: string; upi_payee_name: string; upi_merchant_code: string; name: string }>()
    if (!row) throw new Error('institution row missing')
    const out: Record<string, unknown> = { upi_vpa: row.upi_vpa, upi_payee_name: row.upi_payee_name, upi_merchant_code: row.upi_merchant_code }
    if (row.name) out.school_name = row.name
    return ok(out)
  })

  r.put('/setup/payments', 'institution.write', async (c) => {
    requireInstitution(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const vpa = trim(req.upi_vpa)
    if (vpa !== '' && !vpaRe.test(vpa)) throw badRequest(errBadVPA)
    let payee = trim(req.upi_payee_name)
    if (vpa === '') payee = ''
    let merchant = trim(req.upi_merchant_code)
    if (vpa === '') merchant = ''
    if (merchant !== '' && !merchantCodeRe.test(merchant)) {
      throw badRequest('the merchant category code is the four digits the bank gave you, such as 8211')
    }
    await c.db.prepare(`UPDATE institutions SET upi_vpa = ?, upi_payee_name = ?, upi_merchant_code = ?, updated_at = ? WHERE id = ?`)
      .bind(nullStr(vpa), nullStr(payee), nullStr(merchant), now(), instId(c)).run()
    return ok({ upi_vpa: vpa, upi_payee_name: payee, upi_merchant_code: merchant })
  })

  /* --- campuses --- */

  r.get('/setup/campuses', 'institution.read', async (c) => {
    requireInstitution(c)
    const rows = await c.db.prepare(`SELECT c.id, c.name, c.code, c.city, c.state, c.pincode, c.phone, c.status,
        (SELECT COUNT(*) FROM students st WHERE st.campus_id = c.id AND st.status = 'active') AS students
        FROM campuses c ORDER BY c.created_at`).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const o: Record<string, unknown> = { id: v.id, name: v.name, code: v.code }
      for (const k of ['city', 'state', 'pincode', 'phone']) if (v[k] !== null) o[k] = v[k]
      o.status = v.status
      o.students = Number(v.students ?? 0)
      return o
    })
    return ok({ items })
  })

  r.post('/setup/campuses', 'institution.write', async (c) => {
    requireInstitution(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = trim(req.name)
    if (name === '') throw badRequest('the campus needs a name')
    let code = trim(req.code)
    if (code === '') code = deriveShortName(name)
    const id = uuid()
    const t = now()
    try {
      await c.db.prepare(`INSERT INTO campuses (id, institution_id, name, code, address_line1, address_line2, city, state, pincode, phone, email, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, instId(c), name, code.toUpperCase(), nullStr(trim(req.address_line1)), nullStr(trim(req.address_line2)),
          nullStr(trim(req.city)), nullStr(trim(req.state)), nullStr(trim(req.pincode)), nullStr(trim(req.phone)), nullStr(trim(req.email)), t, t).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw badRequest('a campus with that code already exists')
      throw e
    }
    return created({ id, name })
  })

  r.put('/setup/campuses/{id}', 'institution.write', async (c) => {
    requireInstitution(c)
    const cid = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = trim(req.name)
    if (name === '') throw badRequest('the campus needs a name')
    // campuses_touch trigger: updated_at is stamped here.
    const res = await c.db.prepare(`UPDATE campuses SET name = ?, code = COALESCE(NULLIF(?, ''), code), address_line1 = ?, address_line2 = ?,
        city = ?, state = ?, pincode = ?, phone = ?, email = ?, updated_at = ? WHERE id = ?`)
      .bind(name, trim(req.code).toUpperCase(), nullStr(trim(req.address_line1)), nullStr(trim(req.address_line2)), nullStr(trim(req.city)),
        nullStr(trim(req.state)), nullStr(trim(req.pincode)), nullStr(trim(req.phone)), nullStr(trim(req.email)), now(), cid).run()
      .catch((e) => { throw isUniqueViolation(e) ? badRequest('a campus with that code already exists') : e })
    if (!res.meta.changes) throw notFound('resource not found')
    return ok({ id: cid, name })
  })
}
