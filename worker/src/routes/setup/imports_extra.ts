import { uuid, now } from '../../http'
import { str, todayIndia } from './common'
import type { ImportSpec, ImportCtx } from './imports'
import { paiseOrNil, numOrNil, isWholeNumber, withinWindow, normaliseHeader } from './imports'

/* The payroll sheets of bulk_import.go: the standing salary and bank
   details keyed by staff code, and months already paid before go-live. */

async function employeeByCode(ctx: ImportCtx, code: string, exact: boolean): Promise<string | null> {
  const row = exact
    ? await ctx.db.prepare(`SELECT id FROM employees WHERE institution_id = ? AND employee_code = ?`).bind(ctx.inst, code).first<{ id: string }>()
    : await ctx.db.prepare(`SELECT id FROM employees WHERE institution_id = ? AND lower(employee_code) = lower(?)`).bind(ctx.inst, code).first<{ id: string }>()
  if (row) return row.id
  /* THE SCHOOL'S OWN STAFF ID (owner, 2026-10-15: "this september payroll of
     yajur is not match with our payroll why").

     Yajur keeps its own staff IDs -- T001, T002, N004 -- on its salary sheet
     and on the biometric reader. Our records carry the codes the MyClassBoard
     import gave them (YPS59100001...), so the salary sheet matched by staff
     code found nobody: 0 of 47 rows, and every Basic/HRA/DA split the school
     typed was refused. The reader PIN is that same school ID, already linked
     to the right person, so it is the second place to look -- measured on
     Yajur's September sheet it finds 46 of 47, each pairing correct.

     A letter O typed for a zero ("TO62") is read as the zero it meant, and a
     PIN shared by two people is no match at all rather than a guess. */
  const id = code.trim().toUpperCase().replace(/O(?=\d)/g, '0')
  if (!id) return null
  const byPin = await ctx.db.prepare(`SELECT id FROM employees WHERE institution_id = ? AND upper(trim(CAST(device_user_id AS TEXT))) = ? LIMIT 2`)
    .bind(ctx.inst, id).all<{ id: string }>()
  return byPin.results.length === 1 ? byPin.results[0].id : null
}

