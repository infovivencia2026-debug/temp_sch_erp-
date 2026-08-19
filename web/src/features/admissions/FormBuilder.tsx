import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileText, Globe, Lock, ListChecks } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Checkbox, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import {
  ADMISSIONS_BASE as A, FIELD_TYPES, PATTERNS, REQUIRED_CODES, RESERVED_CODES,
  errText, labelOf, numOrNull,
  useAdmissionForms, useFormDefinition, useFormVersions,
  type AdmissionForm, type FieldType, type FormField,
} from './growth'

/* The application form a school designs for itself.

   Two things carry the whole feature, and both are visible on this screen
   rather than buried in the API.

   The first is versioning. A published definition is frozen: the builder shows
   its fields greyed with a padlock and offers "Take a draft", because a form
   already in use must not be silently mutated. Adding a required question on
   Tuesday would otherwise make Monday's submitted applications retrospectively
   incomplete and re-render them with a box nobody was ever shown.

   The second is that this screen does not validate anything. Every rule it
   sets — required, lengths, patterns, conditional visibility — is enforced by
   the server against the stored definition when an applicant submits. The
   public form is an unauthenticated surface, so a rule the browser applies is
   a rule an attacker simply does not run. What is built here is the
   definition; the enforcement lives in Go. */

type Draft = {
  section_id: string
  code: string
  label: string
  field_type: FieldType
  help_text: string
  placeholder: string
  is_required: boolean
  sequence: string
  option_kind: string
  optionsText: string
  min_length: string
  max_length: string
  min_number: string
  max_number: string
  pattern: string
  when_field: string
  when_equals: string
}

const emptyDraft = (sectionID: string): Draft => ({
  section_id: sectionID,
  code: '',
  label: '',
  field_type: 'text',
  help_text: '',
  placeholder: '',
  is_required: false,
  sequence: '',
  option_kind: '',
  optionsText: '',
  min_length: '',
  max_length: '',
  min_number: '',
  max_number: '',
  pattern: '',
  when_field: '',
  when_equals: '',
})

