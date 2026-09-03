import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, FileWarning, Printer, Stamp } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Checkbox, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* What a transfer certificate looks like when it comes off the printer.

   The certificate register already existed and already carried a template
   nobody had a screen for. What was missing is everything a school actually
   asks about one: whether it is still in use, whose signature goes at the
   bottom, what the serial should read, and — the point of the preview — what
   it looks like filled in with a real child's details.

   The preview is text, not rendered markup. A template is arbitrary HTML typed
   by a clerk, and injecting it into the principal's own page would turn the
   template editor into a way to run script in their session. */

interface Template {
  id: string
  code: string
  name: string
  subject_kind: 'student' | 'staff'
  is_active: boolean
  requires_approval: boolean
  description?: string
  template_html?: string
  page_size: string
  orientation: string
  serial_prefix?: string
  signatory?: string
  signatory_role?: string
  issued: number
  pending: number
  last_issued_on?: string
  needs_body: boolean
}

interface Placeholder {
  token: string
  means: string
}

const BLANK = {
  code: '',
  name: '',
  subject_kind: 'student',
  description: '',
  template_html: '',
  page_size: 'A4',
  orientation: 'portrait',
  serial_prefix: '',
  signatory: '',
  signatory_role: '',
  is_active: true,
  requires_approval: true,
}

