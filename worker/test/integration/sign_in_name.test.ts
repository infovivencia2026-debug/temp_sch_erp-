import { describe, expect, it } from 'vitest'
import { NO_STAFF_SIGN_IN, staffSignIn } from '../../src/services/sign_in_name'

describe('staffSignIn', () => {
  it('school email first, then phone, never a personal email', () => {
    expect(staffSignIn('ravi@school.edu.in', '9666467868')).toBe('ravi@school.edu.in')
    expect(staffSignIn('ravi@gmail.com', '9666467868')).toBe('9666467868')
    expect(staffSignIn('', '9666467868.YJPS')).toBe('9666467868')
    expect(staffSignIn('ravi@yahoo.co.in', '')).toBe(NO_STAFF_SIGN_IN)
    expect(staffSignIn(null, null)).toBe(NO_STAFF_SIGN_IN)
  })
})
