import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Select, Textarea, Field, FormGrid, FormNotice, Loading,
  ErrorState, UnavailableState,
} from '@/components/ui'
import {
  usePlatform, usePlatformSave, usePlatformAction,
  type BrandingResponse, type BrandingProfile,
} from './platform-lib'

const BLANK: Partial<BrandingProfile> = {}

/**
 * The white-label half of a branding profile: the host families visit, the
 * page they land on, and the header on every email the school sends.
 *
 * The same records the branding screen edits, from the other side. Kept apart
 * because they are two jobs done by two people — a school administrator picks
 * the logo and the colours, and somebody with access to DNS decides what
 * portal.stjohns.edu.in points at.
 *
 * A domain is verified by the vendor and not by the school, because only the
 * vendor operates the ingress and the certificate. Until it is verified the
 * sign-in page must not be served from it, and the screen says so rather than
 * showing a green tick over an unreachable host.
 */
export default function WhiteLabel() {
  const { data, isLoading, error } = usePlatform<BrandingResponse>('branding', '/branding')
  const save = usePlatformSave('branding', '/branding')
  const verify = usePlatformAction('branding')

  const [campus, setCampus] = useState('')
  const [form, setForm] = useState<Partial<BrandingProfile>>(BLANK)
  const [touched, setTouched] = useState(false)

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const existing = data.items.find((p) => (p.campus_id ?? '') === campus)
  const current: Partial<BrandingProfile> = touched ? form : existing ?? BLANK

  const set = (k: keyof BrandingProfile) => (v: string) => {
    setTouched(true)
    setForm({ ...(touched ? form : existing ?? BLANK), [k]: v })
  }

  const withDomain = data.items.filter((p) => p.custom_domain)
  const verified = withDomain.filter((p) => p.domain_verified_at)

  return (
    <>
      <PageHead
        eyebrow="Campuses & Academic Year"
        title="White-label branding"
        description="Custom domains, login portal banners and email header templates for a deployment carrying the school's own name."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Custom domains" value={withDomain.length} />
          <Stat
            label="Verified"
            value={verified.length}
            hint={withDomain.length > verified.length ? 'An unverified host must not be served' : undefined}
          />
          <Stat label="Profiles" value={data.items.length} hint="School-wide plus per campus" />
        </CellGrid>

        <Card>
          <CardHeader title="Domains" description="Each host resolves to exactly one profile" />
          <Table
            head={['Applies to', 'Domain', 'Status', 'Login headline', 'Sender name', '']}
            empty={!withDomain.length}
            emptyLabel="No custom domain configured. Parents reach the school on the installation's own address."
          >
            {withDomain.map((p) => (
              <tr key={p.id}>
                <Td className="font-medium">{p.campus ?? 'The whole school'}</Td>
                <Td className="font-mono text-[12.5px]">{p.custom_domain}</Td>
                <Td>
                  {p.domain_verified_at ? (
                    <Badge tone="success">Verified</Badge>
                  ) : (
                    <Badge tone="warning">Not verified</Badge>
                  )}
                </Td>
                <Td>{p.login_headline ?? '—'}</Td>
                <Td>{p.email_from_name ?? '—'}</Td>
                <Td>
                  {!p.domain_verified_at && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={verify.isPending}
                      onClick={() => verify.mutate({ path: `/branding/${p.id}/verify-domain` })}
                      title="Only a platform operator may confirm a host reaches this installation"
                    >
                      Mark verified
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          {verify.isError && (
            <div className="border-t p-5">
              <FormNotice error={verify.error} />
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Portal and correspondence"
            description="Changing the domain clears its verification — a host proven last month says nothing about the one typed today"
            action={
              <div className="flex items-center gap-2">
                <Select
                  value={campus}
                  onChange={(v) => {
                    setCampus(v)
                    setTouched(false)
                    setForm(BLANK)
                  }}
                  options={[{ value: '', label: 'The whole school' }, ...data.campuses]}
                />
                <Button
                  disabled={save.isPending}
                  onClick={() =>
                    save.mutate({ ...current, campus_id: campus }, { onSuccess: () => setTouched(false) })
                  }
                >
                  Save
                </Button>
              </div>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field
                label="Custom domain"
                hint="The host must already point at this installation. Setting it here does not create the DNS record or the certificate."
              >
                <Input
                  value={current.custom_domain ?? ''}
                  onChange={set('custom_domain')}
                  placeholder="portal.stjohns.edu.in"
                />
              </Field>
              <Field label="Favicon key">
                <Input value={current.favicon_key ?? ''} onChange={set('favicon_key')} />
              </Field>
              <Field label="Login headline">
                <Input
                  value={current.login_headline ?? ''}
                  onChange={set('login_headline')}
                  placeholder="Welcome to St John's"
                />
              </Field>
              <Field label="Login banner key">
                <Input value={current.login_banner_key ?? ''} onChange={set('login_banner_key')} />
              </Field>
              <Field label="Login message" wide>
                <Textarea
                  value={current.login_message ?? ''}
                  onChange={set('login_message')}
                  placeholder="Shown under the sign-in form. A term-time notice belongs on the announcements screen, not here."
                />
              </Field>
              <Field
                label="Email sender name"
                hint="What a parent sees the message is from. The envelope sender stays the vendor's, which is what keeps the mail delivered."
              >
                <Input value={current.email_from_name ?? ''} onChange={set('email_from_name')} />
              </Field>
              <Field label="Email header key">
                <Input value={current.email_header_key ?? ''} onChange={set('email_header_key')} />
              </Field>
              <Field label="Email footer" wide hint="Appended to every message. Keep the address and the unsubscribe line here.">
                <Textarea value={current.email_footer_html ?? ''} onChange={set('email_footer_html')} rows={4} />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice error={save.error} ok={save.isSuccess && !touched ? 'Saved.' : undefined} />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Serving a custom domain" />
          <div className="p-5">
            <UnavailableState
              title="The record here is configuration, not the deployment."
              body="A verified domain tells the sign-in page it may render this school's identity. Adding the host to the ingress and issuing its certificate is the operator's work, and this screen deliberately does not claim to have done it."
              technical={[
                { label: 'Verification', value: 'platform.tenants.write — the vendor, not the school' },
                { label: 'Storage', value: data.uploads_available ? 'configured' : 'not configured; image keys are recorded but nothing can be uploaded' },
              ]}
            />
          </div>
        </Card>
      </PageBody>
    </>
  )
}
