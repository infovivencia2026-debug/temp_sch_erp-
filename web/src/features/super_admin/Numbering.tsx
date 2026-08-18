import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button,
  ConfirmButton, Input, Select, Checkbox, Textarea, Field, FormGrid,
  FormNotice, Loading, ErrorState,
} from '@/components/ui'
import {
  usePlatform, usePlatformSave, usePlatformDelete, type NumberingResponse,
} from './platform-lib'

/**
 * The series every document is issued from, and the templates they print into.
 *
 * The preview beside each series is the point of the screen. A cashier issues
 * four hundred receipts against a prefix, and the only moment anybody sees what
 * that prefix actually produces is on the first one — by which time the series
 * has started and cannot be restarted.
 *
 * The counter may be moved forward and never back. A receipt number reissued
 * is a receipt number in two families' hands, and that is the hardest thing in
 * this product to explain to an auditor.
 */
export default function Numbering() {
  const { data, isLoading, error } = usePlatform<NumberingResponse>('numbering', '/numbering')
  const saveScheme = usePlatformSave('numbering', '/numbering', 'post')
  const saveTemplate = usePlatformSave('numbering', '/templates', 'post')
  const remove = usePlatformDelete('numbering')

  const [kind, setKind] = useState('')
  const [campus, setCampus] = useState('')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [padding, setPadding] = useState('5')
  const [next, setNext] = useState('1')
  const [yearly, setYearly] = useState(true)

  const [tCode, setTCode] = useState('')
  const [tName, setTName] = useState('')
  const [tHtml, setTHtml] = useState('')
  const [tApproval, setTApproval] = useState(false)

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const kindLabel = (v: string) => data.kinds.find((k) => k.value === v)?.label ?? v

  // Shown live, without asking the server, so the consequence of a prefix is
  // visible while it is being typed rather than after it is saved.
  const preview = (() => {
    const n = String(Math.max(1, Number(next) || 1)).padStart(Math.max(1, Number(padding) || 1), '0')
    return yearly ? `${prefix}${data.financial_year}/${n}${suffix}` : `${prefix}${n}${suffix}`
  })()

  return (
    <>
      <PageHead
        eyebrow="Platform Configuration"
        title="Numbering & templates"
        description="Receipt, admission, student ID and certificate series, and the documents they print into."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Series"
            description={`Yearly series reset with the financial year, currently ${data.financial_year}`}
          />
          <Table
            head={['Document', 'Applies to', 'Next number will be', 'Counter', 'Resets yearly', '']}
            empty={!data.items.length}
            emptyLabel="No series configured. Receipts and invoices create their own on first use; everything else is issued by hand until it is set up here."
          >
            {data.items.map((s) => (
              <tr key={s.id}>
                <Td className="font-medium">{kindLabel(s.kind)}</Td>
                <Td>{s.campus ?? 'The whole school'}</Td>
                <Td className="font-mono text-[12.5px]">{s.preview}</Td>
                <Td>{s.next_value}</Td>
                <Td>{s.reset_yearly ? <Badge tone="info">Yes</Badge> : 'No'}</Td>
                <Td>
                  <ConfirmButton
                    confirmLabel="Remove"
                    question="Remove this series? The next document reverts to the default."
                    tone="danger"
                    onConfirm={() => remove.mutate(`/numbering/${s.id}`)}
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
            title="Add or amend a series"
            description="Saving an existing document and campus pair amends it"
            action={
              <Button
                disabled={saveScheme.isPending || !kind}
                onClick={() =>
                  saveScheme.mutate({
                    kind,
                    campus_id: campus,
                    prefix,
                    suffix,
                    padding: Number(padding) || 5,
                    next_value: Number(next) || 1,
                    reset_yearly: yearly,
                  })
                }
              >
                Save series
              </Button>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Document" required>
                <Select value={kind} onChange={setKind} options={data.kinds} placeholder="Select a document" />
              </Field>
              <Field label="Applies to">
                <Select
                  value={campus}
                  onChange={setCampus}
                  options={[{ value: '', label: 'The whole school' }, ...data.campuses]}
                />
              </Field>
              <Field label="Prefix">
                <Input value={prefix} onChange={setPrefix} placeholder="e.g. RCPT/" />
              </Field>
              <Field label="Suffix">
                <Input value={suffix} onChange={setSuffix} />
              </Field>
              <Field label="Digits" hint="Zero-padded, so 5 gives 00042.">
                <Input value={padding} onChange={setPadding} />
              </Field>
              <Field
                label="Next number"
                hint="May be moved forward, never back. A number already printed must never be issued twice."
              >
                <Input value={next} onChange={setNext} />
              </Field>
              <Field label="Yearly reset" wide>
                <Checkbox
                  checked={yearly}
                  onChange={setYearly}
                  label="Restart the counter each financial year"
                  hint="The year is inserted into the number, so last year's serials stay distinct."
                />
              </Field>
            </FormGrid>
            <p className="mt-4 text-[13px] text-muted-foreground">
              The next document would be called{' '}
              <span className="font-mono text-foreground">{preview}</span>
            </p>
            <div className="mt-4">
              <FormNotice error={saveScheme.error} ok={saveScheme.isSuccess ? 'Series saved.' : undefined} />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Certificate templates" description="What a bonafide, a transfer certificate or a study certificate prints" />
          <Table
            head={['Code', 'Certificate', 'Template', 'Needs approval']}
            empty={!data.templates.length}
            emptyLabel="No certificate types defined, so every certificate is written by hand."
          >
            {data.templates.map((t) => (
              <tr key={t.id}>
                <Td className="font-mono text-[12.5px]">{t.code}</Td>
                <Td className="font-medium">{t.name}</Td>
                <Td>
                  {t.has_template ? (
                    <Badge tone="success">{t.template_length} characters</Badge>
                  ) : (
                    <Badge tone="warning">Empty</Badge>
                  )}
                </Td>
                <Td>{t.requires_approval ? 'Yes' : 'No'}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Add or amend a template"
            action={
              <Button
                disabled={saveTemplate.isPending || !tCode || !tName}
                onClick={() =>
                  saveTemplate.mutate(
                    { code: tCode, name: tName, template_html: tHtml, requires_approval: tApproval },
                    {
                      onSuccess: () => {
                        setTCode('')
                        setTName('')
                        setTHtml('')
                        setTApproval(false)
                      },
                    },
                  )
                }
              >
                Save template
              </Button>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Code" required>
                <Input value={tCode} onChange={setTCode} placeholder="e.g. bonafide" />
              </Field>
              <Field label="Name" required>
                <Input value={tName} onChange={setTName} placeholder="Bonafide certificate" />
              </Field>
              <Field label="Template" wide hint="HTML. The school's letterhead comes from the branding profile, so it does not belong here.">
                <Textarea value={tHtml} onChange={setTHtml} rows={6} />
              </Field>
              <Field label="Approval">
                <Checkbox
                  checked={tApproval}
                  onChange={setTApproval}
                  label="A certificate of this type needs approval before it is issued"
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice error={saveTemplate.error} />
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
