import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button,
  ConfirmButton, Input, Select, Field, FormGrid, FormNotice, Loading, ErrorState,
} from '@/components/ui'
import { usePlatformSave, usePlatformDelete, type LocationCode } from './platform-lib'

const BASE = '/api/v1/admin/platform/locations'

const CHILD_LEVEL: Record<string, string> = {
  state: 'district',
  district: 'mandal',
  mandal: 'village',
}

/**
 * State, district, mandal, village — the codes every government return keys on.
 *
 * A drill-down rather than a flat list. Telangana alone has thirty-three
 * districts and close to six hundred mandals; a single table of six hundred
 * rows is not a master, it is a haystack, and the person maintaining it is
 * always working inside one district.
 *
 * Retiring a code hides it from every picker without deleting it, because the
 * returns already filed against a merged mandal still name it.
 */
export default function DistrictMandalMaster() {
  // The path down the tree. Each entry is the row that was opened, so the
  // breadcrumb and the "add a child here" form both read from one place.
  const [trail, setTrail] = useState<LocationCode[]>([])
  const parent = trail[trail.length - 1]

  const { data, isLoading, error } = useQuery({
    queryKey: ['platform', 'locations', parent?.id ?? 'root'],
    queryFn: () =>
      api.get<List<LocationCode>>(parent ? `${BASE}?parent_id=${parent.id}` : BASE),
  })

  const save = usePlatformSave('locations', '/locations', 'post')
  const retire = usePlatformDelete('locations')

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [showRetired, setShowRetired] = useState('active')

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />

  const all = data?.items ?? []
  const items = showRetired === 'all' ? all : all.filter((i) => i.active)
  const childLevel = parent ? CHILD_LEVEL[parent.level] : 'state'

  return (
    <>
      <PageHead
        eyebrow="Statutory & Boards"
        title="District & mandal master"
        description="The state, district, mandal and village codes every government return is filed against."
      />
      <PageBody>
        <Card>
          <CardHeader
            title={
              trail.length
                ? trail.map((t) => t.name).join(' › ')
                : 'States'
            }
            description={
              parent
                ? `${parent.level} ${parent.code} — showing the ${childLevel}s beneath it`
                : 'Open a state to reach its districts, and a district to reach its mandals'
            }
            action={
              <div className="flex items-center gap-2">
                {trail.length > 0 && (
                  <Button variant="secondary" size="sm" onClick={() => setTrail(trail.slice(0, -1))}>
                    Back
                  </Button>
                )}
                <Select
                  value={showRetired}
                  onChange={setShowRetired}
                  options={[
                    { value: 'active', label: 'In use' },
                    { value: 'all', label: 'Including retired' },
                  ]}
                />
              </div>
            }
          />
          <Table
            head={['Code', 'Name', 'Level', 'Beneath it', 'State', '']}
            empty={!items.length}
            emptyLabel={
              parent
                ? `No ${childLevel}s recorded here yet. Add the ones this school actually reports against.`
                : 'No states recorded.'
            }
          >
            {items.map((l) => (
              <tr key={l.id}>
                <Td className="font-mono text-[12.5px]">{l.code}</Td>
                <Td className="font-medium">{l.name}</Td>
                <Td>{l.level}</Td>
                <Td>{l.children || '—'}</Td>
                <Td>
                  {l.active ? <Badge tone="success">In use</Badge> : <Badge tone="neutral">Retired</Badge>}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {CHILD_LEVEL[l.level] && (
                      <Button variant="secondary" size="sm" onClick={() => setTrail([...trail, l])}>
                        Open
                      </Button>
                    )}
                    {l.active && (
                      <ConfirmButton
                        confirmLabel="Retire"
                        question="Hide this code from every picker?"
                        onConfirm={() => retire.mutate(`/locations/${l.id}`)}
                      >
                        Retire
                      </ConfirmButton>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {childLevel && (
          <Card>
            <CardHeader
              title={`Add a ${childLevel}`}
              description={
                parent
                  ? `Recorded beneath ${parent.name}. A code already present here is updated rather than duplicated.`
                  : 'A state sits at the top of the tree and has no parent.'
              }
              action={
                <Button
                  disabled={save.isPending || !code || !name}
                  onClick={() =>
                    save.mutate(
                      {
                        parent_id: parent?.id ?? '',
                        level: childLevel,
                        code,
                        name,
                      },
                      {
                        onSuccess: () => {
                          setCode('')
                          setName('')
                        },
                      },
                    )
                  }
                >
                  Add {childLevel}
                </Button>
              }
            />
            <div className="p-5">
              <FormGrid>
                <Field label="Code" required hint="The government's own code, as it appears on the return.">
                  <Input value={code} onChange={setCode} placeholder="e.g. 07" />
                </Field>
                <Field label="Name" required>
                  <Input value={name} onChange={setName} placeholder="e.g. Quthbullapur" />
                </Field>
              </FormGrid>
              <div className="mt-4">
                <FormNotice error={save.error} />
              </div>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
