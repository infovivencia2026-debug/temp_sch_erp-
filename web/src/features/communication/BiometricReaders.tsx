import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fingerprint, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Input,
  Field, FormGrid, FormNotice, Reload, Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* The fingerprint readers this school runs.

   A reader speaks ADMS: it dials out to us on a schedule it keeps itself, and
   identifies itself with a serial number and nothing else. That serial is the
   only credential it can offer, which is why a device is registered inactive
   and switched on deliberately — a serial typed wrong would otherwise begin
   accepting somebody else's punches with nobody watching.

   The two figures on each row are the two questions a school actually asks. Is
   it still talking to us: last seen. And is anybody coming through it who is
   not on our roll: punches from a finger no employee claims, which is how a
   school finds out somebody enrolled at the machine without telling the
   office. */

interface Device {
  id: string
  serial: string
  name: string
  is_active: boolean
  last_seen_at?: string
  last_push_at?: string
  note?: string
  punches_today: number
  unresolved: number
}

interface Unclaimed {
  device_user_id: number
  punches: number
  first_seen: string
  last_seen: string
}

const ago = (iso?: string) => {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`
  return `${Math.round(mins / 1440)} d ago`
}

export default function BiometricReaders() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ serial: '', name: '' })

  const devices = useQuery({
    queryKey: ['biometric-devices'],
    queryFn: () => api.get<List<Device>>('/api/v1/admin/biometric-devices'),
  })
  const unclaimed = useQuery({
    queryKey: ['biometric-unclaimed'],
    queryFn: () => api.get<List<Unclaimed>>('/api/v1/admin/biometric-devices/unclaimed'),
  })

  const save = useMutation({
    mutationFn: (body: { serial: string; name: string; is_active?: boolean }) =>
      api.post<{ note?: string }>('/api/v1/admin/biometric-devices', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['biometric-devices'] })
      setAdding(false)
      setF({ serial: '', name: '' })
    },
  })

  const rows = devices.data?.items ?? []
  const orphans = unclaimed.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Staff"
        title="Attendance readers"
        description="The fingerprint readers this school runs. Each one dials out to us as punches happen, so staff attendance is current rather than collected at the end of the day."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Readers"
            description="A reader is registered before it is trusted. Activate it once it shows as seen."
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
                  <Plus className="h-3.5 w-3.5" /> Add a reader
                </Button>
                <Reload
                  onClick={() => devices.refetch()}
                  busy={devices.isFetching}
                  label="Re-read the devices"
                />
              </div>
            }
          />

          {adding && (
            <div className="space-y-3 border-b px-5 py-4">
              <FormGrid>
                <Field
                  label="Serial"
                  required
                  hint="Printed on the label on the back of the reader, and the only thing it tells us about itself."
                >
                  <Input value={f.serial} onChange={(v) => setF({ ...f, serial: v })} />
                </Field>
                <Field label="Name" required hint="Where it is. “Main gate”, “Staff room”.">
                  <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} />
                </Field>
              </FormGrid>
              <FormNotice error={save.error} />
              <Button
                disabled={!f.serial.trim() || !f.name.trim() || save.isPending}
                onClick={() => save.mutate({ serial: f.serial.trim(), name: f.name.trim() })}
              >
                Register
              </Button>
              <p className="text-[13px] text-muted-foreground">
                Then on the reader: <strong>Comm → Cloud Server / ADMS</strong>, set the server
                address to this site and leave the path blank — it appends <code>/iclock</code>{' '}
                itself. There is one such slot, so this replaces whatever it was pointing at.
              </p>
            </div>
          )}

          {devices.isLoading ? (
            <Loading />
          ) : devices.error ? (
            <ErrorState error={devices.error} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No readers registered"
              body="Add the serial from the label on the back, then point the reader at this site."
            />
          ) : (
            <Table head={['Reader', 'Serial', 'Last seen', 'Punches today', 'Unclaimed', '']}>
              {rows.map((d) => (
                <tr key={d.id}>
                  <Td className="font-medium">
                    <span className="inline-flex items-center gap-2">
                      <Fingerprint className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      {d.name}
                    </span>
                    {!d.is_active && (
                      <span className="block text-[12px] text-muted-foreground">
                        Registered, not yet trusted — punches are refused
                      </span>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">{d.serial}</Td>
                  <Td className="whitespace-nowrap">{ago(d.last_seen_at)}</Td>
                  <Td className="tabular-nums">{d.punches_today}</Td>
                  <Td>
                    {d.unresolved > 0 ? (
                      <Badge tone="warning">{d.unresolved}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant={d.is_active ? 'ghost' : 'primary'}
                      disabled={save.isPending}
                      onClick={() =>
                        save.mutate({ serial: d.serial, name: d.name, is_active: !d.is_active })
                      }
                    >
                      {d.is_active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {orphans.length > 0 && (
          <Card>
            <CardHeader
              title="Fingers nobody claims"
              description="Punches arriving under an id no staff record carries. Somebody enrolled at the machine without telling the office — or a staff record is missing its reader id."
            />
            <Table head={['Reader id', 'Punches', 'First seen', 'Last seen']}>
              {orphans.map((o) => (
                <tr key={o.device_user_id}>
                  <Td className="font-mono">{o.device_user_id}</Td>
                  <Td className="tabular-nums">{o.punches}</Td>
                  <Td className="whitespace-nowrap">{o.first_seen}</Td>
                  <Td className="whitespace-nowrap">{o.last_seen}</Td>
                </tr>
              ))}
            </Table>
            <p className="px-5 pb-4 text-[13px] text-muted-foreground">
              Set the matching number on the staff record — it is the reader id field — and every
              punch already collected under it resolves on the next push.
            </p>
          </Card>
        )}
      </PageBody>
    </>
  )
}
