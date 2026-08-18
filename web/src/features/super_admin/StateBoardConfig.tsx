import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button,
  ConfirmButton, Input, Select, Checkbox, Field, FormGrid, FormNotice,
  Loading, ErrorState,
} from '@/components/ui'
import {
  usePlatform, usePlatformSave, usePlatformDelete, type BoardConfigResponse,
} from './platform-lib'

/**
 * Which board's rules apply, and to which part of the school.
 *
 * One row per stage rather than one per school, because a Telangana school
 * commonly runs SSC to class X and TSBIE for Intermediate, and the two differ
 * on pass mark, internal weighting and the attendance a candidate needs before
 * they are sent up. A single board setting on the school profile cannot say
 * that, which is why a report card generator reading one is wrong for half the
 * building.
 */
export default function StateBoardConfig() {
  const { data, isLoading, error } = usePlatform<BoardConfigResponse>('board-config', '/board-config')
  const save = usePlatformSave('board-config', '/board-config', 'post')
  const remove = usePlatformDelete('board-config')

  const [board, setBoard] = useState('')
  const [stage, setStage] = useState('')
  const [pass, setPass] = useState('35')
  const [max, setMax] = useState('100')
  const [internal, setInternal] = useState('20')
  const [attendance, setAttendance] = useState('75')
  const [pattern, setPattern] = useState('formative_summative')
  const [scale, setScale] = useState('')
  const [medium, setMedium] = useState('')
  const [isDefault, setIsDefault] = useState(false)

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const label = (opts: { value: string; label: string }[], v: string) =>
    opts.find((o) => o.value === v)?.label ?? v

  return (
    <>
      <PageHead
        eyebrow="Statutory & Boards"
        title="State board configuration"
        description="The board each stage of the school follows, and the assessment rules that come with it."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Configured stages"
            description="Marked rules are read by the exam and report card screens; the default applies where a stage has no rule of its own"
          />
          <Table
            head={['Stage', 'Board', 'Pass', 'Internal', 'Attendance', 'Pattern', 'Grading scale', '']}
            empty={!data.items.length}
            emptyLabel="No board rules configured. Until one exists the exam screens fall back to their own defaults."
          >
            {data.items.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium">
                  {label(data.stages, b.stage)}
                  {b.is_default && (
                    <span className="ml-2">
                      <Badge tone="primary" solid>
                        default
                      </Badge>
                    </span>
                  )}
                </Td>
                <Td>{label(data.boards, b.board)}</Td>
                <Td>
                  {b.pass_percent}% of {b.max_marks}
                </Td>
                <Td>{b.internal_weight_percent}%</Td>
                <Td>
                  {b.attendance_min_percent < 75 ? (
                    <Badge tone="warning">{b.attendance_min_percent}%</Badge>
                  ) : (
                    `${b.attendance_min_percent}%`
                  )}
                </Td>
                <Td>{label(data.exam_patterns, b.exam_pattern)}</Td>
                <Td>{b.grading_scale ?? <span className="text-muted-foreground">Not set</span>}</Td>
                <Td>
                  <ConfirmButton
                    confirmLabel="Remove"
                    question="Remove this board rule?"
                    tone="danger"
                    onConfirm={() => remove.mutate(`/board-config/${b.id}`)}
                  >
                    Remove
                  </ConfirmButton>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Add or amend a stage"
            description="Saving an existing board and stage pair replaces its rule"
            action={
              <Button
                disabled={save.isPending || !board || !stage}
                onClick={() =>
                  save.mutate({
                    board,
                    stage,
                    pass_percent: Number(pass) || 0,
                    max_marks: Number(max) || 100,
                    internal_weight_percent: Number(internal) || 0,
                    attendance_min_percent: Number(attendance) || 0,
                    exam_pattern: pattern,
                    grading_scale_id: scale,
                    medium,
                    is_default: isDefault,
                  })
                }
              >
                Save rule
              </Button>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Stage" required>
                <Select value={stage} onChange={setStage} options={data.stages} placeholder="Select a stage" />
              </Field>
              <Field label="Board" required>
                <Select value={board} onChange={setBoard} options={data.boards} placeholder="Select a board" />
              </Field>
              <Field label="Pass mark (%)" hint="35% is the Telangana SSC rule; CBSE uses 33%.">
                <Input value={pass} onChange={setPass} />
              </Field>
              <Field label="Maximum marks per subject">
                <Input value={max} onChange={setMax} />
              </Field>
              <Field
                label="Internal assessment weight (%)"
                hint="The share of the final mark that comes from formative work rather than the board paper."
              >
                <Input value={internal} onChange={setInternal} />
              </Field>
              <Field
                label="Minimum attendance (%)"
                hint="Below this a candidate is not sent up for the board examination."
              >
                <Input value={attendance} onChange={setAttendance} />
              </Field>
              <Field label="Examination pattern">
                <Select value={pattern} onChange={setPattern} options={data.exam_patterns} />
              </Field>
              <Field label="Grading scale">
                <Select
                  value={scale}
                  onChange={setScale}
                  options={data.grading_scales}
                  placeholder={data.grading_scales.length ? 'Select a scale' : 'No scales defined yet'}
                />
              </Field>
              <Field label="Medium of instruction">
                <Input value={medium} onChange={setMedium} placeholder="e.g. English, Telugu" />
              </Field>
              <Field label="Default">
                <Checkbox
                  checked={isDefault}
                  onChange={setIsDefault}
                  label="Use this rule where a stage has none of its own"
                  hint="Only one rule per school may be the default; setting this clears the previous one."
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice error={save.error} ok={save.isSuccess ? 'Rule saved.' : undefined} />
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
