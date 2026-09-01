import { Card, CardHeader, Field, Button } from '@/components/ui'

/* The parent's password, which exists in exactly one place for one moment.

   Nothing can read it back: it is hashed on the way in, so this card is the
   only copy that will ever exist. It used to live inside Applications because
   that is where enrolling happened. Enrolling has moved to Fee & enrolment,
   and if this had stayed behind, every new parent would have been created
   with a password nobody ever saw. */

export interface ParentLogin {
  sign_in_as?: string
  password?: string
  full_name?: string
  existing?: boolean
  sent_to?: string[]
  note?: string
}

/* Shown once, and said so.

   Deliberately not a toast. A toast that carries a password is a password the
   office loses by looking away, and the one thing this card must survive is
   the clerk turning round to speak to the parent. It stays until dismissed. */
export function ParentLoginCard({ login, onClose }: { login: ParentLogin; onClose: () => void }) {
  const sent = login.sent_to ?? []
  return (
    <Card>
      <CardHeader
        title={login.existing ? 'This parent already has a login' : "The parent's login"}
        description={
          login.existing
            ? 'A second child on the same account. The password is unchanged, so it is not shown.'
            : 'Give this to the parent now. The password cannot be read back once this card is closed.'
        }
        action={<Button variant="secondary" onClick={onClose}>Done</Button>}
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Sign in as">
          <p className="select-all font-mono text-[15px]">{login.sign_in_as}</p>
        </Field>
        {login.password && (
          <Field label="Password">
            <p className="select-all font-mono text-[15px]">{login.password}</p>
          </Field>
        )}
      </div>
      <div className="border-t px-4 py-3 text-[13px] text-muted-foreground">
        {sent.length > 0
          ? `Also sent by ${sent.join(', ')}.`
          : 'Not sent: this parent has no phone or email on record, so read it out now.'}
        {login.note ? ` ${login.note}` : ''}
      </div>
    </Card>
  )
}
