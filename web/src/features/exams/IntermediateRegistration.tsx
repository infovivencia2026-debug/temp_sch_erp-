import { useState } from 'react'
import { Select } from '@/components/ui'
import { BoardRoll } from './BoardRoll'

/* Classes 11 and 12 with TSBIE.

   The Intermediate is two examinations a year apart, not one taken twice: the
   board charges separately for each and the first year's result stands on its
   own. The year is chosen here rather than being two catalogue entries,
   because the office moves between them constantly during the entry window. */
export default function IntermediateRegistration() {
  const [year, setYear] = useState<'inter_first_year' | 'inter_second_year'>('inter_second_year')
  const label = year === 'inter_first_year' ? 'first year' : 'second year'

  return (
    <>
      <div className="flex items-center gap-2 px-5 pt-5 sm:px-7">
        <span className="text-[13px] text-muted-foreground">Year</span>
        <Select
          value={year}
          onChange={(v) => setYear(v as 'inter_first_year' | 'inter_second_year')}
          options={[
            { value: 'inter_first_year', label: 'Intermediate first year (Class 11)' },
            { value: 'inter_second_year', label: 'Intermediate second year (Class 12)' },
          ]}
        />
      </div>
      <BoardRoll
        key={year}
        stage={year}
        eyebrow="Examinations"
        title="Intermediate board registration"
        description={`The TSBIE ${label} nominal roll: candidates, their group and second language, and what the board has said about each of them.`}
        defaultBoard="TSBIE"
        defaultExamName={`Intermediate Public Examination ${new Date().getFullYear() + 1}`}
        defaultSubjects="English, Second Language, Mathematics IIA, Mathematics IIB, Physics, Chemistry"
        groups={['MPC', 'BiPC', 'CEC', 'MEC', 'HEC']}
      />
    </>
  )
}
