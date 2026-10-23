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

/** The school's own mail server, which each person's connected mailbox uses. Empty host = not set. */
export interface MailServerSettings {
  imap_host: string
  imap_port: number
  smtp_host: string
  smtp_port: number
  /** tls: implicit TLS, usually port 465. starttls: usually port 587. */
  smtp_security: 'tls' | 'starttls'
}

export interface MailAddressesApi {
  'GET /comms/mail-addresses/server': { res: MailServerSettings }
  'PUT /comms/mail-addresses/server': { body: MailServerSettings; res: MailServerSettings }
  'GET /comms/mail-addresses': { res: { domain: string | null; items: StaffMailAddress[] } }
  'PUT /comms/mail-addresses/domain': { body: { domain: string }; res: { domain: string } }
  'PUT /comms/mail-addresses/{user_id}': { body: { local_part?: string; status?: 'active' | 'disabled' }; res: StaffMailAddress }
  /** Dry run of a staff list file: what each line would do. Writes nothing. */
  'POST /comms/mail-addresses/import/preview': { body: MailImportBody; res: MailImportPreview }
  /** The same check again, then only the lines marked assign are written. */
  'POST /comms/mail-addresses/import': { body: MailImportBody; res: MailImportPreview & { assigned: number } }
}

/** One line of a staff list file, as sent to the server. Only these three
    columns are read from the file; any other column (a password, a phone)
    never leaves the browser. */
export interface MailImportRow {
  /** Line number in the file, for the admin to find it. */
  line: number
  code: string
  name: string
  email: string
}

export type MailImportResult = 'assign' | 'already' | 'unmatched' | 'invalid' | 'duplicate' | 'domain'

export interface MailImportPreviewRow extends MailImportRow {
  result: MailImportResult
  /** The member of staff the line was matched to, and how. */
  user_id: string | null
  full_name: string | null
  matched_by: 'code' | 'name' | null
  /** Their address before the import, when they had one. */
  current: string | null
}

export interface MailImportBody { rows: MailImportRow[] }
export interface MailImportPreview {
  domain: string | null
  /** No domain set yet and every address in the file shares this one. */
  suggested_domain: string | null
  rows: MailImportPreviewRow[]
}

const headKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const CODE_HEADS = new Set(['eid', 'employeecode', 'empcode', 'employeeid', 'empid', 'staffcode', 'staffid', 'code'])
const NAME_HEADS = new Set(['staffname', 'name', 'fullname', 'employeename', 'empname'])
const EMAIL_HEADS = new Set(['emailid', 'email', 'emailaddress', 'mailid', 'mail', 'mailaddress'])

/** Reads the code, name and email columns out of a parsed CSV. Title lines
    above the header are skipped; the header is the first line naming an email
    column and a code or name column. Every other column is left unread. */
export function readMailImportCsv(cells: string[][]): { rows: MailImportRow[] } | { error: string } {
  for (let h = 0; h < cells.length; h++) {
    const keys = cells[h].map(headKey)
    const email = keys.findIndex((k) => EMAIL_HEADS.has(k))
    const code = keys.findIndex((k) => CODE_HEADS.has(k))
    const name = keys.findIndex((k) => NAME_HEADS.has(k))
    if (email < 0 || (code < 0 && name < 0)) continue
    const rows: MailImportRow[] = []
    for (let i = h + 1; i < cells.length; i++) {
      const r = cells[i]
      const row = {
        line: i + 1,
        code: code < 0 ? '' : (r[code] ?? '').trim(),
        name: name < 0 ? '' : (r[name] ?? '').trim(),
        email: (r[email] ?? '').trim(),
      }
      if (row.code || row.name || row.email) rows.push(row)
    }
    return { rows }
  }
  return { error: 'No header line found. The file needs an Email ID column and an employee code or Staff Name column.' }
}
