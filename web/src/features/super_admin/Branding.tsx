import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Input,
  Select, Field, FormGrid, FormNotice, Loading, ErrorState,
} from '@/components/ui'
import { usePlatform, usePlatformSave, type BrandingResponse, type BrandingProfile } from './platform-lib'

const BLANK: Partial<BrandingProfile> = {}

/**
 * Logo, name and colours, per school and per campus.
 *
 * The institution's own row stays authoritative for the application header —
 * this overrides it where a campus needs its own identity, which a trust
 * running two brands under one registration does. The domain, login banner and
 * email templates are the same records seen from the vendor's side, and live on
 * the white-label screen.
 *
 * A campus with no profile inherits the school's rather than falling back to
 * the product's default, so setting up a second campus is one field and not
 * eight.
 */
export default function Branding() {
  const { data, isLoading, error } = usePlatform<BrandingResponse>('branding', '/branding')
  const save = usePlatformSave('branding', '/branding')

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

  const pick = (v: string) => {
    setCampus(v)
    setTouched(false)
    setForm(BLANK)
  }

  return (
    <>
      <PageHead
        eyebrow="Institution Setup"
        title="Branding"
        description="Logo, display name and colours, for the school and for each campus that needs its own."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Profiles"
            description="The school-wide profile applies everywhere a campus has not overridden it"
          />
          <Table
            head={['Applies to', 'Display name', 'Tagline', 'Colours', 'Custom domain']}
            empty={!data.items.length}
            emptyLabel={`Nothing overridden yet — everything shows as "${data.institution_name}" in ${data.institution_primary_color}.`}
          >
            {data.items.map((p) => (
              <tr key={p.id}>
                <Td className="font-medium">{p.campus ?? 'The whole school'}</Td>
                <Td>{p.display_name ?? <span className="text-muted-foreground">{data.institution_name}</span>}</Td>
                <Td>{p.tagline ?? '—'}</Td>
                <Td>
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded-sm border"
                      style={{ background: p.primary_color ?? data.institution_primary_color }}
                    />
                    <span className="font-mono text-[12px]">
                      {p.primary_color ?? data.institution_primary_color}
                    </span>
                    {p.accent_color && (
                      <>
                        <span
                          className="inline-block h-3 w-3 rounded-sm border"
                          style={{ background: p.accent_color }}
                        />
                        <span className="font-mono text-[12px]">{p.accent_color}</span>
                      </>
                    )}
                  </span>
                </Td>
                <Td>
                  {p.custom_domain ? (
                    p.domain_verified_at ? (
                      <Badge tone="success">{p.custom_domain}</Badge>
                    ) : (
                      <Badge tone="warning">{p.custom_domain} — unverified</Badge>
                    )
                  ) : (
                    '—'
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Edit identity"
            description={
              data.uploads_available
                ? 'Image keys refer to files already uploaded through the files endpoint'
                : 'File storage is not configured on this installation, so a logo cannot be uploaded yet — the keys below are recorded and used once it is'
            }
            action={
              <div className="flex items-center gap-2">
                <Select
                  value={campus}
                  onChange={pick}
                  options={[{ value: '', label: 'The whole school' }, ...data.campuses]}
                />
                <Button
                  disabled={save.isPending}
                  onClick={() =>
                    save.mutate(
                      { ...current, campus_id: campus },
                      { onSuccess: () => setTouched(false) },
                    )
                  }
                >
                  Save
                </Button>
              </div>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Display name" hint={`Blank uses the registered name, "${data.institution_name}".`}>
                <Input value={current.display_name ?? ''} onChange={set('display_name')} />
              </Field>
              <Field label="Tagline">
                <Input value={current.tagline ?? ''} onChange={set('tagline')} placeholder="Shown under the name on printed documents" />
              </Field>
              <Field label="Primary colour" hint="Six-digit hex with a hash, such as #1e40af. Anything else is refused rather than rendered black.">
                <Input value={current.primary_color ?? ''} onChange={set('primary_color')} placeholder="#1e40af" />
              </Field>
              <Field label="Accent colour">
                <Input value={current.accent_color ?? ''} onChange={set('accent_color')} placeholder="#f59e0b" />
              </Field>
              <Field label="Logo key">
                <Input value={current.logo_key ?? ''} onChange={set('logo_key')} />
              </Field>
              <Field label="Wordmark key">
                <Input value={current.wordmark_key ?? ''} onChange={set('wordmark_key')} />
              </Field>
              <Field label="Support email" hint="Shown to families when something goes wrong, in place of the vendor's address.">
                <Input value={current.support_email ?? ''} onChange={set('support_email')} />
              </Field>
              <Field label="Support telephone">
                <Input value={current.support_phone ?? ''} onChange={set('support_phone')} />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice error={save.error} ok={save.isSuccess && !touched ? 'Branding saved.' : undefined} />
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
