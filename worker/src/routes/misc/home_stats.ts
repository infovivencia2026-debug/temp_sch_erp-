import type { Router } from '../../router'
import { ok } from '../../http'

/* HOME STATS (owner, 2026-11-09: "do all and show"): the three figures under
   Today on the administrator's dashboard, from the school's own records.
   - fees: receipts banked in each of the last six months
   - classes: this month's student attendance, class by class
   - stages: students on the roll by stage of school */
const ist = () => new Date(Date.now() + 330 * 60_000)

export function registerHomeStats(r: Router): void {
  r.get('/home/stats', 'students.read', async (c) => {
    const now = ist()
    const months: string[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      months.push(d.toISOString().slice(0, 7))
    }
    const thisMonth = months[5]
    const [fees, classes, stages] = await c.db.batch([
      c.db.prepare(`SELECT substr(paid_on, 1, 7) AS m, SUM(amount_paise) AS paise FROM payments
          WHERE status = 'success' AND substr(paid_on, 1, 7) >= ? GROUP BY 1`).bind(months[0]),
      c.db.prepare(`SELECT cl.name AS name, cl.level AS level,
            SUM(sa.status IN ('present', 'late')) + 0.5 * SUM(sa.status = 'half_day') AS here, COUNT(*) AS marked
          FROM student_attendance sa JOIN sections s ON s.id = sa.section_id JOIN classes cl ON cl.id = s.class_id
          WHERE substr(sa.on_date, 1, 7) = ? AND sa.period_id IS NULL
          GROUP BY cl.id ORDER BY cl.level, cl.name`).bind(thisMonth),
      c.db.prepare(`SELECT cl.name AS name, cl.level AS level, COUNT(DISTINCT e.student_id) AS n
          FROM enrollments e JOIN classes cl ON cl.id = e.class_id
          JOIN students st ON st.id = e.student_id AND st.status = 'active'
          WHERE e.status = 'active' AND e.academic_year_id = (SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1)
          GROUP BY cl.id`),
    ])
    const byMonth = new Map((fees.results as { m: string; paise: number }[]).map((x) => [x.m, Number(x.paise) || 0]))
    const stage = (level: number | null, name: string) => {
      const lv = level ?? NaN
      if (/nursery|pre|lkg|ukg|kg/i.test(name) || lv <= 0) return 'Pre-primary'
      if (lv <= 5) return 'Primary'
      if (lv <= 8) return 'Middle'
      return 'Secondary'
    }
    const stageCount = new Map<string, number>()
    for (const x of stages.results as { name: string; level: number | null; n: number }[]) {
      const k = stage(x.level, x.name); stageCount.set(k, (stageCount.get(k) ?? 0) + Number(x.n))
    }
    return ok({
      fees: months.map((m) => ({ month: m, rupees: Math.round((byMonth.get(m) ?? 0) / 100) })),
      classes: (classes.results as { name: string; here: number; marked: number }[])
        .filter((x) => Number(x.marked) > 0)
        .map((x) => ({ name: x.name, percent: Math.round((Number(x.here) / Number(x.marked)) * 100) })),
      stages: ['Pre-primary', 'Primary', 'Middle', 'Secondary'].filter((k) => stageCount.has(k)).map((k) => ({ name: k, students: stageCount.get(k)! })),
    })
  })
}
