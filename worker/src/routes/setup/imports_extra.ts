import { uuid, now } from '../../http'
import { str, todayIndia } from './common'
import type { ImportSpec, ImportCtx } from './imports'
import { paiseOrNil, numOrNil, isWholeNumber, withinWindow } from './imports'

/* The payroll sheets of bulk_import.go: the standing salary and bank
   details keyed by staff code, and months already paid before go-live. */

async function employeeByCode(ctx: ImportCtx, code: string, exact: boolean): Promise<string | null> {
  const row = exact
    ? await ctx.db.prepare(`SELECT id FROM employees WHERE institution_id = ? AND employee_code = ?`).bind(ctx.inst, code).first<{ id: string }>()
    : await ctx.db.prepare(`SELECT id FROM employees WHERE institution_id = ? AND lower(employee_code) = lower(?)`).bind(ctx.inst, code).first<{ id: string }>()
  return row?.id ?? null
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
  const SHEET_PAY: [string, string][] = [['basic', 'BASIC'], ['house_rent_allowance', 'HRA'], ['dearness_allowance', 'DA'], ['conveyance_allowance', 'CONVEY'], ['other_allowance', 'SPECIAL']]
  /* Headings as the payslip words them (Yajur, 2026-10-14: "that template is
     not right"). Sheets made with the first short headings still load: each
     old heading is copied onto the new one before the row is read. */
  const SHEET_OLD: [string, string][] = [['employee_id', 'emp_id'], ['employee_name', 'name'], ['date_of_joining', 'd.o.j'],
    ['bank_account_number', 'a/c_number'], ['ifsc', 'ifsc_code'], ['aadhaar', 'aadhar'], ['house_rent_allowance', 'h.r.a'],
    ['dearness_allowance', 'da'], ['conveyance_allowance', 'ca'], ['other_allowance', 'oa']]
  const sheetRow = (row: Record<string, string>) => {
    for (const [now, was] of SHEET_OLD) if ((row[now] ?? '') === '' && (row[was] ?? '') !== '') row[now] = row[was]
  }
  const rupeesCell = (v: unknown): number | null => {
    const t = str(v).replace(/[,₹\s]/g, '').trim()
    if (t === '' || t === '-') return null
    const n = Number(t)
    if (!Number.isFinite(n) || n < 0) throw new Error(`"${str(v).trim()}" is not an amount of rupees`)
    return Math.round(n * 100)
  }
  const sheetDate = (v: unknown): string | null => {
    const t = str(v).trim()
    if (t === '') return null
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
    if (m) return t
    m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(t)
    if (!m) throw new Error(`D.O.J "${t}" is not a date like 01/06/2024`)
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  specs.salary_sheet = {
    perm: 'hr.payroll.write',
    columns: ['Employee ID', 'Employee Name', 'Designation', 'Mobile Number', 'Subject', 'Date of Joining', 'Bank Account Number', 'IFSC',
      'Aadhaar', 'PAN', 'UAN', 'Basic', 'House Rent Allowance', 'Dearness Allowance', 'Conveyance Allowance', 'Other Allowance'],
    required: [], identity: 'employee_id',
    sample: ['YPS59100001', 'RAMYA SRI RACHERLA', 'Teacher', '9876543210', 'English', '01/06/2024', '7707198963', 'IDIB000L009', '123412341234', 'ABCDE1234F', '100123456789', '15000', '6000', '0', '1600', '2400'],
    check: (row) => {
      sheetRow(row)
      if (str(row.employee_id).trim() === '') throw new Error('Employee ID is required')
      for (const [col] of SHEET_PAY) rupeesCell(row[col])
      sheetDate(row.date_of_joining)
    },
    verify: async (ctx, row) => {
      sheetRow(row)
      if (!(await employeeByCode(ctx, str(row.employee_id).trim(), false))) throw new Error(`nobody on the roll with EMP ID "${str(row.employee_id).trim()}". Import the staff first`)
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

      const pay = SHEET_PAY.map(([col, code]) => [code, rupeesCell(row[col])] as const).filter(([, v]) => v !== null) as [string, number][]
      if (pay.length === 0) return
      const total = pay.reduce((a, [, v]) => a + v, 0)
      let open = await ctx.db.prepare(`SELECT id FROM salary_structures WHERE institution_id = ? AND employee_id = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`)
        .bind(ctx.inst, empId).first<{ id: string }>()
      if (open) await ctx.db.prepare(`UPDATE salary_structures SET ctc_paise = ? WHERE id = ?`).bind(total, open.id).run()
      else {
        let from: string | null = null
        if (ctx.year) from = (await ctx.db.prepare(`SELECT starts_on FROM academic_years WHERE id = ?`).bind(ctx.year).first<{ starts_on: string }>())?.starts_on ?? null
        open = { id: uuid() }
        await ctx.db.prepare(`INSERT INTO salary_structures (id, institution_id, employee_id, effective_from, ctc_paise, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(open.id, ctx.inst, empId, from ?? todayIndia(), total, now()).run()
        ctx.noteCreated('salary_sheet', open.id, true)
      }
      for (const [code, amount] of pay) {
        const comp = await ctx.db.prepare(`SELECT id FROM salary_components WHERE institution_id = ? AND code = ?`).bind(ctx.inst, code).first<{ id: string }>()
        if (!comp) throw new Error(`the salary part ${code} is not set up. Open Salary setup once so the standard parts are created, then import again`)
        await ctx.db.prepare(`DELETE FROM salary_structure_items WHERE salary_structure_id = ? AND component_id = ?`).bind(open.id, comp.id).run()
        await ctx.db.prepare(`INSERT INTO salary_structure_items (id, institution_id, salary_structure_id, component_id, amount_paise) VALUES (?, ?, ?, ?, ?)`)
          .bind(uuid(), ctx.inst, open.id, comp.id, amount).run()
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