export default function FormBuilder() {
  const toast = useToast()
  const qc = useQueryClient()
  const forms = useAdmissionForms()

  const [formID, setFormID] = useState('')
  const [versionID, setVersionID] = useState('')
  const [newName, setNewName] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [sectionTitle, setSectionTitle] = useState('')
  const [draft, setDraft] = useState<Draft>(emptyDraft(''))

  const versions = useFormVersions(formID)
  const def = useFormDefinition(versionID)

  const form = (forms.data?.items ?? []).find((f) => f.id === formID)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admissions-forms'] })
    qc.invalidateQueries({ queryKey: ['admissions-form-versions'] })
    qc.invalidateQueries({ queryKey: ['admissions-form-version'] })
  }

  const createForm = useMutation({
    mutationFn: () =>
      api.post<{ id: string; draft_version_id: string }>(`${A}/forms`, {
        name: newName,
        slug: newSlug || undefined,
        is_open: false,
      }),
    onSuccess: (r) => {
      toast.ok('Form created as a draft')
      setNewName('')
      setNewSlug('')
      setFormID(r.id)
      setVersionID(r.draft_version_id)
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const takeDraft = useMutation({
    mutationFn: () => api.post<{ draft_version_id: string }>(`${A}/forms/${formID}/draft`, {}),
    onSuccess: (r) => {
      toast.ok('Draft opened — the live form is untouched until you publish')
      setVersionID(r.draft_version_id)
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const publish = useMutation({
    mutationFn: () => api.post(`${A}/form-versions/${versionID}/publish`, {}),
    onSuccess: () => {
      toast.ok('Published. This version is now frozen.')
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const setOpen = useMutation({
    mutationFn: (open: boolean) =>
      api.post(`${A}/forms/${formID}`, { name: form?.name, is_open: open }),
    onSuccess: () => {
      toast.ok('Saved')
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const addSection = useMutation({
    mutationFn: () =>
      api.post(`${A}/form-versions/${versionID}/sections`, {
        title: sectionTitle,
        sequence: (def.data?.sections.length ?? 0) + 1,
      }),
    onSuccess: () => {
      setSectionTitle('')
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const removeSection = useMutation({
    mutationFn: (id: string) => api.del(`${A}/form-sections/${id}`),
    onSuccess: invalidate,
    onError: (e) => toast.error(errText(e)),
  })

  const saveField = useMutation({
    mutationFn: () =>
      api.post(`${A}/form-versions/${versionID}/fields`, {
        section_id: draft.section_id,
        code: draft.code || undefined,
        label: draft.label,
        field_type: draft.field_type,
        help_text: draft.help_text || undefined,
        placeholder: draft.placeholder || undefined,
        is_required: draft.is_required,
        sequence: numOrNull(draft.sequence) ?? 0,
        option_kind: draft.option_kind || undefined,
        options: parseOptions(draft.optionsText),
        min_length: numOrNull(draft.min_length),
        max_length: numOrNull(draft.max_length),
        min_number: numOrNull(draft.min_number),
        max_number: numOrNull(draft.max_number),
        pattern: draft.pattern || undefined,
        visible_when: draft.when_field
          ? { field: draft.when_field, equals: draft.when_equals }
          : undefined,
      }),
    onSuccess: () => {
      toast.ok('Question saved')
      setDraft(emptyDraft(draft.section_id))
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const removeField = useMutation({
    mutationFn: (id: string) => api.del(`${A}/form-fields/${id}`),
    onSuccess: invalidate,
    onError: (e) => toast.error(errText(e)),
  })

  if (forms.isLoading) return <Loading />
  if (forms.error) return <ErrorState error={forms.error} />

  const rows = forms.data?.items ?? []
  const d = def.data
  const allCodes = (d?.sections ?? []).flatMap((s) => s.fields.map((f) => f.code))
  const missing = REQUIRED_CODES.filter((c) => !allCodes.includes(c))
  const frozen = !!d && !d.editable

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title="Online application form builder"
        description="Design the form families fill in. A published version is frozen so applications already submitted keep rendering as they were answered."
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Forms" value={rows.length} icon={FileText} />
          <Stat label="Open to applicants" value={rows.filter((f) => f.is_open).length} icon={Globe} />
          <Stat label="Applications received" value={rows.reduce((n, f) => n + f.submissions, 0)} />
          <Stat label="Questions on this version" value={allCodes.length} icon={ListChecks} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Forms"
            description="Each form has one live definition and, while you are editing, one draft."
          />
          <div className="p-5">
            <FormGrid>
              <Field label="New form" hint="For example, “Nursery admission 2026-27”.">
                <Input value={newName} onChange={setNewName} placeholder="Form name" />
              </Field>
              <Field
                label="Web address"
                hint="Left blank, this is made from the name. It goes on the poster, so keep it short."
              >
                <Input value={newSlug} onChange={setNewSlug} placeholder="nursery-2026" />
              </Field>
            </FormGrid>
            <div className="mt-5">
              <FormNotice error={createForm.error} />
              <Button
                onClick={() => createForm.mutate()}
                disabled={!newName.trim() || createForm.isPending}
              >
                Create as draft
              </Button>
            </div>
          </div>
          <Table
            head={['Form', 'Web address', 'Live', 'Draft', 'Applications', 'Status', '']}
            empty={rows.length === 0}
            emptyLabel="No application forms yet."
          >
            {rows.map((f) => (
              <tr key={f.id} className={f.id === formID ? 'bg-muted/40' : undefined}>
                <Td>{f.name}</Td>
                <Td className="font-mono text-[12.5px]">/apply/{f.slug}</Td>
                <Td>{f.live_version ? `v${f.live_version}` : '—'}</Td>
                <Td>{f.draft_version ? `v${f.draft_version}` : '—'}</Td>
                <Td>{f.submissions}</Td>
                <Td>
                  {f.is_open ? (
                    <Badge tone="success">Open</Badge>
                  ) : (
                    <Badge tone="neutral">Closed</Badge>
                  )}
                </Td>
                <Td>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFormID(f.id)
                      setVersionID('')
                    }}
                  >
                    Open
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {!formID && (
          <EmptyState
            title="Choose a form"
            body="Its versions, its questions and the address applicants use all belong to one form."
          />
        )}

        {formID && (
          <VersionsCard
            key={formID}
            form={form}
            versionID={versionID}
            onPick={setVersionID}
            versions={versions}
            onTakeDraft={() => takeDraft.mutate()}
            onSetOpen={(v) => setOpen.mutate(v)}
            busy={takeDraft.isPending || setOpen.isPending}
          />
        )}

        {versionID && def.isLoading && <Loading />}
        {versionID && def.error && <ErrorState error={def.error} />}

        {d && (
          <>
            {frozen && (
              <Card>
                <div className="flex items-start gap-3 p-5">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="text-[14px] leading-relaxed text-muted-foreground">
                    Version {d.version} is {d.status} and cannot be edited. Families who applied
                    under it must keep seeing the form they answered. Take a draft from it to make
                    changes — that becomes version {d.version + 1} and goes live only when you
                    publish it.
                  </p>
                </div>
              </Card>
            )}

            {!frozen && missing.length > 0 && (
              <Card>
                <div className="p-5 text-[14px] leading-relaxed text-muted-foreground">
                  This version cannot be published yet. An application record needs{' '}
                  <span className="font-medium text-foreground">{missing.join(', ')}</span> — add a
                  question with each of those codes. Without them the form would collect answers and
                  then fail at the last step, in front of the applicant.
                </div>
              </Card>
            )}

            <Card>
              <CardHeader
                title={`Version ${d.version} — sections`}
                description="A heading and the run of questions under it."
              />
              {!frozen && (
                <div className="flex flex-wrap items-end gap-3 p-5">
                  <div className="min-w-[240px] flex-1">
                    <Field label="Add a section">
                      <Input
                        value={sectionTitle}
                        onChange={setSectionTitle}
                        placeholder="About the child"
                      />
                    </Field>
                  </div>
                  <Button
                    onClick={() => addSection.mutate()}
                    disabled={!sectionTitle.trim() || addSection.isPending}
                  >
                    Add section
                  </Button>
                </div>
              )}
              <Table
                head={['Section', 'Questions', 'Order', '']}
                empty={d.sections.length === 0}
                emptyLabel="No sections yet. A form needs at least one heading."
              >
                {d.sections.map((s) => (
                  <tr key={s.id}>
                    <Td>{s.title}</Td>
                    <Td>{s.fields.length}</Td>
                    <Td>{s.sequence}</Td>
                    <Td>
                      {!frozen && (
                        <ConfirmButton
                          confirmLabel="Remove"
                          question="The questions in it go too."
                          tone="danger"
                          onConfirm={() => removeSection.mutate(s.id)}
                        >
                          Remove
                        </ConfirmButton>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>

            {d.sections.map((s) => (
              <Card key={s.id}>
                <CardHeader title={s.title} description={s.description} />
                <Table
                  head={['Question', 'Code', 'Type', 'Required', 'Rules', 'Shown when', '']}
                  empty={s.fields.length === 0}
                  emptyLabel="No questions in this section yet."
                >
                  {s.fields.map((f) => (
                    <tr key={f.id}>
                      <Td>
                        {f.label}
                        {f.help_text && (
                          <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                            {f.help_text}
                          </span>
                        )}
                      </Td>
                      <Td className="font-mono text-[12.5px]">
                        {f.code}
                        {f.reserved && (
                          <span className="ml-1.5">
                            <Badge tone="info">on the record</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>{labelOf(FIELD_TYPES, f.field_type)}</Td>
                      <Td>{f.is_required ? <Badge tone="warning">Required</Badge> : '—'}</Td>
                      <Td className="text-[12.5px] text-muted-foreground">{ruleSummary(f)}</Td>
                      <Td className="text-[12.5px] text-muted-foreground">
                        {f.visible_when
                          ? `${f.visible_when.field} = ${f.visible_when.equals}`
                          : 'Always'}
                      </Td>
                      <Td>
                        {!frozen && (
                          <ConfirmButton
                            confirmLabel="Remove"
                            question="This draft loses the question."
                            tone="danger"
                            onConfirm={() => removeField.mutate(f.id)}
                          >
                            Remove
                          </ConfirmButton>
                        )}
                      </Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            ))}

            {!frozen && d.sections.length > 0 && (
              <Card>
                <CardHeader
                  title="Add a question"
                  description="Everything set here is enforced by the server when an applicant submits, not only in the browser."
                />
                <div className="space-y-5 p-5">
                  <FormGrid>
                    <Field label="Section" required>
                      <Select
                        value={draft.section_id}
                        onChange={(v) => setDraft({ ...draft, section_id: v })}
                        options={d.sections.map((s) => ({ value: s.id, label: s.title }))}
                        placeholder="Choose a section…"
                      />
                    </Field>
                    <Field label="Question" required>
                      <Input
                        value={draft.label}
                        onChange={(v) => setDraft({ ...draft, label: v })}
                        placeholder="Mother's occupation"
                      />
                    </Field>
                    <Field
                      label="Code"
                      hint={
                        RESERVED_CODES.includes(draft.code)
                          ? 'This code writes straight onto the application record.'
                          : 'Left blank, made from the question. What exports and reports key on.'
                      }
                    >
                      <Input
                        value={draft.code}
                        onChange={(v) => setDraft({ ...draft, code: v })}
                        placeholder="mother_occupation"
                      />
                    </Field>
                    <Field label="Type" required>
                      <Select
                        value={draft.field_type}
                        onChange={(v) => setDraft({ ...draft, field_type: v as FieldType })}
                        options={FIELD_TYPES}
                      />
                    </Field>
                    <Field label="Help text" hint="What a parent cannot be expected to know." wide>
                      <Textarea
                        value={draft.help_text}
                        onChange={(v) => setDraft({ ...draft, help_text: v })}
                        rows={2}
                      />
                    </Field>

                    {draft.field_type === 'select' && (
                      <>
                        <Field
                          label="Options"
                          hint="One per line, as “value | Label”, or just the label."
                        >
                          <Textarea
                            value={draft.optionsText}
                            onChange={(v) => setDraft({ ...draft, optionsText: v })}
                            rows={3}
                          />
                        </Field>
                        <Field
                          label="…or draw from a school list"
                          hint="Uses a list your school already maintains, so the vocabulary lives in one place."
                        >
                          <Input
                            value={draft.option_kind}
                            onChange={(v) => setDraft({ ...draft, option_kind: v })}
                            placeholder="blood_group"
                          />
                        </Field>
                      </>
                    )}

                    {(draft.field_type === 'text' ||
                      draft.field_type === 'textarea' ||
                      draft.field_type === 'phone' ||
                      draft.field_type === 'email') && (
                      <>
                        <Field label="Shortest allowed" hint="Blank means no minimum.">
                          <Input
                            value={draft.min_length}
                            onChange={(v) => setDraft({ ...draft, min_length: v })}
                          />
                        </Field>
                        <Field label="Longest allowed" hint="Blank means the default cap.">
                          <Input
                            value={draft.max_length}
                            onChange={(v) => setDraft({ ...draft, max_length: v })}
                          />
                        </Field>
                        <Field label="Pattern">
                          <Select
                            value={draft.pattern}
                            onChange={(v) => setDraft({ ...draft, pattern: v })}
                            options={PATTERNS}
                          />
                        </Field>
                      </>
                    )}

                    {draft.field_type === 'number' && (
                      <>
                        <Field label="Smallest allowed" hint="Blank means no floor.">
                          <Input
                            value={draft.min_number}
                            onChange={(v) => setDraft({ ...draft, min_number: v })}
                          />
                        </Field>
                        <Field label="Largest allowed" hint="Blank means no ceiling.">
                          <Input
                            value={draft.max_number}
                            onChange={(v) => setDraft({ ...draft, max_number: v })}
                          />
                        </Field>
                      </>
                    )}

                    <Field
                      label="Show only when"
                      hint="The code of an earlier question. Leave blank to always show it."
                    >
                      <Select
                        value={draft.when_field}
                        onChange={(v) => setDraft({ ...draft, when_field: v })}
                        options={allCodes.map((c) => ({ value: c, label: c }))}
                        placeholder="Always shown"
                      />
                    </Field>
                    <Field label="…and its answer is">
                      <Input
                        value={draft.when_equals}
                        onChange={(v) => setDraft({ ...draft, when_equals: v })}
                        placeholder="yes"
                      />
                    </Field>
                  </FormGrid>

                  <Checkbox
                    checked={draft.is_required}
                    onChange={(v) => setDraft({ ...draft, is_required: v })}
                    label="Required"
                  />

                  <FormNotice error={saveField.error} />
                  <Button
                    onClick={() => saveField.mutate()}
                    disabled={!draft.section_id || !draft.label.trim() || saveField.isPending}
                  >
                    Add question
                  </Button>
                </div>
              </Card>
            )}

            {!frozen && (
              <Card>
                <CardHeader
                  title="Publish"
                  description="Publishing freezes this version and retires the one it replaces."
                />
                <div className="p-5">
                  <FormNotice error={publish.error} />
                  <Button
                    onClick={() => publish.mutate()}
                    disabled={publish.isPending || missing.length > 0 || allCodes.length === 0}
                  >
                    Publish version {d.version}
                  </Button>
                </div>
              </Card>
            )}
          </>
        )}
      </PageBody>
    </>
  )
}

function VersionsCard({
  form,
  versionID,
  onPick,
  versions,
  onTakeDraft,
  onSetOpen,
  busy,
}: {
  form?: AdmissionForm
  versionID: string
  onPick: (id: string) => void
  versions: ReturnType<typeof useFormVersions>
  onTakeDraft: () => void
  onSetOpen: (open: boolean) => void
  busy: boolean
}) {
  // A failed query is never rendered as "no versions yet": the two look
  // identical and only one of them is the school's fault.
  if (versions.isLoading) return <Loading />
  if (versions.error) return <ErrorState error={versions.error} />
  const items = versions.data?.items ?? []

  return (
    <Card>
      <CardHeader
        title={form?.name ?? 'Versions'}
        description={
          form
            ? `Applicants reach this at /apply/${form.slug}. ${
                form.is_open ? 'It is open now.' : 'It is closed.'
              }`
            : undefined
        }
        action={
          <>
            <Button variant="outline" onClick={onTakeDraft} disabled={busy}>
              Take a draft
            </Button>
            {form && (
              <Button
                variant={form.is_open ? 'outline' : 'primary'}
                onClick={() => onSetOpen(!form.is_open)}
                disabled={busy}
              >
                {form.is_open ? 'Close the form' : 'Open the form'}
              </Button>
            )}
          </>
        }
      />
      <Table
        head={['Version', 'Status', 'Questions', 'Applications', 'Published', '']}
        empty={items.length === 0}
        emptyLabel="No versions yet."
      >
        {items.map((v) => (
          <tr key={v.id} className={v.id === versionID ? 'bg-muted/40' : undefined}>
            <Td>v{v.version}</Td>
            <Td>
              {v.status === 'published' && <Badge tone="success">Live</Badge>}
              {v.status === 'draft' && <Badge tone="info">Draft</Badge>}
              {v.status === 'retired' && <Badge tone="neutral">Retired</Badge>}
            </Td>
            <Td>{v.fields}</Td>
            <Td>{v.applications}</Td>
            <Td>{v.published_at ?? '—'}</Td>
            <Td>
              <Button size="sm" variant="outline" onClick={() => onPick(v.id)}>
                {v.status === 'draft' ? 'Edit' : 'View'}
              </Button>
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function ruleSummary(f: FormField): string {
  const parts: string[] = []
  if (f.min_length != null || f.max_length != null) {
    parts.push(`${f.min_length ?? 0}–${f.max_length ?? '∞'} characters`)
  }
  if (f.min_number != null || f.max_number != null) {
    parts.push(`${f.min_number ?? '−∞'} to ${f.max_number ?? '∞'}`)
  }
  if (f.pattern) parts.push(labelOf(PATTERNS, f.pattern))
  if (f.option_kind) parts.push(`list: ${f.option_kind}`)
  else if (f.options.length) parts.push(`${f.options.length} options`)
  return parts.length ? parts.join(' · ') : '—'
}

/** "value | Label" per line, or just a label whose value is derived by the
 *  server. Blank lines are dropped rather than becoming an empty option. */
function parseOptions(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [a, b] = line.split('|').map((s) => s.trim())
      return b ? { value: a, label: b } : { value: a, label: a }
    })
}
