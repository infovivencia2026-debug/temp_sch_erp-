import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageBody, Card, Select, ExportButton } from '@/components/ui'

interface Klass { id: string; name: string; level?: number }

/* THE SCHOOL'S FEE SHEET (2026-10-12, asked by Yajur). The whole school, or
   one class, as a spreadsheet: one row per child, class by class (not split
   by section), with Term 1/2/3, Books, Uniform and Transport -- fee, paid and
   due for each -- and the totals. This year's bills only. */
export default function FeeSheet() {
  const [klass, setKlass] = useState('')
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api.get<{ items: Klass[] }>('/api/v1/academics/classes') })
  const options = [...(classes.data?.items ?? [])]
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
    .map((c) => ({ value: c.id, label: c.name }))
  return (
    <PageBody>
      <Card className="p-4 space-y-3">
        <div className="text-[15px] font-semibold">Download the fee sheet</div>
        <p className="text-[13px] text-muted-foreground">
          One row per child, class by class. For each child: total fee, concession and net fee, then Term 1, Term 2,
          Term 3, Books, Uniform and Transport (fee, paid and due), and the total paid and due. This year only.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-64">
            <Select value={klass} onChange={setKlass} options={[{ value: '', label: 'Whole school' }, ...options]} placeholder="Whole school" />
          </div>
          <ExportButton report="fee_sheet" label="Download" query={{ class: klass }} />
        </div>
      </Card>
    </PageBody>
  )
}
