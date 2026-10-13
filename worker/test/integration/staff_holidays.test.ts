import { test } from 'vitest'
import assert from 'node:assert/strict'
import { appliesToStaff, isStaffHoliday } from '../../src/routes/hr/staff_holidays'

// Who a calendar holiday is for (owner, 2026-10-13): teaching / non-teaching, named people, a staff group.
test('each audience reaches only its own staff', () => {
  const groups = new Map([['g1', new Set(['e2'])]])
  const teacher = { teaching: true, eid: 'e1' }, clerk = { teaching: false, eid: 'e2' }
  const on = (a: string, p: { teaching: boolean; eid: string }) => appliesToStaff(a, p.teaching, p.eid, groups)
  assert.equal(on('all', teacher) && on('all', clerk) && on('staff', clerk), true)
  assert.equal(on('teaching', teacher), true); assert.equal(on('teaching', clerk), false)
  assert.equal(on('non_teaching', teacher), false); assert.equal(on('non_teaching', clerk), true)
  assert.equal(on('people:e1,e9', teacher), true); assert.equal(on('people:e1,e9', clerk), false)
  assert.equal(on('group:g1', clerk), true); assert.equal(on('group:g1', teacher), false)
  assert.equal(on('students', teacher), false)
})

test('a dated holiday counts only inside its dates', () => {
  const rows = [{ on_date: '2026-10-20', to_date: '2026-10-22', applies_to: 'people:e1' }]
  assert.equal(isStaffHoliday(rows, '2026-10-21', false, 'e1'), true)
  assert.equal(isStaffHoliday(rows, '2026-10-23', false, 'e1'), false)
  assert.equal(isStaffHoliday(rows, '2026-10-21', false, 'e2'), false)
})