export default function CertificateTemplates() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<typeof BLANK & { id?: string }>(BLANK)
  const [previewOf, setPreviewOf] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['certificate-templates'],
    queryFn: () =>
      api.get<{
        items: Template[]
        placeholders: Placeholder[]
        summary: { templates: number; unconfigured: number }
      }>('/api/v1/academics/admin/certificate-templates'),
  })

  const save = useMutation({
    mutationFn: () => api.post('/api/v1/academics/admin/certificate-templates', editing),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['certificate-templates'] })
      setEditing(BLANK)
    },
  })

  if (list.isLoading) return <SkeletonTable columns={8} label="Reading the certificate register…" />
  if (list.error) return <ErrorState error={list.error} />

  const rows = list.data?.items ?? []
  const placeholders = list.data?.placeholders ?? []
  const s = list.data?.summary
  const issued = rows.reduce((n, t) => n + t.issued, 0)
  const pending = rows.reduce((n, t) => n + t.pending, 0)

  const edit = (t: Template) =>
    setEditing({
      id: t.id,
      code: t.code,
      name: t.name,
      subject_kind: t.subject_kind,
      description: t.description ?? '',
      template_html: t.template_html ?? '',
      page_size: t.page_size,
      orientation: t.orientation,
      serial_prefix: t.serial_prefix ?? '',
      signatory: t.signatory ?? '',
      signatory_role: t.signatory_role ?? '',
      is_active: t.is_active,
      requires_approval: t.requires_approval,
    })

  return (
    <>
      <PageHead
        eyebrow="Students"
        title="Certificate and document templates"
        description="The wording, the signatory and the serial for every certificate this school issues."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Templates" value={s?.templates ?? 0} icon={FileText} />
          <Stat
            label="Nothing written yet"
            value={s?.unconfigured ?? 0}
            icon={FileWarning}
            delta={
              (s?.unconfigured ?? 0) > 0
                ? { value: 'These would print a blank page', positive: false }
                : { value: 'Every active template has a body', positive: true }
            }
          />
          <Stat label="Issued" value={issued} icon={Stamp} />
          <Stat label="Awaiting approval" value={pending} icon={Printer} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Templates"
            description="Retired rather than deleted: certificates already issued still point at their type."
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No templates yet"
              body="Add a transfer certificate below; the counter can then issue one."
            />
          ) : (
            <Table
              head={['Code', 'Name', 'For', 'Signatory', 'Issued', 'Last issued', 'State', '']}
            >
              {rows.map((t) => (
                <tr key={t.id}>
                  <Td className="font-medium">{t.code}</Td>
                  <Td>
                    {t.name}
                    {t.description && (
                      <span className="block text-[12px] text-muted-foreground">
                        {t.description}
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{t.subject_kind}</Td>
                  <Td className="text-muted-foreground">
                    {t.signatory ? `${t.signatory}${t.signatory_role ? `, ${t.signatory_role}` : ''}` : '—'}
                  </Td>
                  <Td className="tabular-nums">
                    {t.issued || '—'}
                    {t.pending > 0 && (
                      <span className="block text-[12px] text-warning">
                        {t.pending} waiting
                      </span>
                    )}
                  </Td>
                  <Td>{t.last_issued_on ? formatDate(t.last_issued_on) : '—'}</Td>
                  <Td>
                    {!t.is_active ? (
                      <Badge tone="neutral">retired</Badge>
                    ) : t.needs_body ? (
                      <Badge tone="danger">no wording</Badge>
                    ) : (
                      <Badge tone="success">ready</Badge>
                    )}
                  </Td>
                  <Td>
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => edit(t)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setPreviewOf(previewOf === t.id ? null : t.id)}
                      >
                        Preview
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {previewOf && <Preview templateID={previewOf} />}

        <Card>
          <CardHeader
            title={editing.id ? `Editing ${editing.code}` : 'New template'}
            description="Type the wording as it should print. The tokens below are replaced with the child’s own details."
            action={
              editing.id ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(BLANK)}>
                  Start a new one
                </Button>
              ) : undefined
            }
          />
          <div className="px-5 pb-5">
            <FormGrid>
              <Field label="Code" required hint="Short and permanent — TC, BONAFIDE, CONDUCT.">
                <Input
                  value={editing.code}
                  onChange={(v) => setEditing((e) => ({ ...e, code: v }))}
                  placeholder="TC"
                />
              </Field>
              <Field label="Name" required>
                <Input
                  value={editing.name}
                  onChange={(v) => setEditing((e) => ({ ...e, name: v }))}
                  placeholder="Transfer Certificate"
                />
              </Field>
              <Field label="For">
                <Select
                  value={editing.subject_kind}
                  onChange={(v) => setEditing((e) => ({ ...e, subject_kind: v }))}
                  options={[
                    { value: 'student', label: 'Students' },
                    { value: 'staff', label: 'Staff' },
                  ]}
                />
              </Field>
              <Field label="Serial prefix" hint="What the office writes on the counterfoil.">
                <Input
                  value={editing.serial_prefix}
                  onChange={(v) => setEditing((e) => ({ ...e, serial_prefix: v }))}
                  placeholder="TC/2026/"
                />
              </Field>
              <Field label="Signatory">
                <Input
                  value={editing.signatory}
                  onChange={(v) => setEditing((e) => ({ ...e, signatory: v }))}
                  placeholder="K. Rao"
                />
              </Field>
              <Field label="Designation">
                <Input
                  value={editing.signatory_role}
                  onChange={(v) => setEditing((e) => ({ ...e, signatory_role: v }))}
                  placeholder="Principal"
                />
              </Field>
              <Field label="Paper">
                <Select
                  value={editing.page_size}
                  onChange={(v) => setEditing((e) => ({ ...e, page_size: v }))}
                  options={['A4', 'A5', 'Letter', 'Legal'].map((v) => ({ value: v, label: v }))}
                />
              </Field>
              <Field label="Orientation">
                <Select
                  value={editing.orientation}
                  onChange={(v) => setEditing((e) => ({ ...e, orientation: v }))}
                  options={[
                    { value: 'portrait', label: 'Portrait' },
                    { value: 'landscape', label: 'Landscape' },
                  ]}
                />
              </Field>
              <Field label="Note" wide>
                <Input
                  value={editing.description}
                  onChange={(v) => setEditing((e) => ({ ...e, description: v }))}
                  placeholder="The leaving certificate the next school asks for"
                />
              </Field>
              <Field label="Wording" wide>
                <Textarea
                  value={editing.template_html}
                  onChange={(v) => setEditing((e) => ({ ...e, template_html: v }))}
                  rows={8}
                  placeholder="This is to certify that {{student_name}} (Admission {{admission_no}}) of {{class}}-{{section}} …"
                />
              </Field>
            </FormGrid>

            <div className="mt-4 rounded-md border bg-muted/40 px-3 py-2">
              <p className="text-[12.5px] font-medium text-secondary-foreground">
                Tokens you may use
              </p>
              <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
                {placeholders.map((p) => (
                  <span key={p.token}>
                    <code className="text-secondary-foreground">{p.token}</code> — {p.means}
                  </span>
                ))}
              </p>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-4">
              <Checkbox
                checked={editing.is_active}
                onChange={(v) => setEditing((e) => ({ ...e, is_active: v }))}
                label="In use"
                hint="Retire rather than delete; issued certificates still point here."
              />
              <Checkbox
                checked={editing.requires_approval}
                onChange={(v) => setEditing((e) => ({ ...e, requires_approval: v }))}
                label="Needs approval before issue"
              />
              <Button
                disabled={save.isPending || !editing.name.trim() || (!editing.id && !editing.code.trim())}
                onClick={() => save.mutate()}
              >
                {editing.id ? 'Save template' : 'Add template'}
              </Button>
              <FormNotice error={save.error} />
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  )
}

/** Rendered against a real child, so the school sees the gaps before the
    parent does. */
function Preview({ templateID }: { templateID: string }) {
  const preview = useQuery({
    queryKey: ['certificate-preview', templateID],
    queryFn: () =>
      api.get<{
        template: string
        rendered: string
        empty: boolean
        unfilled: string[]
        issued_on: string
      }>(`/api/v1/academics/admin/certificate-templates/${templateID}/preview`),
  })

  if (preview.isLoading) return <Loading label="Filling the template in…" />
  if (preview.error) return <ErrorState error={preview.error} />

  const p = preview.data!

  return (
    <Card>
      <CardHeader
        title={`Preview — ${p.template}`}
        description="Filled in with the first child on the roll. Shown as text: a template is arbitrary markup typed by a clerk."
      />
      <div className="px-5 pb-5">
        {p.empty ? (
          <EmptyState
            title="Nothing written yet"
            body="This template would print a blank page. Type the wording below."
          />
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-4 text-[13px] leading-relaxed">
            {p.rendered}
          </pre>
        )}
        {p.unfilled.length > 0 && (
          <p className="mt-3 text-[13px] text-warning">
            Nothing on record for {p.unfilled.join(', ')} — these print blank.
          </p>
        )}
      </div>
    </Card>
  )
}
