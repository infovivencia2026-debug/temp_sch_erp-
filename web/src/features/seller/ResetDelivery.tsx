import EmailServer from '../super_admin/EmailServer'

/* The seller's mail server and SMS channel: the Email Server screen, told
   who it is for. Every school's password-reset links go out through what is
   configured here. */
export default function ResetDelivery() {
  return <EmailServer platform />
}