const monthLabel = (m: string): string => new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export function registerImportSpecsExtra(specs: Record<string, ImportSpec>): void {
  specs.staff_payroll = {
    perm: 'hr.payroll.write', columns: ['staff_code', 'name', 'bank_account', 'ifsc', 'gross_salary'], required: ['staff_code'], identity: 'staff_code',
    sample: ['YPS59100001', 'RAMYA SRI RACHERLA', '7707198963', 'IDIB000L009', '80143'],
    check: (row) => {
      const g = str(row.gross_salary).replace(/,/g, '').trim()
      if (g !== '' && (!isWholeNumber(g) || Number(g) < 0)) throw new Error('gross_salary must be a whole number of rupees that is not negative')
      if (str(row.bank_account).trim() === '' && str(row.ifsc).trim() === '' && g === '') throw new Error('a row must carry a bank account, an IFSC or a salary, this one has none')
    },
    verify: async (ctx, row) => {
      if (!(await employeeByCode(ctx, str(row.staff_code).trim(), true))) throw new Error(`nobody on the roll with employee code "${str(row.staff_code).trim()}". Import the staff first`)
    },
    // Bank and IFSC are written as a pair: one given clears the other if blank.
    replaces: async (ctx, row) => {
      const bank = str(row.bank_account).trim(), ifsc = str(row.ifsc).trim()
      if (bank === '' && ifsc === '') return []
      const empId = await employeeByCode(ctx, str(row.staff_code).trim(), true)
      const cur = empId ? await ctx.db.prepare(`SELECT bank_account, bank_ifsc FROM employees WHERE id = ?`).bind(empId).first<{ bank_account: string | null; bank_ifsc: string | null }>() : null
      if (!cur) return []
      return [{ field: 'bank_account', label: 'bank account', from: cur.bank_account, to: bank }, { field: 'bank_ifsc', label: 'IFSC', from: cur.bank_ifsc, to: ifsc }]
    },
    write: async (ctx, row) => {
      const empId = await employeeByCode(ctx, str(row.staff_code).trim(), true)
      if (!empId) throw new Error('no rows in result set')
      const bank = str(row.bank_account).trim(), ifsc = str(row.ifsc).trim()
      if (bank !== '' || ifsc !== '') await ctx.db.prepare(`UPDATE employees SET bank_account = NULLIF(?, ''), bank_ifsc = NULLIF(?, '') WHERE id = ?`).bind(bank, ifsc, empId).run()
      const g = str(row.gross_salary).replace(/,/g, '').trim()
      if (g === '') return
      const paise = Number(g) * 100
      const open = await ctx.db.prepare(`SELECT id FROM salary_structures WHERE institution_id = ? AND employee_id = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`)
        .bind(ctx.inst, empId).first<{ id: string }>()
      if (open) { await ctx.db.prepare(`UPDATE salary_structures SET ctc_paise = ? WHERE id = ?`).bind(paise, open.id).run(); return }
      let from: string | null = null
      if (ctx.year) {
        const y = await ctx.db.prepare(`SELECT starts_on FROM academic_years WHERE id = ?`).bind(ctx.year).first<{ starts_on: string }>()
        from = y?.starts_on ?? null
      }
      const id = uuid()
      await ctx.db.prepare(`INSERT INTO salary_structures (id, institution_id, employee_id, effective_from, ctc_paise, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, ctx.inst, empId, from ?? todayIndia(), paise, now()).run()
      ctx.noteCreated('staff_payroll', id, true)
    },
  }

  /* THE SCHOOL'S OWN SALARY SHEET, READ BACK IN (Yajur, 2026-10-13: "add csv
     import"). The same columns as the School format download, so a sheet can
     go out, be corrected and come back. Each row fills the staff record
     (designation, mobile, joining date, bank, PAN, UAN, the last four of
     Aadhaar) and sets the standing monthly salary as Basic, HRA, DA, CA and
     OA, which is what a payroll run pays from. Columns the sheet works out
     (gross, EPF, ESI, LOP, net) are ignored: the run works them out again. */
  /* ONE COLUMN PER PAY COMPONENT (Yajur, 2026-10-14: "let the template
     headings follow the components; if they have PF add PF; they upload it
     and Revise shows every component, PF too, still editable by hand").
     The template is built from salary_components at download time, so a
     part the school adds is a column the next time. A cell is rupees a
     month, or a percent written "40%" (of Basic, or of the gross for a
     component whose rule says so). PF takes two columns: the employee's own
     percent (blank = school rate) and what it is taken on. Blank cells keep
     what is there. */
  const SHEET_FIXED = ['Employee ID', 'Employee Name', 'Designation', 'Mobile Number', 'Subject', 'Date of Joining', 'Bank Account Number', 'IFSC', 'Aadhaar', 'PAN', 'UAN']
  const SHEET_FIXED_SAMPLE = ['YPS59100001', 'RAMYA SRI RACHERLA', 'Teacher', '9876543210', 'English', '01/06/2024', '7707198963', 'IDIB000L009', '123412341234', 'ABCDE1234F', '100123456789']
  const PF_COLS = ['Provident fund %', 'PF on']
  const PF_KEYS = PF_COLS.map(normaliseHeader)
  // Old and short headings a cell may still arrive under, by component code.
  const SHEET_ALIAS: Record<string, string[]> = {
    BASIC: ['basic', 'basic_pay'], HRA: ['house_rent_allowance', 'h.r.a', 'hra'], DA: ['dearness_allowance', 'da'],
    CONVEY: ['conveyance_allowance', 'conveyance', 'ca'], SPECIAL: ['other_allowance', 'special_allowance', 'oa'], TDS: ['income_tax_(tds)', 'tds', 'income_tax'],
  }
  type SheetComp = { id: string; code: string; name: string; kind: string; is_percent: number; percent_of: string | null; default_value: number | null }
  const sheetComps = async (db: D1Database): Promise<SheetComp[]> => {
    try {
      return (await db.prepare(`SELECT id, code, name, kind, is_percent, percent_of, default_value FROM salary_components WHERE code NOT IN ('PF', 'ESI', 'PT') ORDER BY sequence, name`).all<SheetComp>()).results
    } catch {
      return (await db.prepare(`SELECT id, code, name, kind, is_percent, percent_of, NULL AS default_value FROM salary_components WHERE code NOT IN ('PF', 'ESI', 'PT') ORDER BY sequence, name`).all<SheetComp>()).results
    }
  }
  const hasPf = async (db: D1Database) => !!(await db.prepare(`SELECT 1 FROM salary_components WHERE code = 'PF'`).first())
  const compCell = (row: Record<string, unknown>, comp: SheetComp): string => {
    const keys = [normaliseHeader(comp.name), normaliseHeader(comp.code), ...(SHEET_ALIAS[comp.code] ?? [])]
    for (const k of keys) { const v = str(row[k]).trim(); if (v !== '') return v }
    return ''
  }
  /** "15000", "15,000", "40%" → { percent } or { paise }; '' → null. */
  const payCell = (raw: string): { percent?: number; paise?: number } | null => {
    const t = raw.replace(/[,₹\s]/g, '')
    if (t === '' || t === '-') return null
    if (t.endsWith('%')) {
      const n = Number(t.slice(0, -1))
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`"${raw}" is not a percent between 0 and 100`)
      return { percent: n }
    }
    const n = Number(t)
    if (!Number.isFinite(n) || n < 0) throw new Error(`"${raw}" is not an amount of rupees (or a percent like 40%)`)
    return { paise: Math.round(n * 100) }
  }
  const pfOnCell = (raw: string): string | null => {
    const t = raw.trim().toLowerCase().replace(/[\s+_-]+/g, '')
    if (t === '') return null
    if (['none', 'no', 'nopf', 'off'].includes(t)) return 'none'
    if (['basic', 'basiconly'].includes(t)) return 'basic'
    if (['basicda', 'basicanda', 'basicplusda'].includes(t)) return 'basic_da'
    if (['school', 'schoolrule', 'default'].includes(t)) return 'default'
    throw new Error(`PF on "${raw}" should be Basic, Basic + DA, None or School rule`)
  }
  const sheetDate = (v: unknown): string | null => {
    const t = str(v).trim()
    if (t === '') return null
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
    if (m) return t
    m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(t)
    /* NOT GUESSED (owner, 2026-10-15: Yajur's September sheet). One column
       held "1/1/2024", "4/19/2024", "22-03-2024" and "12.08.2026": slashes
       saved by Excel month-first, dashes and dots typed day-first. Read as
       day-first throughout, "4/19/2024" became month 19 and was stored. So a
       date is taken only when it can be read one way: a part over 12 says
       which is the day; two parts that are both 12 or under are ambiguous
       and the date is left as it was. Payroll does not need it, and a wrong
       joining date is worse than none. */
    if (!m) return null
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    const a = Number(m[1]), b = Number(m[2])
    let day: number, month: number
    if (a > 12 && b <= 12) { day = a; month = b }
    else if (b > 12 && a <= 12) { day = b; month = a }
    else if (a === b) { day = a; month = b }
    else return null
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const SHEET_OLD: [string, string][] = [['employee_id', 'emp_id'], ['employee_name', 'name'], ['date_of_joining', 'd.o.j'],
    ['bank_account_number', 'a/c_number'], ['ifsc', 'ifsc_code'], ['aadhaar', 'aadhar'], ['designation', 'desig_nation']]
  const sheetRow = (row: Record<string, string>) => {
    for (const [now, was] of SHEET_OLD) if ((row[now] ?? '') === '' && (row[was] ?? '') !== '') row[now] = row[was]
  }
  specs.salary_sheet = {
    perm: 'hr.payroll.write',
    columns: [...SHEET_FIXED, 'Basic', 'House Rent Allowance', 'Dearness Allowance', 'Conveyance Allowance', 'Other Allowance'],
    columnsFor: async (c) => {
      const comps = await sheetComps(c.db)
      const pf = await hasPf(c.db)
      const sample = comps.map((x) => {
        if (x.default_value != null && x.default_value > 0) return x.is_percent ? `${x.default_value}%` : String(x.default_value)
        return x.is_percent ? '40%' : x.kind === 'earning' ? '5000' : '0'
      })
      return {
        columns: [...SHEET_FIXED, ...comps.map((x) => x.name), ...(pf ? PF_COLS : [])],
        sample: [...SHEET_FIXED_SAMPLE, ...sample, ...(pf ? ['', 'School rule'] : [])],
      }
    },
    required: [], identity: 'employee_id',
    sample: [...SHEET_FIXED_SAMPLE, '15000', '6000', '0', '1600', '2400'],
    check: (row) => {
      sheetRow(row)
      if (str(row.employee_id).trim() === '') throw new Error('Employee ID is required')
      /* EXCEL SHORTENS LONG NUMBERS (owner, 2026-10-15: a September sheet
         had every UAN as 1.01711E+11). The digits after the fifth are gone, so
         saving it would store a wrong UAN or account number. Refused, with the
         fix, rather than kept. */
      /* A UAN, account number or Aadhaar Excel has shortened ("1.01711E+11")
         has lost its digits, so that one cell is dropped and the record keeps
         what it had. Refusing the row instead threw away the salary split the
         school typed beside it -- on Yajur's sheet, all 47 rows over one
         column. An amount in that shape is still refused: pay is not guessed. */
      for (const k of ['uan', 'bank_account_number', 'a/c_number', 'aadhaar', 'aadhar']) {
        if (/^\s*\d(\.\d+)?e\+\d+\s*$/i.test(str(row[k]))) row[k] = ''
      }
      for (const [k, v] of Object.entries(row)) {
        if (/^\s*\d(\.\d+)?e\+\d+\s*$/i.test(str(v))) throw new Error(`${k.replace(/_/g, ' ')} is "${str(v).trim()}": Excel has shortened this number and the real digits are lost. In Excel, set that column to Text, type the numbers again, and save`)
      }
      sheetDate(row.date_of_joining)
      /* Only the pay parts are amounts. A school's own sheet carries columns
         the import does not use (S.No., LOAN, GROSS, the statutory totals);
         write() never reads them, so they are not checked here either. The
         school's own component names are checked in verify(). */
      const payKeys = new Set(Object.values(SHEET_ALIAS).flat())
      for (const [k, v] of Object.entries(row)) if (payKeys.has(k) && str(v).trim() !== '') payCell(str(v))
      const pfp = str(row[PF_KEYS[0]]).trim()
      if (pfp !== '') { const n = Number(pfp.replace('%', '')); if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`Provident fund % "${pfp}" should be between 0 and 100`) }
      pfOnCell(str(row[PF_KEYS[1]]))
    },
    verify: async (ctx, row) => {
      sheetRow(row)
      if (!(await employeeByCode(ctx, str(row.employee_id).trim(), false))) throw new Error(`nobody on the roll with Employee ID "${str(row.employee_id).trim()}". Import the staff first`)
      for (const comp of await sheetComps(ctx.db)) payCell(compCell(row, comp))
    },
    // Each cell fills or replaces (a blank cell keeps what is there).
    replaces: async (ctx, row) => {
      const empId = await employeeByCode(ctx, str(row.employee_id).trim(), false)
      const cur = empId ? await ctx.db.prepare(`SELECT phone, bank_account, bank_ifsc, aadhaar_last4, pan, uan FROM employees WHERE id = ?`).bind(empId).first<Record<string, string | null>>() : null
      if (!cur) return []
      const cell = (k: string) => str(row[k]).trim()
      const digits = cell('aadhaar').replace(/\D/g, '')
      const want: Record<string, string> = {
        phone: cell('mobile_number').replace(/\D/g, '').slice(-10), bank_account: cell('bank_account_number').replace(/\s/g, ''), bank_ifsc: cell('ifsc').toUpperCase(),
        aadhaar_last4: digits.length >= 4 ? digits.slice(-4) : '', pan: cell('pan').toUpperCase(), uan: cell('uan').replace(/\s/g, ''),
      }
      const label: Record<string, string> = { phone: 'phone', bank_account: 'bank account', bank_ifsc: 'IFSC', aadhaar_last4: 'Aadhaar (last 4)', pan: 'PAN', uan: 'UAN' }
      return Object.entries(want).filter(([, v]) => v !== '').map(([k, v]) => ({ field: k, label: label[k], from: cur[k], to: v }))
    },
    write: async (ctx, row) => {
      sheetRow(row)
      const empId = await employeeByCode(ctx, str(row.employee_id).trim(), false)
      if (!empId) throw new Error('no rows in result set')
      const cell = (k: string) => str(row[k]).trim()
      const digits = cell('aadhaar').replace(/\D/g, '')
      let designationId: string | null = null
      if (cell('designation')) {
        const d = await ctx.db.prepare(`SELECT id FROM designations WHERE institution_id = ? AND lower(name) = lower(?)`).bind(ctx.inst, cell('designation')).first<{ id: string }>()
        if (d) designationId = d.id
        else {
          designationId = uuid()
          await ctx.db.prepare(`INSERT INTO designations (id, institution_id, name) VALUES (?, ?, ?)`).bind(designationId, ctx.inst, cell('designation')).run()
        }
      }
      await ctx.db.prepare(`UPDATE employees SET designation_id = COALESCE(?, designation_id), phone = COALESCE(NULLIF(?, ''), phone),
          joined_on = COALESCE(?, joined_on), bank_account = COALESCE(NULLIF(?, ''), bank_account), bank_ifsc = COALESCE(NULLIF(?, ''), bank_ifsc),
          aadhaar_last4 = COALESCE(NULLIF(?, ''), aadhaar_last4), pan = COALESCE(NULLIF(upper(?), ''), pan), uan = COALESCE(NULLIF(?, ''), uan) WHERE id = ?`)
        .bind(designationId, cell('mobile_number').replace(/\D/g, '').slice(-10), sheetDate(row.date_of_joining), cell('bank_account_number').replace(/\s/g, ''),
          cell('ifsc').toUpperCase(), digits.length >= 4 ? digits.slice(-4) : '', cell('pan'), cell('uan').replace(/\s/g, ''), empId).run()

      // PF, by the person's own column: percent and what it is taken on.
      const pfPct = cell(PF_KEYS[0]).replace('%', '')
      const pfOn = pfOnCell(cell(PF_KEYS[1]))
      if (pfPct !== '' || pfOn !== null) {
        try {
          await ctx.db.prepare(`UPDATE employees SET pf_percent = CASE WHEN ? = '' THEN pf_percent ELSE ? END, pf_mode = COALESCE(?, pf_mode) WHERE id = ?`)
            .bind(pfPct, pfPct === '' ? null : Number(pfPct), pfOn, empId).run()
        } catch { throw new Error('PF by person needs a database update first (migration 0085)') }
      }

      /* THE SHEET'S OWN PF AND ESI COLUMNS (Yajur, 2026-10-15: "from now on
         all the payrolls should be match"). A school's sheet often carries
         what it actually took -- "Employee EPF Share", "Employee ESI" -- and
         a 0 there for someone who has a Basic, or who is under the ESI limit,
         is the school's choice for that person. Read as that choice, so every
         later month comes out the same as the sheet. A column that is absent
         changes nothing. */
      const statCol = (prefix: string) => Object.keys(row).find((k) => k.startsWith(prefix) && str(row[k]).trim() !== '')
      const epfKey = statCol('employee_epf'), esiKey = statCol('employee_esi')
      if (epfKey && pfPct === '' && pfOn === null) {
        const took = Number(str(row[epfKey]).replace(/,/g, ''))
        const basicCell = Number(str(row.basic ?? row.basic_pay ?? '').replace(/,/g, ''))
        if (Number.isFinite(took) && basicCell > 0) {
          try { await ctx.db.prepare(`UPDATE employees SET pf_mode = ? WHERE id = ?`).bind(took === 0 ? 'none' : 'default', empId).run() } catch { /* 0085 not applied */ }
        }
      }
      if (esiKey) {
        const took = Number(str(row[esiKey]).replace(/,/g, ''))
        /* Above the ESI limit a 0 is the law, not a choice: left alone. */
        const grossKey = Object.keys(row).find((k) => k.startsWith('gross'))
        const sheetGross = grossKey ? Number(str(row[grossKey]).replace(/,/g, '')) : NaN
        if (Number.isFinite(took) && (took > 0 || (Number.isFinite(sheetGross) && sheetGross > 0 && sheetGross <= 21000))) {
          try { await ctx.db.prepare(`UPDATE employees SET esi_applies = ? WHERE id = ?`).bind(took > 0 ? 1 : 0, empId).run() } catch { /* 0088 not applied */ }
        }
      }

      // The pay parts: rupees as given, percents worked out from Basic (or
      // the gross of the rupee cells, for a part whose rule is of the gross).
      const comps = await sheetComps(ctx.db)
      const given: { comp: SheetComp; v: { percent?: number; paise?: number } }[] = []
      for (const comp of comps) { const v = payCell(compCell(row, comp)); if (v) given.push({ comp, v }) }
      if (given.length === 0) return
      const rupeeGross = given.filter((g) => g.comp.kind === 'earning' && g.v.paise != null).reduce((a, g) => a + (g.v.paise ?? 0), 0)
      const basicGiven = given.find((g) => g.comp.code === 'BASIC')
      const basicPaise = basicGiven?.v.paise ?? (basicGiven?.v.percent != null ? Math.round((rupeeGross * basicGiven.v.percent) / 100) : 0)
      const items = given.map((g) => {
        const base = g.comp.percent_of === 'GROSS' ? rupeeGross : basicPaise
        const amount = g.v.paise ?? Math.round((base * (g.v.percent ?? 0)) / 100)
        return { comp: g.comp, amount, percent: g.v.percent ?? null }
      })
      const total = items.filter((i) => i.comp.kind === 'earning').reduce((a, i) => a + i.amount, 0)
      let open = await ctx.db.prepare(`SELECT id FROM salary_structures WHERE institution_id = ? AND employee_id = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`)
        .bind(ctx.inst, empId).first<{ id: string }>()
      if (open) { if (total > 0) await ctx.db.prepare(`UPDATE salary_structures SET ctc_paise = ? WHERE id = ?`).bind(total, open.id).run() }
      else {
        let from: string | null = null
        if (ctx.year) from = (await ctx.db.prepare(`SELECT starts_on FROM academic_years WHERE id = ?`).bind(ctx.year).first<{ starts_on: string }>())?.starts_on ?? null
        open = { id: uuid() }
        await ctx.db.prepare(`INSERT INTO salary_structures (id, institution_id, employee_id, effective_from, ctc_paise, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(open.id, ctx.inst, empId, from ?? todayIndia(), total, now()).run()
        ctx.noteCreated('salary_sheet', open.id, true)
      }
      for (const it of items) {
        await ctx.db.prepare(`DELETE FROM salary_structure_items WHERE salary_structure_id = ? AND component_id = ?`).bind(open.id, it.comp.id).run()
        await ctx.db.prepare(`INSERT INTO salary_structure_items (id, institution_id, salary_structure_id, component_id, amount_paise, percent) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(uuid(), ctx.inst, open.id, it.comp.id, it.amount, it.percent == null ? null : String(it.percent)).run()
      }
    },
  }

  specs.payslips = {
    perm: 'hr.payroll.write', columns: ['employee_code', 'month', 'paid_days', 'lop_days', 'gross', 'deductions', 'net'], required: ['employee_code', 'month', 'gross', 'net'],
    sample: ['EMP001', '2026-04', '30', '0', '45000', '3600', '41400'],
    check: (row) => {
      if (str(row.employee_code).trim() === '') throw new Error("every row needs the staff member's code")
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(str(row.month).trim())) throw new Error('month must be written as 2026-04')
      for (const k of ['gross', 'net']) {
        const v = paiseOrNil(str(row[k]))
        if (v === null) throw new Error(`${k} must be a number of rupees, like 45000`)
        if (v < 0) throw new Error(`${k} cannot be less than nothing`)
      }
      const d = paiseOrNil(str(row.deductions))
      if (d !== null && d < 0) throw new Error('deductions cannot be less than nothing')
      const g = paiseOrNil(str(row.gross)) ?? 0, n = paiseOrNil(str(row.net)) ?? 0
      if (str(row.deductions).trim() !== '' && g - (d ?? 0) !== n) {
        throw new Error(`net should be gross minus deductions. This row says ${Math.trunc(g / 100)} - ${Math.trunc((d ?? 0) / 100)}, which is ${Math.trunc((g - (d ?? 0)) / 100)}, but net says ${Math.trunc(n / 100)}`)
      }
    },
    verify: async (ctx, row) => {
      const code = str(row.employee_code).trim()
      if (!(await employeeByCode(ctx, code, false))) throw new Error(`no staff member with code "${code}". Import the staff first`)
      const m = str(row.month).trim()
      withinWindow(ctx.sheet, m + '-01', 'this month')
      const [y, mo] = m.split('-').map(Number)
      const run = await ctx.db.prepare(`SELECT run_by FROM payroll_runs WHERE institution_id = ? AND period_year = ? AND period_month = ?`).bind(ctx.inst, y, mo).first<{ run_by: string | null }>()
      if (run?.run_by) throw new Error(`payroll for ${monthLabel(m)} was already run in this system. Loading over it would replace what it worked out, delete that run first if you really mean to`)
    },
    write: async (ctx, row) => {
      const empId = await employeeByCode(ctx, str(row.employee_code).trim(), false)
      if (!empId) throw new Error('no rows in result set')
      const m = str(row.month).trim()
      const [y, mo] = m.split('-').map(Number)
      const gross = paiseOrNil(str(row.gross)) ?? 0, net = paiseOrNil(str(row.net)) ?? 0
      const ded = paiseOrNil(str(row.deductions)) ?? gross - net
      let run = await ctx.db.prepare(`SELECT id FROM payroll_runs WHERE institution_id = ? AND period_year = ? AND period_month = ?`).bind(ctx.inst, y, mo).first<{ id: string }>()
      if (!run) {
        const id = uuid()
        await ctx.db.prepare(`INSERT INTO payroll_runs (id, institution_id, period_year, period_month, status, gross_paise, deduction_paise, net_paise, employees, created_at) VALUES (?, ?, ?, ?, 'paid', 0, 0, 0, 0, ?)`)
          .bind(id, ctx.inst, y, mo, now()).run()
        run = { id }
      }
      const paidDays = numOrNil(str(row.paid_days)) ?? 0, lopDays = numOrNil(str(row.lop_days)) ?? 0
      const existing = await ctx.db.prepare(`SELECT id FROM payslips WHERE payroll_run_id = ? AND employee_id = ?`).bind(run.id, empId).first<{ id: string }>()
      if (existing) {
        await ctx.db.prepare(`UPDATE payslips SET paid_days = ?, lop_days = ?, gross_paise = ?, deduction_paise = ?, net_paise = ?, breakup = ? WHERE id = ?`)
          .bind(String(paidDays), String(lopDays), gross, ded, net, JSON.stringify({ source: 'import' }), existing.id).run()
      } else {
        const id = uuid()
        await ctx.db.prepare(`INSERT INTO payslips (id, institution_id, payroll_run_id, employee_id, paid_days, lop_days, gross_paise, deduction_paise, net_paise, breakup, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, ctx.inst, run.id, empId, String(paidDays), String(lopDays), gross, ded, net, JSON.stringify({ source: 'import' }), now()).run()
        ctx.noteCreated('payslips', id, true)
      }
      await ctx.db.prepare(`UPDATE payroll_runs SET gross_paise = (SELECT COALESCE(SUM(gross_paise), 0) FROM payslips WHERE payroll_run_id = ?1),
          deduction_paise = (SELECT COALESCE(SUM(deduction_paise), 0) FROM payslips WHERE payroll_run_id = ?1),
          net_paise = (SELECT COALESCE(SUM(net_paise), 0) FROM payslips WHERE payroll_run_id = ?1),
          employees = (SELECT COUNT(*) FROM payslips WHERE payroll_run_id = ?1) WHERE id = ?1`).bind(run.id).run()
    },
  }
}

