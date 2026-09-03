import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Select, Checkbox, Field, FormGrid, FormNotice, SkeletonTiles,
  ErrorState, UnavailableState,
} from '@/components/ui'
import { usePlatform, usePlatformSave, bytes, type BackupPosture } from './platform-lib'

/**
 * Whether this school is actually being backed up.
 *
 * Not a button that takes a backup. Copying a Postgres cluster is the
 * operator's pipeline, and a web request shelling out to pg_dump competes with
 * the database for the same disk at whatever hour somebody clicks — which is
 * how a backup becomes an outage.
 *
 * What this screen does is hold the pipeline to the policy. The age of the
 * newest restore point, measured against how often the school said it would be
 * backed up, is the only question worth asking, because a backup nobody
 * checked is the same as no backup.
 */
export default function BackupRestore() {
  const { data, isLoading, error } = usePlatform<BackupPosture>('backups', '/backups')
  const save = usePlatformSave('backups', '/backups')

  const [draft, setDraft] = useState<Partial<BackupPosture> | null>(null)

  if (isLoading) return <SkeletonTiles count={4} />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const v = { ...data, ...(draft ?? {}) }
  const set = <K extends keyof BackupPosture>(k: K, val: BackupPosture[K]) =>
    setDraft({ ...(draft ?? {}), [k]: val })

  const age =
    data.last_good_hours == null
      ? 'Never'
      : data.last_good_hours < 24
        ? `${data.last_good_hours} hours ago`
        : `${Math.floor(data.last_good_hours / 24)} days ago`

  return (
    <>
      <PageHead
        eyebrow="Operations"
        title="Data backup & restore"
        description="The backup schedule this school is held to, and the register of what has actually been taken."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Newest restore point"
            value={age}
            hint={data.last_good_at ?? 'No successful backup has ever been recorded'}
          />
          <Stat
            label="Against the policy"
            value={data.lapsed ? 'Lapsed' : 'Current'}
            hint={data.enabled ? `${data.frequency}, retained ${data.retention_days} days` : 'Backups are switched off'}
          />
          <Stat label="Point-in-time window" value={`${data.pitr_window_days} days`} />
          <Stat label="Failed runs (30 days)" value={data.failed_runs_30_days} />
        </CellGrid>

        {data.lapsed && (
          <Card className="border-destructive/30">
            <div className="p-5">
              <p className="text-[14px] font-medium text-destructive">
                {data.last_good_at
                  ? 'The newest backup is older than the schedule allows.'
                  : 'No successful backup has ever been recorded for this school.'}
              </p>
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                Either the pipeline is not running, or it is running and not reporting. Both look the
                same from here and both need somebody to look at the machine.
              </p>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Policy"
            description="What the operator's pipeline is expected to do, and what this screen measures it against"
            action={
              <Button
                disabled={save.isPending}
                onClick={() =>
                  save.mutate(
                    {
                      enabled: v.enabled,
                      frequency: v.frequency,
                      run_at_hour: Number(v.run_at_hour) || 0,
                      retention_days: Number(v.retention_days) || 30,
                      pitr_window_days: Number(v.pitr_window_days) || 0,
                      destination: v.destination,
                    },
                    { onSuccess: () => setDraft(null) },
                  )
                }
              >
                Save policy
              </Button>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Backups">
                <Checkbox
                  checked={v.enabled}
                  onChange={(x) => set('enabled', x)}
                  label="This school is backed up"
                  hint="Switching this off stops the lapsed warning; it does not stop the pipeline."
                />
              </Field>
              <Field label="Frequency">
                <Select
                  value={v.frequency}
                  onChange={(x) => set('frequency', x)}
                  options={[
                    { value: 'hourly', label: 'Hourly' },
                    { value: 'daily', label: 'Daily' },
                    { value: 'weekly', label: 'Weekly' },
                  ]}
                />
              </Field>
              <Field label="Run at (hour, IST)" hint="India time, not the server's. A UTC hour here runs the backup during the school's morning.">
                <Input value={String(v.run_at_hour)} onChange={(x) => set('run_at_hour', Number(x) || 0)} />
              </Field>
              <Field label="Retention (days)">
                <Input value={String(v.retention_days)} onChange={(x) => set('retention_days', Number(x) || 0)} />
              </Field>
              <Field
                label="Point-in-time window (days)"
                hint="How far back a restore can reach. Weekly copies kept for a year still only give PITR to the last archived log."
              >
                <Input
                  value={String(v.pitr_window_days)}
                  onChange={(x) => set('pitr_window_days', Number(x) || 0)}
                />
              </Field>
              <Field label="Destination">
                <Select
                  value={v.destination}
                  onChange={(x) => set('destination', x)}
                  options={[
                    { value: 'object_store', label: 'Object store' },
                    { value: 'local', label: 'Local disk' },
                    { value: 'offsite', label: 'Offsite' },
                  ]}
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice error={save.error} ok={save.isSuccess && !draft ? 'Policy saved.' : undefined} />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Register" description="Reported by the pipeline as each run completes" />
          <Table
            head={['Started', 'Kind', 'Status', 'Restore point', 'Size', 'Stored at']}
            empty={!data.runs.length}
            emptyLabel="Nothing reported. Until the pipeline posts a run this school has no evidence of a backup, whatever the policy says."
          >
            {data.runs.map((r) => (
              <tr key={r.id}>
                <Td>{r.started_at.replace('T', ' ').slice(0, 16)}</Td>
                <Td>{r.kind}</Td>
                <Td>
                  <Badge
                    tone={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}
                  >
                    {r.status}
                  </Badge>
                  {r.error && <span className="block text-[12px] text-destructive">{r.error}</span>}
                </Td>
                <Td>{r.restore_point?.replace('T', ' ').slice(0, 16) ?? '—'}</Td>
                <Td>{bytes(r.size_bytes)}</Td>
                <Td className="font-mono text-[12px]">{r.object_key ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader title="Taking and restoring a backup" />
          <div className="p-5">
            <UnavailableState
              title="There is no button here that takes a backup, and that is deliberate."
              body={data.runs_blocked_by}
              technical={[
                { label: 'Pipeline reports to', value: 'POST /api/v1/admin/platform/backups/runs' },
                { label: 'Permission', value: 'platform.tenants.write' },
                {
                  label: 'Refused by the schema',
                  value: 'a run marked succeeded with no restore point',
                },
              ]}
            />
          </div>
        </Card>
      </PageBody>
    </>
  )
}
