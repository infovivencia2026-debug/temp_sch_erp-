import { describe, expect, it } from 'vitest'
import { PROFILE_EDITABLE, profileBody } from './profile-body'

describe('profileBody', () => {
  it('drops what the GET returns that the PUT does not accept', () => {
    const fromServer = {
      name: 'Vivencia High School',
      short_name: 'VHS',
      timezone: 'Asia/Kolkata', // read-only; the server refuses unknown keys
      mid_day_meal: false,
      upi_vpa: 'vivencia@sbi',
    }
    const body = profileBody(fromServer, { upi_payee_name: 'Vivencia Fees' })
    expect(body).toEqual({
      name: 'Vivencia High School',
      short_name: 'VHS',
      mid_day_meal: false,
      upi_vpa: 'vivencia@sbi',
      upi_payee_name: 'Vivencia Fees',
    })
    expect('timezone' in body).toBe(false)
  })

  it('later layers win, and an explicit blank is sent', () => {
    const body = profileBody({ name: 'Old', upi_payee_name: 'Set' }, { name: 'New', upi_payee_name: '' })
    expect(body.name).toBe('New')
    expect(body.upi_payee_name).toBe('')
  })

  it('tolerates missing layers', () => {
    expect(profileBody(undefined, null)).toEqual({})
  })

  it('keeps the list in step with the server struct', () => {
    // institutionUpdate in internal/api/setup_profile.go, in order.
    expect(PROFILE_EDITABLE).toEqual([
      'name', 'short_name', 'udise_code', 'affiliation_board', 'affiliation_no',
      'state', 'district', 'mandal', 'village_or_ward', 'school_category',
      'management_type', 'child_info_code', 'mid_day_meal', 'upi_vpa', 'upi_payee_name',
    ])
  })
})
