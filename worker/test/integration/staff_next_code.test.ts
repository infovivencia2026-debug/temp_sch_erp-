import { describe, expect, it } from 'vitest'
import { nextStaffCode } from '../../src/routes/hr/staff'

// The next staff code after the school's own (owner, 2026-11-16).
describe('nextStaffCode', () => {
  it('follows the prefix and padding', () => expect(nextStaffCode(['YPS001', 'YPS087', 'YPS012'])).toBe('YPS088'))
  it('uses the commonest prefix', () => expect(nextStaffCode(['YPS01', 'YPS02', 'T-9'])).toBe('YPS03'))
  it('keeps a dash', () => expect(nextStaffCode(['T-014', 'T-003'])).toBe('T-015'))
  it('is empty with no numbered codes', () => expect(nextStaffCode(['ADMIN', ''])).toBe(''))
})
