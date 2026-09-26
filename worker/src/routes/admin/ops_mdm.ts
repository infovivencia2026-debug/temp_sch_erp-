import type { Router, Ctx } from '../../router'
import { badRequest, created, now, ok, readJSON, uuid } from '../../http'
import { institutionId } from './common'
import { fmtPaise, isDate, mustFirst, nz, om, optDate, optUUID, pathUUID, qUUID, refuse, runOps, tr } from './ops_common'

/* Mid-day meal utilisation under /admin-ops/mdm, from internal/api/admin_ops.go.

   Trigger re-implemented: mdm_monthly_returns_frozen (00053) - a finalised
   or filed return refuses a change to its figures until it is reopened. */

const READ = 'admin.reports.read'
const WRITE = 'institution.write'
const NIL = '00000000-0000-0000-0000-000000000000'
type Row = Record<string, unknown>

/** aoMonth: ?month=YYYY-MM, defaulting to the month just gone (in India). */
function month(v: unknown): { first: string; last: string; ym: string } {
  if (v != null && typeof v !== 'string') throw badRequest('month must be YYYY-MM')
  const s = (v ?? '').trim()
  let y: number, m: number
  if (s === '') {
    const n = new Date(Date.now() + 5.5 * 3_600_000)
    y = n.getUTCFullYear(); m = n.getUTCMonth() // previous month, 0-based
    if (m === 0) { y--; m = 12 }
  } else {
    const mm = /^(\d{4})-(\d{2})$/.exec(s)
    if (!mm || Number(mm[2]) < 1 || Number(mm[2]) > 12) throw refuse('month must be YYYY-MM')
    y = Number(mm[1]); m = Number(mm[2])
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const ym = `${y}-${String(m).padStart(2, '0')}`
  return { first: `${ym}-01`, last: `${ym}-${String(lastDay).padStart(2, '0')}`, ym }
}

function tolerance(actual: number, expected: number, tol: number): string {
  if (expected === 0) return actual === 0 ? 'ok' : 'warn'
  const d = Math.abs((actual - expected) / expected)
  return d <= tol ? 'ok' : d <= tol * 2 ? 'warn' : 'fail'
}

/** Instructional days between two dates: Sundays and student holidays out, declared working days in. */
async function workingDays(c: Ctx, first: string, last: string): Promise<number> {
  const hs = (await c.db.prepare(`SELECT kind, applies_to, substr(on_date,1,10) AS f, substr(COALESCE(to_date, on_date),1,10) AS t FROM holidays
      WHERE on_date <= ? AND COALESCE(to_date, on_date) >= ?`).bind(last, first).all<{ kind: string; applies_to: string; f: string; t: string }>()).results
  let n = 0
  for (let d = new Date(first + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10)
    const shut = hs.some((h) => (h.kind === 'holiday' || h.kind === 'vacation') && (h.applies_to === 'all' || h.applies_to === 'students') && day >= h.f && day <= h.t)
    const working = hs.some((h) => h.kind === 'working_day' && day >= h.f && day <= h.t)
    if (working || (d.getUTCDay() !== 0 && !shut)) n++
  }
  return n
}

const f2 = (x: number) => x.toFixed(2)

export function registerOpsMDM(r: Router): void {
  r.get('/admin-ops/mdm/utilisation', READ, async (c) => {
    const { first, last, ym } = month(c.url.searchParams.get('month'))
    const campus = qUUID(c.url.searchParams.get('campus_id'))
    const [dr, lr, rr, nr, ret] = await c.db.batch<Row>([
      c.db.prepare(`SELECT substr(on_date,1,10) AS on_date, enrolled, present, meals_served, rice_kg, cost_paise, menu FROM mdm_registers
          WHERE on_date BETWEEN ?1 AND ?2 AND (?3 IS NULL OR campus_id = ?3) ORDER BY on_date`).bind(first, last, campus),
      c.db.prepare(`SELECT COALESCE(sum(CAST(quantity_kg AS REAL)), 0) AS kg FROM mdm_foodgrain_receipts
          WHERE lifted_on BETWEEN ?1 AND ?2 AND (?3 IS NULL OR campus_id = ?3)`).bind(first, last, campus),
      c.db.prepare(`SELECT COALESCE(sum(CASE WHEN c.level BETWEEN 1 AND 5 THEN 1 ELSE 0 END), 0) AS p,
            COALESCE(sum(CASE WHEN c.level BETWEEN 6 AND 8 THEN 1 ELSE 0 END), 0) AS u
          FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN academic_years y ON y.id = e.academic_year_id
         WHERE e.status = 'active' AND y.is_current = 1`),
      c.db.prepare(`SELECT
          COALESCE((SELECT grain_grams_per_child FROM mdm_norms WHERE stage='primary' AND effective_from <= ?1 ORDER BY effective_from DESC LIMIT 1), 0) AS gn,
          COALESCE((SELECT cooking_cost_paise_per_child FROM mdm_norms WHERE stage='primary' AND effective_from <= ?1 ORDER BY effective_from DESC LIMIT 1), 0) AS cn,
          COALESCE((SELECT grain_grams_per_child FROM mdm_norms WHERE stage='upper_primary' AND effective_from <= ?1 ORDER BY effective_from DESC LIMIT 1), 0) AS ugn,
          COALESCE((SELECT cooking_cost_paise_per_child FROM mdm_norms WHERE stage='upper_primary' AND effective_from <= ?1 ORDER BY effective_from DESC LIMIT 1), 0) AS ucn,
          COALESCE((SELECT grain FROM mdm_norms WHERE effective_from <= ?1 ORDER BY effective_from DESC LIMIT 1), 'rice') AS grain`).bind(first),
      c.db.prepare(`SELECT id, status, CAST(opening_grain_kg AS REAL) AS og, CAST(allotted_grain_kg AS REAL) AS ag, opening_cost_paise, allotted_cost_paise,
            released_cost_paise, variance_explanation FROM mdm_monthly_returns
          WHERE substr(period_month,1,10) = ?1 AND COALESCE(campus_id, '${NIL}') = COALESCE(?2, '${NIL}')`).bind(first, campus),
    ])
    let meals = 0, presentSum = 0, enrolSum = 0, servedDays = 0, riceKg = 0, costPaise = 0
    const days = dr.results.map((v) => {
      const d = { on_date: String(v.on_date), enrolled: Number(v.enrolled), present: Number(v.present), meals_served: Number(v.meals_served),
        rice_kg: v.rice_kg === null ? undefined : Number(v.rice_kg), cost_paise: Number(v.cost_paise), menu: om(v.menu as string | null), issues: [] as string[] }
      if (d.meals_served > d.present && d.present > 0) d.issues.push('more meals served than children present')
      if (d.meals_served > d.enrolled && d.enrolled > 0) d.issues.push('more meals served than children on roll')
      if (d.meals_served > 0 && d.cost_paise === 0) d.issues.push('meals served with no cooking cost recorded')
      if (d.meals_served > 0 && !d.rice_kg) d.issues.push('meals served with no foodgrain recorded')
      meals += d.meals_served; presentSum += d.present; enrolSum += d.enrolled; costPaise += d.cost_paise
      if (d.rice_kg !== undefined) riceKg += d.rice_kg
      if (d.meals_served > 0) servedDays++
      return d
    })
    const wd = await workingDays(c, first, last)
    const liftedKg = Number(lr.results[0]?.kg ?? 0)
    const primaryRoll = Number(rr.results[0]?.p ?? 0), upperRoll = Number(rr.results[0]?.u ?? 0)
    const n = nr.results[0] ?? {}
    const grainNorm = Number(n.gn ?? 0), costNorm = Number(n.cn ?? 0), upperGrainNorm = Number(n.ugn ?? 0), upperCostNorm = Number(n.ucn ?? 0)
    const grainName = String(n.grain ?? 'rice')
    const haveNorms = grainNorm > 0 || upperGrainNorm > 0
    const rt = ret.results[0]
    const openGrain = Number(rt?.og ?? 0), allotGrain = Number(rt?.ag ?? 0)
    const openCost = Number(rt?.opening_cost_paise ?? 0), allotCost = Number(rt?.allotted_cost_paise ?? 0), releasedCost = Number(rt?.released_cost_paise ?? 0)

    const checks: { code: string; severity: string; label: string; detail: string }[] = []
    const add = (code: string, severity: string, label: string, detail: string) => checks.push({ code, severity, label, detail })
    if (wd === 0) add('serving_days', 'warn', 'Working days', 'No working days found in the calendar for this month. Check the holiday list before filing.')
    else if (servedDays >= wd) add('serving_days', 'ok', 'Meals served on every working day', `${servedDays} serving days against ${wd} working days.`)
    else add('serving_days', servedDays * 4 < wd * 3 ? 'fail' : 'warn', 'Meals not served on every working day',
      `${servedDays} serving days against ${wd} working days, ${wd - servedDays} days unexplained. The return needs a reason for the gap.`)

    const roll = primaryRoll + upperRoll
    if (haveNorms && meals > 0 && roll > 0) {
      const expGrain = (meals * (primaryRoll * grainNorm + upperRoll * upperGrainNorm) / roll) / 1000
      const expCost = Math.trunc(meals * (primaryRoll * costNorm + upperRoll * upperCostNorm) / roll)
      add('grain_norm', tolerance(riceKg, expGrain, 0.10), 'Foodgrain against the per-child norm',
        `${f2(riceKg)} kg consumed against ${f2(expGrain)} kg expected for ${meals} meals at the norm.`)
      add('cost_norm', tolerance(costPaise, expCost, 0.10), 'Cooking cost against the per-child norm',
        `${fmtPaise(costPaise)} spent against ${fmtPaise(expCost)} expected for ${meals} meals at the norm.`)
    } else if (!haveNorms) {
      add('norms', 'warn', 'No per-child norms recorded', 'Record the PM POSHAN foodgrain and cooking-cost norms so consumption can be checked against entitlement.')
    }
    const closingGrain = openGrain + liftedKg - riceKg
    if (closingGrain < -0.001) add('grain_balance', 'fail', 'Foodgrain balance is negative',
      `Opening ${f2(openGrain)} + lifted ${f2(liftedKg)} - consumed ${f2(riceKg)} = ${f2(closingGrain)} kg. More grain has been consumed than the school ever held.`)
    else add('grain_balance', 'ok', 'Foodgrain balance carries forward', `Closing balance ${f2(closingGrain)} kg of ${grainName}.`)
    const closingCost = openCost + releasedCost - costPaise
    if (closingCost < 0) add('cost_balance', 'fail', 'Cooking cost overspent against funds released',
      `Opening ${fmtPaise(openCost)} + released ${fmtPaise(releasedCost)} - spent ${fmtPaise(costPaise)} = ${fmtPaise(closingCost)}.`)
    else add('cost_balance', 'ok', 'Cooking cost within funds released', `Closing balance ${fmtPaise(closingCost)}.`)
    const flagged = days.filter((d) => d.issues.length > 0).length
    if (flagged > 0) add('daily_anomalies', 'fail', 'Days with an arithmetic problem', `${flagged} of ${days.length} recorded days need attention before this return is defensible.`)
    else if (days.length > 0) add('daily_anomalies', 'ok', 'Every recorded day ties out', 'No day serves more meals than children.')
    const avgEnrol = days.length ? Math.trunc(enrolSum / days.length) : 0
    const avgPresent = days.length ? Math.trunc(presentSum / days.length) : 0
    return ok({
      month: ym, period: { from: first, to: last },
      return: { id: rt?.id ?? '', status: rt?.status ?? '', explanation: rt?.variance_explanation ?? null },
      meals: { total: meals, serving_days: servedDays, working_days: wd, avg_enrolment: avgEnrol, avg_present: avgPresent },
      foodgrain: { grain: grainName, opening_kg: openGrain, lifted_kg: liftedKg, allotted_kg: allotGrain, consumed_kg: riceKg, closing_kg: closingGrain },
      cooking_cost_paise: { opening: openCost, allotted: allotCost, released: releasedCost, spent: costPaise, closing: closingCost },
      roll: { primary: primaryRoll, upper_primary: upperRoll }, checks, days,
    })
  })

  r.get('/admin-ops/mdm/returns', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT t.id, substr(t.period_month,1,7) AS period_month, t.status, CAST(t.opening_grain_kg AS REAL) AS og,
        CAST(t.allotted_grain_kg AS REAL) AS ag, t.opening_cost_paise, t.allotted_cost_paise, t.released_cost_paise, t.declared_working_days,
        t.variance_explanation, u.full_name AS finalised_by, substr(t.filed_on,1,10) AS filed_on, t.acknowledgement_no
      FROM mdm_monthly_returns t LEFT JOIN users u ON u.id = t.finalised_by ORDER BY t.period_month DESC LIMIT 60`).all<Row>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, period_month: v.period_month, status: v.status, opening_grain_kg: Number(v.og),
      allotted_grain_kg: Number(v.ag), opening_cost_paise: Number(v.opening_cost_paise), allotted_cost_paise: Number(v.allotted_cost_paise),
      released_cost_paise: Number(v.released_cost_paise), declared_working_days: om(v.declared_working_days as number | null),
      variance_explanation: om(v.variance_explanation), finalised_by: om(v.finalised_by), filed_on: om(v.filed_on), acknowledgement_no: om(v.acknowledgement_no) })) })
  })

  r.post('/admin-ops/mdm/returns', WRITE, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ month?: string; campus_id?: string; opening_grain_kg?: number; allotted_grain_kg?: number; opening_cost_paise?: number;
      allotted_cost_paise?: number; released_cost_paise?: number; declared_working_days?: number | null; variance_explanation?: string; remarks?: string }>(c.req)
    const { first, ym } = month(req.month)
    const og = req.opening_grain_kg ?? 0, ag = req.allotted_grain_kg ?? 0
    const oc = req.opening_cost_paise ?? 0, ac = req.allotted_cost_paise ?? 0, rc = req.released_cost_paise ?? 0
    if (og < 0 || ag < 0) throw refuse('a foodgrain quantity cannot be negative')
    if (oc < 0 || ac < 0 || rc < 0) throw refuse('an amount cannot be negative')
    const campus = optUUID(req.campus_id)
    const cur = await c.db.prepare(`SELECT id, status, CAST(opening_grain_kg AS REAL) AS og, CAST(allotted_grain_kg AS REAL) AS ag, opening_cost_paise, allotted_cost_paise, released_cost_paise
        FROM mdm_monthly_returns WHERE substr(period_month,1,10) = ?1 AND COALESCE(campus_id, '${NIL}') = COALESCE(?2, '${NIL}')`).bind(first, campus).first<Row>()
    const t = now()
    if (cur) {
      // mdm_monthly_returns_frozen
      if (cur.status !== 'draft' && (Number(cur.og) !== og || Number(cur.ag) !== ag || Number(cur.opening_cost_paise) !== oc ||
          Number(cur.allotted_cost_paise) !== ac || Number(cur.released_cost_paise) !== rc)) {
        throw refuse('this return is finalised; reopen it before changing the figures')
      }
      await runOps(c, [c.db.prepare(`UPDATE mdm_monthly_returns SET opening_grain_kg = ?, allotted_grain_kg = ?, opening_cost_paise = ?, allotted_cost_paise = ?,
          released_cost_paise = ?, declared_working_days = ?, variance_explanation = ?, remarks = ?, updated_at = ? WHERE id = ?`)
        .bind(String(og), String(ag), oc, ac, rc, req.declared_working_days ?? null, nz(req.variance_explanation), nz(req.remarks), t, cur.id)])
      return ok({ id: cur.id, month: ym })
    }
    const id = uuid()
    await runOps(c, [c.db.prepare(`INSERT INTO mdm_monthly_returns (id, institution_id, campus_id, period_month, status, opening_grain_kg, allotted_grain_kg, opening_cost_paise,
        allotted_cost_paise, released_cost_paise, declared_working_days, variance_explanation, remarks, filed_figures, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`)
      .bind(id, inst, campus, first, String(og), String(ag), oc, ac, rc, req.declared_working_days ?? null, nz(req.variance_explanation), nz(req.remarks), t, t)])
    return ok({ id, month: ym })
  })

  r.post('/admin-ops/mdm/returns/{id}/finalise', WRITE, async (c) => {
    const id = pathUUID(c)
    const req = await readJSON<{ figures?: unknown; filed_on?: string; acknowledgement_no?: string }>(c.req)
    const figs = req.figures === undefined ? '' : JSON.stringify(req.figures)
    if (figs === '' || figs === '{}' || figs === 'null') throw refuse('the computed return must be supplied so it can be frozen')
    const filed = optDate(req.filed_on, 'filed_on must be a date, as YYYY-MM-DD')
    const status = filed ? 'filed' : 'finalised'
    const cur = await mustFirst<{ status: string }>(c.db.prepare(`SELECT status FROM mdm_monthly_returns WHERE id = ?`).bind(id))
    if (cur.status !== 'draft') throw refuse('this return is already ' + cur.status + ', reopen it first')
    const t = now()
    await runOps(c, [c.db.prepare(`UPDATE mdm_monthly_returns SET status = ?, filed_figures = ?, finalised_at = ?, finalised_by = ?, filed_on = ?, acknowledgement_no = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'`).bind(status, figs, t, c.id.userId, filed, nz(req.acknowledgement_no), t, id)])
    return ok({ status })
  })

  r.post('/admin-ops/mdm/returns/{id}/reopen', WRITE, async (c) => {
    const id = pathUUID(c)
    const req = await readJSON<{ reason?: string }>(c.req)
    if (tr(req.reason) === '') throw refuse('say why a filed return is being reopened')
    const [res] = await runOps(c, [c.db.prepare(`UPDATE mdm_monthly_returns SET status = 'draft', filed_figures = '{}', finalised_at = NULL, finalised_by = NULL,
        remarks = CASE WHEN remarks IS NULL THEN 'Reopened: ' || ?1 ELSE remarks || char(10) || 'Reopened: ' || ?1 END, updated_at = ?2
       WHERE id = ?3 AND status <> 'draft'`).bind(tr(req.reason), now(), id)])
    if ((res.meta.changes ?? 0) === 0) throw refuse('that return is already open')
    return ok({ status: 'draft' })
  })

  r.get('/admin-ops/mdm/norms', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT id, stage, substr(effective_from,1,10) AS effective_from, grain_grams_per_child, cooking_cost_paise_per_child, grain, note
        FROM mdm_norms ORDER BY effective_from DESC, stage`).all<Row>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, stage: v.stage, effective_from: v.effective_from, grain_grams_per_child: Number(v.grain_grams_per_child),
      cooking_cost_paise_per_child: Number(v.cooking_cost_paise_per_child), grain: v.grain, note: om(v.note) })) })
  })

  r.post('/admin-ops/mdm/norms', WRITE, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ stage?: string; effective_from?: string; grain_grams_per_child?: number; cooking_cost_paise_per_child?: number; grain?: string; note?: string }>(c.req)
    if (req.stage !== 'primary' && req.stage !== 'upper_primary') throw refuse('stage must be primary or upper_primary')
    const from = tr(req.effective_from)
    if (!isDate(from)) throw refuse('effective_from must be a date, as YYYY-MM-DD')
    if (!((req.grain_grams_per_child ?? 0) > 0)) throw refuse('the foodgrain norm must be more than zero grams')
    if (!((req.cooking_cost_paise_per_child ?? 0) > 0)) throw refuse('the cooking cost norm must be more than zero')
    const grain = tr(req.grain) || 'rice'
    await runOps(c, [c.db.prepare(`INSERT INTO mdm_norms (id, institution_id, stage, effective_from, grain_grams_per_child, cooking_cost_paise_per_child, grain, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id, stage, effective_from) DO UPDATE SET grain_grams_per_child = excluded.grain_grams_per_child,
          cooking_cost_paise_per_child = excluded.cooking_cost_paise_per_child, grain = excluded.grain, note = excluded.note`)
      .bind(uuid(), inst, req.stage, from, req.grain_grams_per_child, req.cooking_cost_paise_per_child, grain, nz(req.note), now())])
    const row = await c.db.prepare(`SELECT id FROM mdm_norms WHERE stage = ? AND effective_from = ?`).bind(req.stage, from).first<{ id: string }>()
    return ok({ id: row?.id })
  })

  r.get('/admin-ops/mdm/foodgrain', READ, async (c) => {
    const { first, last } = month(c.url.searchParams.get('month'))
    const rows = await c.db.prepare(`SELECT g.id, substr(g.lifted_on,1,10) AS lifted_on, g.grain, CAST(g.quantity_kg AS REAL) AS kg, g.source, g.challan_no, g.remarks,
        u.full_name AS recorded_by FROM mdm_foodgrain_receipts g LEFT JOIN users u ON u.id = g.recorded_by
       WHERE g.lifted_on BETWEEN ? AND ? ORDER BY g.lifted_on DESC LIMIT 200`).bind(first, last).all<Row>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, lifted_on: v.lifted_on, grain: v.grain, quantity_kg: Number(v.kg), source: om(v.source),
      challan_no: om(v.challan_no), remarks: om(v.remarks), recorded_by: om(v.recorded_by) })) })
  })

  r.post('/admin-ops/mdm/foodgrain', WRITE, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ lifted_on?: string; grain?: string; quantity_kg?: number; source?: string; challan_no?: string; remarks?: string; campus_id?: string }>(c.req)
    const lifted = tr(req.lifted_on)
    if (!isDate(lifted)) throw refuse('lifted_on must be a date, as YYYY-MM-DD')
    if (!((req.quantity_kg ?? 0) > 0)) throw refuse('the quantity lifted must be more than zero')
    const grain = tr(req.grain) || 'rice'
    const campus = optUUID(req.campus_id)
    const id = uuid()
    await runOps(c, [c.db.prepare(`INSERT INTO mdm_foodgrain_receipts (id, institution_id, campus_id, lifted_on, grain, quantity_kg, source, challan_no, remarks, recorded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, inst, campus, lifted, grain, String(req.quantity_kg), nz(req.source), nz(req.challan_no), nz(req.remarks), c.id.userId, now())])
    return created({ id })
  })
}
