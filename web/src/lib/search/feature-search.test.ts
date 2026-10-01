import { describe, expect, it } from 'vitest'
import { buildIndex, rank, within1, withRecentSearch, type SearchDoc } from './feature-search'

const D = (name: string, slug: string, workspace = 'Students', section = workspace, summary = ''): SearchDoc => ({
  key: `${workspace}.${slug}`.toLowerCase(), name, slug, workspace, section, summary,
})

const docs: SearchDoc[] = [
  D('Student 360', 'student_360'),
  D('Students', 'students'),
  D('Fees', 'fees', 'Finance'),
  D('Fee defaulters', 'fee_default', 'Finance'),
  D('Fee Dashboard', 'fee_dashboard', 'Finance'),
  D('Fee Regulatory Committee Filing', 'frc', 'Finance'),
  D('Attendance', 'attendance', 'Attendance & Leave'),
  D('Take Attendance', 'take_attendance', 'Attendance & Leave'),
  D('Transport', 'transport', 'Operations'),
  D('Bus breakdown emergency dispatch', 'bus_breakdown_emergency_dispatch', 'Operations'),
  D('Marks Entry', 'marks_entry', 'Examinations'),
  D('Results & report cards', 'results_report_cards', 'Examinations'),
  D('Class Status', 'class_status', 'Communication'),
  D('Timetable', 'timetable', 'Academics'),
  D('Circulars', 'circulars', 'Communication', 'Communication', 'Send a notice to every parent in one go.'),
  D('Payroll', 'payroll', 'Finance'),
  D('Fines', 'fines', 'Library'),
]
const index = buildIndex(docs)
const names = (q: string, opts?: Parameters<typeof rank>[2]) => rank(index, q, opts).map((h) => h.doc.name)

describe('feature-search ranks', () => {
  it('exact above prefix above word-start above anywhere', () => {
    expect(names('fees')[0]).toBe('Fees')
    expect(names('fee').slice(0, 3)).toEqual(['Fees', 'Fee Dashboard', 'Fee defaulters'])
    expect(names('fee')).toContain('Fee Regulatory Committee Filing')
  })

  it('initials and compact forms: s360 -> Student 360, ta -> Take Attendance', () => {
    expect(names('s360')[0]).toBe('Student 360')
    expect(names('stu360')[0]).toBe('Student 360')
    expect(names('ta')).toContain('Take Attendance')
  })

  it('a phrase lands word by word: "fee def" -> Fee defaulters', () => {
    expect(names('fee def')[0]).toBe('Fee defaulters')
    expect(names('def fee')[0]).toBe('Fee defaulters')
    expect(names('report cards')[0]).toBe('Results & report cards')
  })

  it('aliases: bus -> Transport first, marks -> Marks Entry and Results, pay -> Fees, status -> Class Status', () => {
    expect(names('bus')[0]).toBe('Transport')
    expect(names('bus')).toContain('Bus breakdown emergency dispatch')
    expect(names('marks').slice(0, 2)).toEqual(['Marks Entry', 'Results & report cards'])
    expect(names('pay')).toContain('Fees')
    expect(names('status')[0]).toBe('Class Status')
    expect(names('notice')[0]).toBe('Circulars')
    expect(names('హాజరు')[0]).toBe('Attendance')
    expect(names('hajaru')[0]).toBe('Attendance')
  })

  it('fuzzy: attnd -> Attendance, tmtbl -> Timetable; fees never reaches fines', () => {
    expect(names('attnd')[0]).toBe('Attendance')
    expect(names('tmtbl')[0]).toBe('Timetable')
    expect(names('fees')).not.toContain('Fines')
  })

  it('typos: one edit is forgiven on words of four letters or more', () => {
    expect(names('attendence')[0]).toBe('Attendance')
    expect(names('timetabel')[0]).toBe('Timetable')
    expect(names('transprot')[0]).toBe('Transport')
    expect(within1('fees', 'fines')).toBe(false)
    expect(within1('recipt', 'receipt')).toBe(true)
    expect(within1('teh', 'the')).toBe(true)
  })

  it('searches the workspace, the section and the description', () => {
    expect(names('finance')).toContain('Payroll')
    expect(names('send a notice')).toContain('Circulars')
    expect(names('parent')).toEqual(['Circulars'])
  })

  it('a description match keeps quiet when a name answers', () => {
    const idx = buildIndex([
      D('Fees', 'fees', 'Finance'),
      D('Year Rollover', 'year_rollover', 'Academics', 'Academics', 'Carries fee structures into the new year.'),
    ])
    expect(rank(idx, 'fee').map((h) => h.doc.name)).toEqual(['Fees'])
    expect(rank(idx, 'structures').map((h) => h.doc.name)).toEqual(['Year Rollover'])
  })

  it('recent and pinned lift a tie, never a fuzzy hit over an exact one', () => {
    expect(names('fee', { recent: ['finance.fee_default'] })[0]).toBe('Fee defaulters')
    expect(names('fee', { pinned: ['finance.fee_dashboard'] })[0]).toBe('Fee Dashboard')
    expect(names('fees', { recent: ['library.fines'] })[0]).toBe('Fees')
  })

  it('marks the matched characters of the name as runs', () => {
    expect(rank(index, 'fee')[0].runs).toEqual([[0, 3]])
    expect(rank(index, 's360')[0].runs).toEqual([[0, 1], [8, 11]])
    expect(rank(index, 'bus')[0].runs).toEqual([])
  })

  it('an empty query has no hits and a limit is honoured', () => {
    expect(rank(index, '  ')).toEqual([])
    expect(rank(index, 'fee', { limit: 2 })).toHaveLength(2)
  })
})

describe('recent searches', () => {
  it('keep the last five, newest first, without repeats', () => {
    let l: string[] = []
    for (const q of ['fee', 'bus', 'Fee', 'marks', 'tt', 'leave', 'exam']) l = withRecentSearch(l, q)
    expect(l).toEqual(['exam', 'leave', 'tt', 'marks', 'Fee'])
    expect(withRecentSearch(l, '  ')).toBe(l)
  })
})
