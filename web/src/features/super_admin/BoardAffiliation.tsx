import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Input, Select, Field, FormGrid, FormNotice,
  Loading, ErrorState,
} from '@/components/ui'
import {
  usePlatform, usePlatformSave, usePlatformDelete, type Affiliation,
} from './platform-lib'

/**
 * Affiliation, and the certificates a school is required to publish.
 *
 * The school profile screen already edits the board and the affiliation
 * number. What no screen could record is the date the affiliation lapses, or
 * any of the eight-odd certificates the mandatory public disclosure rule wants
 * on the school's website — each with its own issuing authority and its own
 * expiry.
 *
 * The screen leads with days-to-renewal rather than with a form, because that
 * is the number the correspondent is chasing and it was previously kept in a
 * diary.
 */
export default function BoardAffiliation() {
  const { data, isLoading, error } = usePlatform<Affiliation>('affiliation', '/board-affiliation')
  const saveHeader = usePlatformSave('affiliation', '/board-affiliation')
  const saveDoc = usePlatformSave('affiliation', '/board-affiliation/documents', 'post')
  const removeDoc = usePlatformDelete('affiliation')

  const [board, setBoard] = useState<string | null>(null)
  const [number, setNumber] = useState<string | null>(null)
  const [validTo, setValidTo] = useState<string | null>(null)

  const [doc, setDoc] = useState('')
  const [title, setTitle] = useState('')
  const [ref, setRef] = useState('')
  const [authority, setAuthority] = useState('')
  const [issued, setIssued] = useState('')
  const [expires, setExpires] = useState('')
  const [url, setUrl] = useState('')

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  // Uncontrolled until the operator types: the server's value is the initial
  // one, and tracking "has this field been edited" separately is what keeps a
  // refetch from wiping half-typed input.
  const boardValue = board ?? data.affiliation_board ?? ''
  const numberValue = number ?? data.affiliation_no ?? ''
  const validValue = validTo ?? data.affiliation_valid_to ?? ''

  const renewal = data.days_to_renewal

  const kindLabel = (v: string) =>
    data.document_kinds.find((k) => k.value === v)?.label ?? v

  return (
    <>
      <PageHead
        eyebrow="Statutory & Boards"
        title="Board affiliation & disclosure"
        description="Affiliation numbers, renewal dates and the documents the board requires a school to publish."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Affiliation lapses in"
            value={
              renewal == null ? (
                'Not recorded'
              ) : renewal < 0 ? (
                <Badge tone="danger">Lapsed {-renewal} days ago</Badge>
              ) : renewal <= 180 ? (
                <Badge tone="warning">{renewal} days</Badge>
              ) : (
                `${renewal} days`
              )
            }
            hint={data.affiliation_valid_to ?? 'Set a validity date below'}
          />
          <Stat label="Documents recorded" value={data.recorded} />
          <Stat label="Expiring within 90 days" value={data.expiring_90_days} />
          <Stat label="Expired" value={data.expired} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Affiliation"
            description="The registration the board issues, and the date it has to be renewed by"
            action={
              <Button
                disabled={saveHeader.isPending}
                onClick={() =>
                  saveHeader.mutate({
                    affiliation_board: boardValue,
                    affiliation_no: numberValue,
                    affiliation_valid_to: validValue,
                  })
                }
              >
                Save
              </Button>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Board">
                <Select
                  value={boardValue}
                  onChange={setBoard}
                  options={data.boards}
                  placeholder="Select a board"
                />
              </Field>
              <Field label="Affiliation / recognition number">
                <Input value={numberValue} onChange={setNumber} placeholder="e.g. 130xxxx" />
              </Field>
              <Field
                label="Valid to"
                hint="The renewal application usually has to be filed several months before this date."
              >
                <Input type="date" value={validValue} onChange={setValidTo} />
              </Field>
              <Field label="UDISE code" hint="Set on the school profile; shown here for reference.">
                <Input value={data.udise_code ?? '—'} onChange={() => {}} />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice
                error={saveHeader.error}
                ok={saveHeader.isSuccess ? 'Affiliation saved.' : undefined}
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Public disclosure documents"
            description="Each certificate the school must publish, with the authority that issued it and the date it expires"
          />
          <Table
            head={['Document', 'Reference', 'Authority', 'Issued', 'Expires', 'Published at', '']}
            empty={!data.documents.length}
            emptyLabel="Nothing recorded yet. Add the affiliation certificate first — it is the one an inspector asks for."
          >
            {data.documents.map((d) => {
              const days = d.days_to_expiry
              return (
                <tr key={d.id}>
                  <Td className="font-medium">
                    {d.title}
                    <span className="block text-[12px] text-muted-foreground">
                      {kindLabel(d.document)}
                      {d.campus ? ` · ${d.campus}` : ''}
                    </span>
                  </Td>
                  <Td>{d.reference_no ?? '—'}</Td>
                  <Td>{d.issuing_authority ?? '—'}</Td>
                  <Td>{d.issued_on ?? '—'}</Td>
                  <Td>
                    {days == null ? (
                      <Badge tone="neutral">Does not expire</Badge>
                    ) : days < 0 ? (
                      <Badge tone="danger">Expired {-days} days ago</Badge>
                    ) : days <= 90 ? (
                      <Badge tone="warning">{days} days</Badge>
                    ) : (
                      <Badge tone="success">{d.valid_to}</Badge>
                    )}
                  </Td>
                  <Td>{d.public_url ? 'Yes' : <span className="text-muted-foreground">Not published</span>}</Td>
                  <Td>
                    <ConfirmButton
                      confirmLabel="Remove"
                      question="Remove this document?"
                      tone="danger"
                      onConfirm={() => removeDoc.mutate(`/board-affiliation/documents/${d.id}`)}
                    >
                      Remove
                    </ConfirmButton>
                  </Td>
                </tr>
              )
            })}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Record a document"
            description="Saving the same document again replaces the entry rather than adding a second one"
            action={
              <Button
                disabled={saveDoc.isPending || !doc || !title}
                onClick={() =>
                  saveDoc.mutate(
                    {
                      document: doc,
                      title,
                      reference_no: ref,
                      issuing_authority: authority,
                      issued_on: issued,
                      valid_to: expires,
                      public_url: url,
                    },
                    {
                      onSuccess: () => {
                        setDoc('')
                        setTitle('')
                        setRef('')
                        setAuthority('')
                        setIssued('')
                        setExpires('')
                        setUrl('')
                      },
                    },
                  )
                }
              >
                Add document
              </Button>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Document" required>
                <Select
                  value={doc}
                  onChange={(v) => {
                    setDoc(v)
                    if (!title) setTitle(kindLabel(v))
                  }}
                  options={data.document_kinds}
                  placeholder="Select a document"
                />
              </Field>
              <Field label="Title as published" required>
                <Input value={title} onChange={setTitle} />
              </Field>
              <Field label="Reference number">
                <Input value={ref} onChange={setRef} />
              </Field>
              <Field label="Issuing authority">
                <Input value={authority} onChange={setAuthority} placeholder="e.g. TS Fire Services" />
              </Field>
              <Field label="Issued on">
                <Input type="date" value={issued} onChange={setIssued} />
              </Field>
              <Field label="Valid to" hint="Leave blank for a document that does not expire, such as a trust deed.">
                <Input type="date" value={expires} onChange={setExpires} />
              </Field>
              <Field label="Published at" wide hint="The page on the school's website where this document is shown.">
                <Input value={url} onChange={setUrl} placeholder="https://" />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice error={saveDoc.error} />
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
