/* Mail addresses (communication.mail_addresses): the school's mail domain and
   which member of staff holds which address. Nothing here reads mail.
   Routes: worker/src/routes/comms/mail_addresses.ts. */
export interface StaffMailAddress {
  user_id: string
  full_name: string
  /** The person's sign-in email, for telling two people of one name apart. */
  login_email: string | null
  address: string | null
  status: 'active' | 'disabled' | null
}

export interface MailAddressesApi {
  'GET /comms/mail-addresses': { res: { domain: string | null; items: StaffMailAddress[] } }
  'PUT /comms/mail-addresses/domain': { body: { domain: string }; res: { domain: string } }
  'PUT /comms/mail-addresses/{user_id}': { body: { local_part?: string; status?: 'active' | 'disabled' }; res: StaffMailAddress }
}
