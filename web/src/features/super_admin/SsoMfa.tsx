import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Input,
  Select, Checkbox, Field, FormGrid, FormNotice, Loading, ErrorState,
  UnavailableState,
} from '@/components/ui'
import { usePlatform, usePlatformSave, type AuthPolicy } from './platform-lib'

/**
 * How this school's people prove who they are.
 *
 * The multi-factor half is real and enforced: the policy names the roles that
 * must carry a second factor, and the count beside it is measured against that
 * rule rather than against everybody. "412 of 800 have MFA" is noise in a
 * school where most accounts are parents; "3 of the 5 people the policy covers
 * do not" is a morning's work.
 *
 * The single sign-on half is configuration and says so. There is no SAML or
 * OIDC adapter in this product and no identity provider connected, so nothing
 * on this screen changes how anybody signs in today. A switch that appeared to
 * work would be worse than none: a school that believes single sign-on is on
 * and stops managing passwords has been made less safe, not more.
 */
export default function SsoMfa() {
  const { data, isLoading, error } = usePlatform<AuthPolicy>('auth-policy', '/auth-policy')
  const save = usePlatformSave('auth-policy', '/auth-policy')

  const [draft, setDraft] = useState<Partial<AuthPolicy> | null>(null)

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const v: AuthPolicy = { ...data, ...(draft ?? {}) }
  const set = <K extends keyof AuthPolicy>(k: K, val: AuthPolicy[K]) =>
    setDraft({ ...(draft ?? {}), [k]: val })

  const toggleRole = (role: string) => {
    const has = v.mfa_required_roles.includes(role)
    set(
      'mfa_required_roles',
      has ? v.mfa_required_roles.filter((r) => r !== role) : [...v.mfa_required_roles, role],
    )
  }

  return (
    <>
      <PageHead
        eyebrow="Access & Security"
        title="SSO / MFA"
        description="Which roles must carry a second factor, what a password has to be, and where single sign-on stands."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Active accounts" value={data.users} />
          <Stat label="Enrolled in MFA" value={data.mfa_enrolled} />
          <Stat label="Covered by the rule" value={data.users_covered_by_rule} hint="Accounts holding a role the policy names" />
          <Stat
            label="Covered but not enrolled"
            value={data.users_covered_without_mfa}
            hint={data.users_covered_without_mfa ? 'These are the accounts to chase' : 'Everyone covered is enrolled'}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Multi-factor authentication"
            description="Applied by role rather than to everybody — eight hundred parent accounts are not a policy any school adopts"
            action={
              <Button
                disabled={save.isPending}
                onClick={() =>
                  save.mutate(
                    {
                      mfa_required_roles: v.mfa_required_roles,
                      mfa_grace_days: Number(v.mfa_grace_days) || 0,
                      password_min_length: Number(v.password_min_length) || 10,
                      password_expiry_days: Number(v.password_expiry_days) || 0,
                      session_idle_minutes: Number(v.session_idle_minutes) || 120,
                      allowed_email_domains: v.allowed_email_domains,
                      sso_enabled: v.sso_enabled,
                      sso_protocol: v.sso_protocol ?? '',
                      sso_provider: v.sso_provider ?? '',
                      sso_entity_id: v.sso_entity_id ?? '',
                      sso_metadata_url: v.sso_metadata_url ?? '',
                    },
                    { onSuccess: () => setDraft(null) },
                  )
                }
              >
                Save policy
              </Button>
            }
          />
          <div className="p-5 space-y-5">
            <div>
              <p className="mb-2 text-[13px] font-medium text-secondary-foreground">Roles that must enrol</p>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {data.roles.map((r) => (
                  <Checkbox
                    key={r.value}
                    checked={v.mfa_required_roles.includes(r.value)}
                    onChange={() => toggleRole(r.value)}
                    label={r.label}
                  />
                ))}
              </div>
            </div>

            <FormGrid>
              <Field
                label="Grace period (days)"
                hint="How long a new account may sign in before enrolling. Zero locks out anyone created in bulk."
              >
                <Input value={String(v.mfa_grace_days)} onChange={(x) => set('mfa_grace_days', Number(x) || 0)} />
              </Field>
              <Field label="Minimum password length" hint="Between 8 and 64. The schema refuses anything shorter.">
                <Input
                  value={String(v.password_min_length)}
                  onChange={(x) => set('password_min_length', Number(x) || 0)}
                />
              </Field>
              <Field
                label="Password expiry (days)"
                hint="Zero means passwords do not expire. Forced monthly rotation is how a school ends up with the password on a sticky note."
              >
                <Input
                  value={String(v.password_expiry_days)}
                  onChange={(x) => set('password_expiry_days', Number(x) || 0)}
                />
              </Field>
              <Field label="Idle session timeout (minutes)">
                <Input
                  value={String(v.session_idle_minutes)}
                  onChange={(x) => set('session_idle_minutes', Number(x) || 0)}
                />
              </Field>
              <Field
                label="Allowed email domains"
                wide
                hint="Comma separated. Leave blank where parents sign in with their own addresses, which is most schools."
              >
                <Input
                  value={v.allowed_email_domains.join(', ')}
                  onChange={(x) =>
                    set(
                      'allowed_email_domains',
                      x.split(',').map((d) => d.trim()).filter(Boolean),
                    )
                  }
                  placeholder="stjohns.edu.in"
                />
              </Field>
            </FormGrid>
            <FormNotice error={save.error} ok={save.isSuccess && !draft ? 'Policy saved.' : undefined} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Single sign-on"
            description="Configuration is recorded and read by the sign-in page once an adapter exists"
            action={
              data.sso_verified_at ? (
                <Badge tone="success">Connection proven</Badge>
              ) : (
                <Badge tone="warning">Not connected</Badge>
              )
            }
          />
          <div className="p-5 space-y-5">
            <UnavailableState
              title="Single sign-on is not available on this installation."
              body={data.sso_blocked_by}
              technical={[
                { label: 'Adapter', value: 'none — internal/auth carries the password path only' },
                { label: 'Stored', value: 'protocol, provider, entity id, metadata URL' },
                { label: 'Never set from a request', value: 'sso_verified_at' },
              ]}
            />

            <FormGrid>
              <Field label="Enable">
                <Checkbox
                  checked={v.sso_enabled}
                  onChange={(x) => set('sso_enabled', x)}
                  label="Record that this school intends to use single sign-on"
                  hint="Naming a protocol and a provider is required; the schema refuses a half-configured connection."
                />
              </Field>
              <Field label="Protocol">
                <Select
                  value={v.sso_protocol ?? ''}
                  onChange={(x) => set('sso_protocol', x)}
                  options={[
                    { value: 'saml2', label: 'SAML 2.0' },
                    { value: 'oidc', label: 'OpenID Connect' },
                  ]}
                  placeholder="Select a protocol"
                />
              </Field>
              <Field label="Provider">
                <Input
                  value={v.sso_provider ?? ''}
                  onChange={(x) => set('sso_provider', x)}
                  placeholder="Microsoft Entra ID, Google Workspace, state directory"
                />
              </Field>
              <Field label="Entity ID">
                <Input value={v.sso_entity_id ?? ''} onChange={(x) => set('sso_entity_id', x)} />
              </Field>
              <Field label="Metadata URL" wide>
                <Input
                  value={v.sso_metadata_url ?? ''}
                  onChange={(x) => set('sso_metadata_url', x)}
                  placeholder="https://"
                />
              </Field>
            </FormGrid>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
