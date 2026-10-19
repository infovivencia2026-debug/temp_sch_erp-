/* Mail addresses (communication.mail_addresses): every route sits under
   comms.mail.manage, and none of them is a way into anyone's mail. The
   behaviour is covered with the inbox in feature_inbox.test.ts. */
import { describe, it, expect } from 'vitest'
import { Router } from '../../src/router'
import { registerMailAddresses } from '../../src/routes/comms/mail_addresses'
import source from '../../src/routes/comms/mail_addresses.ts?raw'

describe('communication.mail_addresses', () => {
  const r = new Router()
  registerMailAddresses(r)
  it('every route needs comms.mail.manage', () => {
    expect(r.match('GET', '/api/v1/comms/mail-addresses')?.route.perm).toBe('comms.mail.manage')
    expect(r.match('PUT', '/api/v1/comms/mail-addresses/domain')?.route.perm).toBe('comms.mail.manage')
    expect(r.match('POST', '/api/v1/comms/mail-addresses/import/preview')?.route.perm).toBe('comms.mail.manage')
    expect(r.match('POST', '/api/v1/comms/mail-addresses/import')?.route.perm).toBe('comms.mail.manage')
    expect(r.match('PUT', '/api/v1/comms/mail-addresses/00000000-0000-4000-8000-000000000002')?.route.perm).toBe('comms.mail.manage')
  })
  it('never reads mail', () => {
    expect(source.includes('FROM mail_messages')).toBe(false)
    expect(source.includes('mail_attachments')).toBe(false)
  })
})
