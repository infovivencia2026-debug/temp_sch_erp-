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

