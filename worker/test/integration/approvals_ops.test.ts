/* Approval flows that must tell people (owner: every notification has a View):
   purchase requisitions, admissions enrolment approval and question papers.
   Each: the approvers are told on submit, the raiser on the decision, the
   links open the right screen, non-approvers are refused, a second decision
   is refused. Farah (finance) is given the approving rights directly. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'

const T = () => E.TENANT_TEST
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const APP_OFFERED = id(1101), APP_NEW = id(1102), FILE = id(1103)

type N = { user_id: string; link: string; kind: string }
const notes = async (sourceId: string) =>
  (await T().prepare(`SELECT user_id, link, kind FROM notifications WHERE source_id = ?`).bind(sourceId).all<N>()).results

beforeAll(async () => {
  await seed()
  const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  const t = new Date().toISOString()
  const grant = (k: string) => T().prepare(`INSERT OR IGNORE INTO user_permissions (user_id, institution_id, permission_key) VALUES (?, ?, ?)`).bind(IDS.finance, IDS.school, k)
  const app = (aid: string, no: string, status: string) => T().prepare(`INSERT INTO applications (id, institution_id, campus_id, application_no, first_name, last_name,
      class_sought, parent_name, parent_phone, status, decided_by, decided_at) VALUES (?, ?, ?, ?, 'Meera', 'Rao', ?, 'Ravi Rao', '9000000099', ?, ?, ?)`)
    .bind(aid, IDS.school, campus, no, IDS.klass, status, status === 'offered' ? IDS.admin : null, status === 'offered' ? t : null)
  await T().batch([
    ...['finance.invoices.write', 'operations.inventory.read', 'operations.inventory.write', 'admissions.approve', 'admissions.read', 'academics.exams.approve'].map(grant),
    app(APP_OFFERED, 'APP-T-1', 'offered'), app(APP_NEW, 'APP-T-2', 'submitted'),
    T().prepare(`UPDATE sections SET capacity = 40 WHERE id = ?`).bind(IDS.section),
    T().prepare(`INSERT INTO files (id, institution_id, object_key, original_name, content_type, size_bytes, checksum_sha256, purpose, uploaded_by, created_at)
        VALUES (?, ?, 'k/qp', 'paper.pdf', 'application/pdf', 10, 'x', 'question_paper', ?, ?)`).bind(FILE, IDS.school, IDS.teacher, t),
  ])
})

describe('purchase requisitions', () => {
  let rq = ''
  let perm = ''
  it('on submit, the holders of the band permission are told, not the raiser', async () => {
    const r = await api('admin', 'POST', '/admin-ops/purchasing/requisitions', {
      justification: 'Lab benches', lines: [{ description: 'Bench', quantity: 2, rate_paise: 6000000 }] })
    expect(r.status).toBe(200)
    rq = r.body.id
    const s = await api('admin', 'POST', `/admin-ops/purchasing/requisitions/${rq}/submit`, {})
    expect(s.status).toBe(200)
    perm = s.body.approval_permission
    const n = await notes(rq)
    expect(n.find((x) => x.user_id === IDS.finance)).toMatchObject({ link: '/go/stores/purchase_order_workflow', kind: 'purchase_requisition' })
    expect(n.find((x) => x.user_id === IDS.admin)).toBeUndefined()
    expect(n.find((x) => x.user_id === IDS.teacher)).toBeUndefined()
  })

  it('Approve/Reject are offered only to someone who may decide it, and others are refused', async () => {
    expect((await api('admin', 'GET', `/admin-ops/purchasing/requisitions/${rq}`)).body.requisition.can_decide).toBe(false)
    expect((await api('finance', 'GET', `/admin-ops/purchasing/requisitions/${rq}`)).body.requisition.can_decide).toBe(true)
    expect((await api('admin', 'POST', `/admin-ops/purchasing/requisitions/${rq}/decide`, { decision: 'approve' })).status).toBe(403)
    expect((await api('teacher', 'POST', `/admin-ops/purchasing/requisitions/${rq}/decide`, { decision: 'approve' })).status).toBe(403)
    expect(perm).not.toBe('')
  })

  it('the decision reaches the requester, and a second decision is refused', async () => {
    expect((await api('finance', 'POST', `/admin-ops/purchasing/requisitions/${rq}/decide`, { decision: 'approve' })).status).toBe(200)
    const n = await notes(rq)
    expect(n.find((x) => x.user_id === IDS.admin)).toMatchObject({ link: '/go/stores/purchase_order_workflow' })
    const again = await api('finance', 'POST', `/admin-ops/purchasing/requisitions/${rq}/decide`, { decision: 'reject', note: 'no' })
    expect(again.status).toBeGreaterThanOrEqual(400)
    expect((await T().prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).bind(rq).first<{ status: string }>())!.status).toBe('approved')
  })
})

describe('admissions enrolment approval', () => {
  it('an offer that needs approval tells the admissions.approve holders', async () => {
    expect((await api('admin', 'PUT', '/admissions/workflow/admission-approval', { required: true })).status).toBe(200)
    const r = await api('admin', 'POST', `/admissions/workflow/applications/${APP_NEW}/decision`, { decision: 'offered' })
    expect(r.status).toBe(200)
    const n = await notes(APP_NEW)
    expect(n.find((x) => x.user_id === IDS.finance)).toMatchObject({ link: '/go/approvals/approvals', kind: 'admission_approval' })
    expect(n.find((x) => x.user_id === IDS.teacher)).toBeUndefined()
  })

  it('a non-approver is refused', async () => {
    expect((await api('teacher', 'POST', `/admissions/workflow/pending-admissions/${APP_OFFERED}/decide`, { approved: true })).status).toBe(403)
  })

  it('sending back tells the desk, leaves the inbox, and a second decision is 409', async () => {
    const r = await api('finance', 'POST', `/admissions/workflow/pending-admissions/${APP_OFFERED}/decide`, { approved: false, note: 'Birth certificate missing' })
    expect(r.status).toBe(200)
    const n = await notes(APP_OFFERED)
    expect(n.find((x) => x.user_id === IDS.admin)).toMatchObject({ link: '/go/admissions/fee_enrollment' })
    expect((await api('finance', 'POST', `/admissions/workflow/pending-admissions/${APP_OFFERED}/decide`, { approved: true })).status).toBe(409)
    const inbox = await api('finance', 'GET', '/workflow/approvals')
    expect(JSON.stringify(inbox.body)).not.toContain(APP_OFFERED)
    expect(JSON.stringify(inbox.body)).toContain(APP_NEW)
  })
})

describe('question papers', () => {
  it('on submit the exam branch is told, with a link to Question papers', async () => {
    const r = await api('teacher', 'POST', '/exams/question-papers', { exam_subject_id: IDS.paper, file_id: FILE, submit: true })
    expect(r.status).toBe(200)
    const n = await notes(IDS.paper)
    expect(n.find((x) => x.user_id === IDS.finance && x.kind === 'question_paper')).toMatchObject({ link: '/go/exams/question_papers' })
  })

  it('an approved paper cannot be reset by the plain upload', async () => {
    const qp = (await T().prepare(`SELECT id FROM question_papers WHERE exam_subject_id = ?`).bind(IDS.paper).first<{ id: string }>())!.id
    expect((await api('admin', 'POST', `/exams/question-papers/${qp}/decide`, { decision: 'approved' })).status).toBe(200)
    const again = await api('teacher', 'POST', '/exams/question-papers', { exam_subject_id: IDS.paper, file_id: FILE, submit: false })
    expect(again.status).toBe(409)
    const row = await T().prepare(`SELECT status, reviewed_by FROM question_papers WHERE id = ?`).bind(qp).first<{ status: string; reviewed_by: string }>()
    expect(row).toMatchObject({ status: 'approved', reviewed_by: IDS.admin })
  })
})
