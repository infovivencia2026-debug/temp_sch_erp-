import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageBody, Card, CardHeader, Select, ExportButton } from '@/components/ui'

interface Klass { id: string; name: string; level?: number }
interface Section { id: string; class_id: string; name: string }

/* THE SCHOOL'S FEE SHEET (2026-10-12, asked by Yajur). The whole school, or
   one class, as a spreadsheet: one row per child, class by class (not split
   by section), with Term 1/2/3, Books, Uniform and Transport -- fee, paid and
   due for each -- and the totals. This year's bills only. */
export default function FeeSheet() {
  const [klass, setKlass] = useState('')
  const [section, setSection] = useState('')
  const sections = useQuery({ queryKey: ['sections'], queryFn: () => api.get<{ items: Section[] }>('/api/v1/academics/sections') })
  const secOptions = (sections.data?.items ?? []).filter((s) => s.class_id === klass)
    .sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ value: s.id, label: s.name }))
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api.get<{ items: Klass[] }>('/api/v1/academics/classes') })
  const options = [...(classes.data?.items ?? [])]
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
    .map((c) => ({ value: c.id, label: c.name }))
  return (
    <PageBody>
      <Card>
        {/* The card's own header and padding, so title, text and controls share one left edge. */}
        <CardHeader title="Download the fee sheet"
          description="One row per child, class by class. For each child: total fee, concession and net fee, then Term 1, Term 2, Term 3, Books, Uniform and Transport (fee, paid and due), and the total paid and due. This year only." />
        <div className="flex flex-wrap items-center gap-2 px-[var(--card-pad)] pb-4">
          <div className="w-full sm:w-64">
            <Select value={klass} onChange={(v) => { setKlass(v); setSection('') }} options={options} placeholder="Whole school" />
          </div>
          {klass && secOptions.length > 1 && (
            <div className="w-full sm:w-48">
              <Select value={section} onChange={setSection} options={secOptions} placeholder="All sections" />
            </div>
          )}
          <ExportButton report="fee_sheet" label="Download" query={{ class: klass, section }} />
        </div>
      </Card>
    </PageBody>
  )
}
