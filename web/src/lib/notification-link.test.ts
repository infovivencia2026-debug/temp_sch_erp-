import { describe, expect, it } from 'vitest'
import { destOfKind, noteDestination, type NoteHrefs } from './notification-link'

const hrefs: NoteHrefs = {
  status: '/faculty/communication/class_status',
  fee: '/parent/fees/fees_payments',
  attendance: '/parent/home/dashboard',
  homework: '/parent/academics/homework_academics',
  circular: '/parent/messages/communication',
  messages: '/faculty/communication/messages',
  concern: '/faculty/communication/concerns_from_parents',
  questionPapers: '/faculty/exams/question_papers',
  leaveApprovals: '/institution_admin/approvals/approvals',
  reports: '/institution_admin/standard/reports',
  staffExits: '/hr/onboarding_exit/staff_joinings_exits',
}
const post = '30a3066f-517d-4579-a3b6-95cf20e8a9f3'

describe('noteDestination', () => {
  it('opens a status in the class status viewer', () => {
    expect(noteDestination({ kind: 'status', link: `/?status=${post}` }, hrefs)).toBe(`/faculty/communication/class_status?status=${post}`)
    expect(noteDestination({ kind: 'status', link: `/?status=${post}` }, {})).toBeUndefined()
  })
  it('opens a gallery post in the school gallery', () => {
    const l = `/go/school_gallery/school_gallery?post=${post}`
    expect(noteDestination({ kind: 'gallery', link: l }, hrefs)).toBe(l)
    expect(noteDestination({ kind: 'gallery', link: null }, { gallery: '/faculty/school_gallery/school_gallery' })).toBe('/faculty/school_gallery/school_gallery')
  })
  it('keeps a /go/ link, thread and all', () => {
    const l = '/go/communication/messages?with=fa3cf005-1ed5-4c29-9341-ec7c6aafc07d'
    expect(noteDestination({ kind: 'staff_message', link: l }, hrefs)).toBe(l)
    expect(noteDestination({ kind: 'concern.support_ticket', link: '/concerns?id=x' }, hrefs)).toBe('/concerns?id=x')
  })
  it('sends a role-written screen path through /go/ so any role holding it lands', () => {
    expect(noteDestination({ kind: 'question_paper_deadline', link: '/faculty/exams/question_papers' }, hrefs)).toBe('/go/exams/question_papers')
    expect(noteDestination({ kind: 'support_ticket', link: '/institution_admin/communication/grievances?id=1' }, hrefs))
      .toBe('/go/communication/grievances?id=1')
  })
  it('maps /portal/ and missing links by kind', () => {
    expect(noteDestination({ kind: 'attendance', link: '/portal/attendance' }, hrefs)).toBe(hrefs.attendance)
    expect(noteDestination({ kind: 'fee_due', link: '/portal/fees' }, hrefs)).toBe(hrefs.fee)
    expect(noteDestination({ kind: 'homework', link: '/portal/homework' }, hrefs)).toBe(hrefs.homework)
    expect(noteDestination({ kind: 'circular', link: '/portal/circulars' }, hrefs)).toBe(hrefs.circular)
    expect(noteDestination({ kind: 'report_digest.daily', link: null }, hrefs)).toBe(hrefs.reports)
    expect(noteDestination({ kind: 'staff_message' }, hrefs)).toBe(hrefs.messages)
    expect(noteDestination({ kind: 'leave_request' }, hrefs)).toBe(hrefs.leaveApprovals)
    expect(noteDestination({ kind: 'question_paper_overdue' }, hrefs)).toBe(hrefs.questionPapers)
  })
  it('opens a staff exit approval in Approvals and the decision in Exit & clearance', () => {
    expect(noteDestination({ kind: 'staff_exit_approval', link: '/go/approvals/approvals' }, hrefs)).toBe('/go/approvals/approvals')
    expect(noteDestination({ kind: 'staff_exit_approval' }, hrefs)).toBe(hrefs.leaveApprovals)
    const l = '/go/onboarding_exit/staff_joinings_exits?tab=exits&exit=1'
    expect(noteDestination({ kind: 'staff_exit_decided', link: l }, hrefs)).toBe(l)
    expect(noteDestination({ kind: 'staff_exit_decided' }, hrefs)).toBe(hrefs.staffExits)
  })
  it('has no screen for a message digest', () => {
    expect(destOfKind('digest.daily')).toBeUndefined()
    expect(noteDestination({ kind: 'digest.daily', link: null }, hrefs)).toBeUndefined()
  })
  it('names a destination for each kind seen in live data', () => {
    for (const k of ['attendance', 'concern.support_ticket', 'fee_due', 'fee_receipt', 'parent_message', 'report_digest.weekly', 'staff_message', 'status'])
      expect(destOfKind(k), k).toBeDefined()
  })
})
