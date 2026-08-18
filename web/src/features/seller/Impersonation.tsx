import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Input, Select, Field, FormGrid, FormNotice, Loading,
  ErrorState,
} from '@/components/ui'
import {
  usePlatformAction, type Grant, type GrantActivity,
} from '../super_admin/platform-lib'

const BASE = '/api/v1/admin/platform/impersonation'

/**
 * Standing inside a school, on the record.
 *
 * A vendor engineer reproducing a fault has to see what the school sees. What
 * was missing was everything around that: a reason, an end time, and a row the
 * school itself can read without asking the vendor for a log it has no way to
 * verify.
 *
 * The register is tenant-scoped, so this same screen serves two people. The
 * vendor sees every session on the installation. A school's own administrator
 * sees the sessions inside their school — and can end one, which is the
 * difference between a notification and a control.
 */
export default function Impersonation() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['platform', 'impersonation'],
    queryFn: () => api.get<List<Grant>>(BASE),
  })
  const schools = useQuery({
    queryKey: ['platform', 'institutions'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/admin/institutions'),
    // A school administrator reading their own register holds no right to list
    // every school, and a 403 in the corner of a working screen reads as a
    // fault. Asked for, allowed to fail, never surfaced as an error.
    retry: false,
  })

  const open = usePlatformAction('impersonation')
  const end = usePlatformAction('impersonation')

  const [school, setSchool] = useState('')
  const [reason, setReason] = useState('')
  const [minutes, setMinutes] = useState('60')
  const [inspecting, setInspecting] = useState<string | null>(null)

  const activity = useQuery({
    queryKey: ['platform', 'impersonation', 'activity', inspecting],
    queryFn: () => api.get<GrantActivity>(`${BASE}/${inspecting}/activity`),
    enabled: !!inspecting,
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />

  const items = data?.items ?? []
  const live = items.filter((g) => g.live)
  const canOpen = (schools.data?.items?.length ?? 0) > 0

  return (
    <>
      <PageHead
        eyebrow="Support"
        title="Impersonation & audit"
        description="Every time platform staff entered a school: why, for how long, and what they changed."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Sessions in progress" value={live.length} />
          <Stat label="Recorded" value={items.length} />
          <Stat label="Changes made" value={items.reduce((n, g) => n + g.changes, 0)} />
          <Stat label="Maximum session" value="4 hours" hint="Enforced by the schema, not by a handler" />
        </CellGrid>

        {live.length > 0 && (
          <Card className="border-warning/40">
            <CardHeader
              title={`${live.length} session${live.length > 1 ? 's' : ''} in progress`}
              description="Somebody from the vendor is inside a school right now"
            />
            <Table head={['School', 'Operator', 'Reason', 'Ends at', 'Changes', '']}>
              {live.map((g) => (
                <tr key={g.id}>
                  <Td className="font-medium">{g.school ?? g.institution_id}</Td>
                  <Td>{g.operator}</Td>
                  <Td>{g.reason}</Td>
                  <Td>{g.expires_at.replace('T', ' ').slice(0, 16)}</Td>
                  <Td>{g.changes}</Td>
                  <Td>
                    <ConfirmButton
                      confirmLabel="End now"
                      question="End this session?"
                      tone="danger"
                      onConfirm={() =>
                        end.mutate({ path: `/impersonation/${g.id}/end`, body: { reason: 'ended from the register' } })
                      }
                    >
                      End
                    </ConfirmButton>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Register"
            description="A school sees the sessions inside its own walls; the vendor sees all of them"
          />
          <Table
            head={['School', 'Operator', 'Reason', 'Started', 'Ended', 'Changes', '']}
            empty={!items.length}
            emptyLabel="Nobody from the vendor has entered a school. This is the good state."
          >
            {items.map((g) => (
              <tr key={g.id}>
                <Td className="font-medium">{g.school ?? g.institution_id}</Td>
                <Td>{g.operator}</Td>
                <Td>
                  {g.reason}
                  {g.ended_reason && (
                    <span className="block text-[12px] text-muted-foreground">
                      Ended: {g.ended_reason}
                      {g.ended_by ? ` — ${g.ended_by}` : ''}
                    </span>
                  )}
                </Td>
                <Td>{g.started_at.replace('T', ' ').slice(0, 16)}</Td>
                <Td>
                  {g.live ? (
                    <Badge tone="warning">In progress</Badge>
                  ) : g.ended_at ? (
                    g.ended_at.replace('T', ' ').slice(0, 16)
                  ) : (
                    <Badge tone="neutral">Expired</Badge>
                  )}
                </Td>
                <Td>{g.changes}</Td>
                <Td>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setInspecting(inspecting === g.id ? null : g.id)}
                  >
                    {inspecting === g.id ? 'Hide' : 'What changed'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
          {end.isError && (
            <div className="border-t p-5">
              <FormNotice error={end.error} />
            </div>
          )}
        </Card>

        {inspecting && (
          <Card>
            <CardHeader
              title="What changed during that session"
              description={activity.data?.covers}
            />
            {activity.data?.unattributed_note && (
              <div className="border-b bg-warning/5 px-5 py-3">
                <p className="text-[13px] font-medium text-warning">
                  {activity.data.unattributed_changes} change
                  {activity.data.unattributed_changes > 1 ? 's are' : ' is'} missing from this list.
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {activity.data.unattributed_note}
                </p>
              </div>
            )}
            {activity.isLoading ? (
              <Loading />
            ) : activity.error ? (
              <ErrorState error={activity.error} />
            ) : (
              <Table
                head={['When', 'Who', 'Action', 'Area', 'From']}
                empty={!activity.data?.items.length}
                emptyLabel="Nothing was changed. Reads are not recorded, so this does not mean nothing was seen."
              >
                {(activity.data?.items ?? []).map((a) => (
                  <tr key={a.id}>
                    <Td>{a.at.replace('T', ' ').slice(0, 19)}</Td>
                    <Td>{a.actor ?? '—'}</Td>
                    <Td className="font-mono text-[12px]">{a.action}</Td>
                    <Td>{a.entity_type}</Td>
                    <Td>{a.ip ?? '—'}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {canOpen && (
          <Card>
            <CardHeader
              title="Enter a school"
              description="The reason is shown to that school's administrator, so write it for them"
              action={
                <Button
                  disabled={open.isPending || !school || reason.trim().length < 8}
                  onClick={() =>
                    open.mutate(
                      {
                        path: '/impersonation',
                        body: { institution_id: school, reason, minutes: Number(minutes) || 60 },
                      },
                      {
                        onSuccess: () => {
                          setReason('')
                          setSchool('')
                        },
                      },
                    )
                  }
                >
                  Open a session
                </Button>
              }
            />
            <div className="p-5">
              <FormGrid>
                <Field label="School" required>
                  <Select
                    value={school}
                    onChange={setSchool}
                    options={(schools.data?.items ?? []).map((i) => ({ value: i.id, label: i.name }))}
                    placeholder="Select a school"
                  />
                </Field>
                <Field label="Length" hint="Four hours is the ceiling. A support session that outlives an afternoon is not one.">
                  <Select
                    value={minutes}
                    onChange={setMinutes}
                    options={[
                      { value: '15', label: '15 minutes' },
                      { value: '30', label: '30 minutes' },
                      { value: '60', label: '1 hour' },
                      { value: '120', label: '2 hours' },
                      { value: '240', label: '4 hours' },
                    ]}
                  />
                </Field>
                <Field
                  label="Reason"
                  required
                  wide
                  hint="At least a few words. Name the ticket or the fault — the school's administrator reads this line and nothing else."
                >
                  <Input
                    value={reason}
                    onChange={setReason}
                    placeholder="Reproducing the June receipt fault reported in ticket 412"
                  />
                </Field>
              </FormGrid>
              <div className="mt-4">
                <FormNotice error={open.error} ok={open.isSuccess ? 'Session opened and recorded in the school.' : undefined} />
              </div>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
