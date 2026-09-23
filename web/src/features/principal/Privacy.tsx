import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Card, CardHeader, Checkbox, FormNotice, PageBody, PageHead } from '@/components/ui'

/* PRIVACY, AS THE SCHOOL'S OWN POLICY.

   Two switches the 2026-09-23 audit said a school must be able to make once
   rather than have each feature decide for it: who hears about a child, and
   how a new login travels. Both default to the safer setting on the server
   (migrations/00341_privacy.sql); this screen is where a school changes its
   mind knowingly. The third thing on this page is not a switch: guardian
   access is decided per guardian, on the child's own profile, and the page
   says so rather than pretending to hold it.

   The public notice at /privacy is linked from here because the person who
   sets policy is the person who will be asked what the notice says. */

type Settings = { alerts_primary_only: boolean; credentials_by_email_only: boolean }

export default function Privacy() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['admin', 'privacy'],
    queryFn: () => api.get<Settings>('/api/v1/admin/privacy'),
  })
  const [form, setForm] = useState<Settings | null>(null)
  useEffect(() => {
    if (q.data && !form) setForm(q.data)
  }, [q.data, form])
  const save = useMutation({
    mutationFn: (s: Settings) => api.put<Settings>('/api/v1/admin/privacy', s),
    onSuccess: (s) => {
      qc.setQueryData(['admin', 'privacy'], s)
      setForm(s)
    },
  })
  const dirty = !!form && !!q.data &&
    (form.alerts_primary_only !== q.data.alerts_primary_only ||
      form.credentials_by_email_only !== q.data.credentials_by_email_only)

  return (
    <>
      <PageHead
        eyebrow="Staff"
        title="Privacy"
        actions={
          <Button disabled={!dirty || save.isPending} onClick={() => form && save.mutate(form)}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        }
      />
      <PageBody>
        <FormNotice error={save.error} ok={save.isSuccess && !dirty ? 'Saved' : undefined} />

        <Card>
          <CardHeader title="Who hears about a child" />
          <div className="px-5 pb-5">
            <Checkbox
              label="Send marks, fee and absence alerts to the primary guardian only"
              checked={form?.alerts_primary_only ?? true}
              onChange={(v) => form && setForm({ ...form, alerts_primary_only: v })}
            />
            <p className="mt-2 max-w-[62ch] text-[13px] text-muted-foreground">
              On, a child's report, fee balance and absence go to the one adult marked
              &ldquo;ring this parent first&rdquo; on their profile. A child with no primary on
              record still reaches everyone linked to them. Off, every linked adult hears
              &mdash; including a relation recorded as &ldquo;other&rdquo;.
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader title="How a new login travels" />
          <div className="px-5 pb-5">
            <Checkbox
              label="Send a new login's password by email only"
              checked={form?.credentials_by_email_only ?? true}
              onChange={(v) => form && setForm({ ...form, credentials_by_email_only: v })}
            />
            <p className="mt-2 max-w-[62ch] text-[13px] text-muted-foreground">
              On, SMS and WhatsApp carry &ldquo;your login is ready&rdquo; without the password,
              which goes to the email address on the record; where there is none, the office
              reads it off the screen and hands it over. Off, the password also goes to the
              phone number &mdash; a number nobody has verified belongs to whoever holds it now.
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader title="Which guardians may still see a child" />
          <div className="px-5 pb-5 text-[13px] text-muted-foreground">
            <p className="max-w-[62ch]">
              Decided per guardian, on the child&rsquo;s profile: open the guardian, and set
              <strong className="text-foreground"> Portal access until </strong> a date, or block it
              outright. A blocked or expired link sees nothing in the app and receives no alerts,
              and the office&rsquo;s own view of the record is unchanged.
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader title="The notice families are shown" />
          <div className="px-5 pb-5 text-[13px] text-muted-foreground">
            <p className="max-w-[62ch]">
              The privacy notice at{' '}
              <a href="/privacy" target="_blank" rel="noreferrer" className="text-primary underline">
                /privacy
              </a>{' '}
              is linked from the sign-in page and says what is collected, who can see it and how
              long it is kept, in the terms of the Digital Personal Data Protection Act, 2023. The
              school answers a family&rsquo;s request to see, correct or erase a record; the
              office does that from the child&rsquo;s profile.
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
