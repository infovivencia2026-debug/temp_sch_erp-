import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, ShieldCheck, Star, Landmark } from 'lucide-react'
import { api, type List, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Checkbox, Field, FormGrid, FormNotice, Input, Select,
  Textarea, Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import {
  bankingBase, bankingQueryKey, isValidIFSC, isValidAccountNumber,
  type StudentBankAccount,
} from './banking-lib'

/* The student bank account register.

   Where a scholarship credit lands and where a fee refund goes. Under the DPDP
   Act this is the most sensitive table in the finance module, and the screen is
   built around that rather than apologising for it afterwards:

     The list never receives the full account number. The server masks it in
     the SQL projection, so there is nothing in this page's memory, nothing in
     the network tab, and nothing in a screenshot.

     Revealing one is a separate request, needs the finance export permission,
     and writes an audit row naming the student and who looked. The button
     says so before it is pressed, because a control people do not know about
     does not change behaviour.

     Aadhaar seeding is recorded as what the family said, not as a fact. DBT
     refuses an unseeded account and the school finds out weeks later when the
     credit fails; a warning here is worth more than a column that pretends to
     know.

   One account per student is marked primary and that is the one a refund or a
   DBT run pays into. A student may hold several — a closed passbook, a
   parent's account, a new one at a different bank — and picking "whichever came
   first" is how money lands in a dead account. */

export default function StudentBankAccounts() {
  const can = useCan()
  const mayWrite = can('finance.payments.write')
  const mayReveal = can('finance.export')

  const [search, setSearch] = useState('')
  const [active, setActive] = useState('true')

  const q = useQuery({
    queryKey: [bankingQueryKey, 'student-accounts', search, active],
    queryFn: () =>
      api.get<List<StudentBankAccount>>(
        `${bankingBase}/student-accounts?active=${active}${
          search ? `&q=${encodeURIComponent(search)}` : ''
        }`,
      ),
  })

  if (q.isLoading) return <Loading label="Opening the register…" />
  if (q.error) return <ErrorState error={q.error} />

  const rows = q.data?.items ?? []
  const primary = rows.filter((a) => a.is_primary)
  const unverified = rows.filter((a) => !a.verified_at)
  const unseeded = rows.filter((a) => !a.is_aadhaar_seeded)

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Student bank accounts"
        description="Where a scholarship credit or a fee refund goes. Account numbers are masked; revealing one is recorded."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Accounts on file" value={rows.length} icon={Landmark} />
          <Stat
            label="Students with a primary account"
            value={primary.length}
            hint="The one a refund or DBT run pays into"
          />
          <Stat
            label="Not yet verified"
            value={unverified.length}
            icon={ShieldCheck}
            hint={unverified.length ? 'Nobody has checked these against a passbook' : 'All checked'}
          />
          <Stat
            label="Not Aadhaar-seeded"
            value={unseeded.length}
            hint={unseeded.length ? 'DBT will refuse these credits' : 'All seeded'}
          />
        </CellGrid>

        {!mayReveal && (
          <Card>
            <div className="p-5 text-[13px] text-muted-foreground">
              Account numbers are shown masked. Seeing one in full needs the finance export
              permission, and every reveal is written to the audit log.
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="The register"
            description="Masked. The last four digits are enough to check a row against a passbook."
            action={
              <span className="flex flex-wrap gap-2">
                <Input
                  value={search}
                  onChange={setSearch}
                  placeholder="Name or admission number"
                />
                <Select
                  value={active}
                  onChange={setActive}
                  options={[
                    { value: 'true', label: 'Active only' },
                    { value: '', label: 'All' },
                    { value: 'false', label: 'Closed only' },
                  ]}
                />
              </span>
            }
          />
          <Table
            head={['Student', 'Held by', 'Bank', 'Account', 'IFSC', 'DBT', 'Checked', '']}
            empty={rows.length === 0}
            emptyLabel="No accounts on file yet."
          >
            {rows.map((a) => (
              <AccountRow key={a.id} account={a} mayWrite={mayWrite} mayReveal={mayReveal} />
            ))}
          </Table>
        </Card>

        {mayWrite && <AddAccount />}
      </PageBody>
    </>
  )
}

// --- one row -----------------------------------------------------------------

function AccountRow({
  account, mayWrite, mayReveal,
}: { account: StudentBankAccount; mayWrite: boolean; mayReveal: boolean }) {
  const qc = useQueryClient()
  const [shown, setShown] = useState<string | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: [bankingQueryKey] })

  const reveal = useMutation({
    mutationFn: () =>
      api.get<{ account_number: string; audited: boolean }>(
        `${bankingBase}/student-accounts/${account.id}/reveal`,
      ),
    onSuccess: (r) => setShown(r.account_number),
  })
  const makePrimary = useMutation({
    mutationFn: () => api.post(`${bankingBase}/student-accounts/${account.id}/primary`, {}),
    onSuccess: invalidate,
  })
  const verify = useMutation({
    mutationFn: () => api.post(`${bankingBase}/student-accounts/${account.id}/verify`, {}),
    onSuccess: invalidate,
  })

  return (
    <>
      <tr>
        <Td className="font-medium">
          {account.student_name}
          <span className="block text-[12px] font-normal text-muted-foreground">
            {account.admission_no}
            {account.class_section ? ` · ${account.class_section}` : ''}
          </span>
        </Td>
        <Td>
          {account.account_holder_name}
          <span className="block text-[12px] capitalize text-muted-foreground">
            {account.relationship}
            {account.guardian_name ? ` · ${account.guardian_name}` : ''}
          </span>
        </Td>
        <Td className="text-muted-foreground">
          {account.bank_name}
          {account.branch && <span className="block text-[12px]">{account.branch}</span>}
        </Td>
        <Td className="font-mono text-[13px]">
          {shown ?? account.account_masked}
          {account.is_primary && (
            <Badge tone="primary">
              <Star className="h-3 w-3" /> primary
            </Badge>
          )}
        </Td>
        <Td className="font-mono text-[12px] text-muted-foreground">{account.ifsc}</Td>
        <Td>
          {account.is_aadhaar_seeded ? (
            <Badge tone="success">seeded</Badge>
          ) : (
            <Badge tone="warning">not seeded</Badge>
          )}
        </Td>
        <Td className="text-[13px] text-muted-foreground">
          {account.verified_at ? (
            <>
              {account.verified_at.slice(0, 10)}
              {account.verified_by && <span className="block text-[12px]">{account.verified_by}</span>}
            </>
          ) : (
            <span className="text-warning">not checked</span>
          )}
        </Td>
        <Td>
          <span className="flex flex-wrap gap-1.5">
            {mayReveal && !shown && (
              <ConfirmButton
                confirmLabel="Show it"
                question="This reveal is recorded against your name in the audit log."
                onConfirm={() => reveal.mutate()}
                disabled={reveal.isPending}
              >
                <Eye className="h-3.5 w-3.5" /> Reveal
              </ConfirmButton>
            )}
            {mayWrite && !account.is_primary && account.is_active && (
              <Button
                size="sm"
                variant="ghost"
                disabled={makePrimary.isPending}
                onClick={() => makePrimary.mutate()}
              >
                Make primary
              </Button>
            )}
            {mayWrite && !account.verified_at && (
              <Button
                size="sm"
                variant="ghost"
                disabled={verify.isPending}
                onClick={() => verify.mutate()}
              >
                Mark checked
              </Button>
            )}
          </span>
        </Td>
      </tr>
      {(reveal.error || makePrimary.error || verify.error || shown) && (
        <tr>
          <Td colSpan={8}>
            <FormNotice
              error={reveal.error ?? makePrimary.error ?? verify.error}
              ok={
                shown
                  ? 'Shown in full, and recorded in the audit log with your name and the time.'
                  : undefined
              }
            />
          </Td>
        </tr>
      )}
    </>
  )
}

// --- adding one --------------------------------------------------------------

function AddAccount() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [studentQuery, setStudentQuery] = useState('')
  const [studentId, setStudentId] = useState('')
  const [holder, setHolder] = useState('')
  const [relationship, setRelationship] = useState('self')
  const [guardianId, setGuardianId] = useState('')
  const [bankName, setBankName] = useState('')
  const [branch, setBranch] = useState('')
  const [account, setAccount] = useState('')
  const [ifsc, setIfsc] = useState('')
  const [seeded, setSeeded] = useState(false)
  const [primary, setPrimary] = useState(true)
  const [notes, setNotes] = useState('')

  const students = useQuery({
    queryKey: ['students', 'picker', studentQuery],
    queryFn: () =>
      api.get<Page<Student>>(
        `/api/v1/students?limit=20${studentQuery ? `&q=${encodeURIComponent(studentQuery)}` : ''}`,
      ),
    enabled: open && studentQuery.length > 1,
  })

  const guardians = useQuery({
    queryKey: ['students', 'guardians', studentId],
    queryFn: () =>
      api.get<{ guardians?: { id: string; full_name: string; relation: string }[] }>(
        `/api/v1/students/${studentId}/profile`,
      ),
    enabled: open && !!studentId && relationship !== 'self',
  })

  const save = useMutation({
    mutationFn: () =>
      api.post(`${bankingBase}/student-accounts`, {
        student_id: studentId,
        guardian_id: relationship === 'self' ? '' : guardianId,
        account_holder_name: holder,
        relationship,
        bank_name: bankName,
        branch,
        account_number: account,
        ifsc,
        is_aadhaar_seeded: seeded,
        make_primary: primary,
        notes,
      }),
    onSuccess: () => {
      setHolder(''); setAccount(''); setIfsc(''); setNotes('')
      qc.invalidateQueries({ queryKey: [bankingQueryKey] })
    },
  })

  const ifscBad = ifsc !== '' && !isValidIFSC(ifsc)
  const accountBad = account !== '' && !isValidAccountNumber(account)
  const needsGuardian = relationship !== 'self' && !guardianId

  return (
    <Card>
      <CardHeader
        title="Add an account"
        description="Check it against a passbook or a cancelled cheque before saving. A wrong digit is a scholarship paid to a stranger, and it is not recoverable."
        action={
          <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Add an account'}
          </Button>
        }
      />
      {open && (
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Find the student" required>
              <Input
                value={studentQuery}
                onChange={(v) => { setStudentQuery(v); setStudentId('') }}
                placeholder="Name or admission number"
              />
            </Field>
            <Field label="Student" required>
              <Select
                value={studentId}
                onChange={setStudentId}
                placeholder={
                  studentQuery.length > 1 ? 'Choose the student' : 'Type a name above first'
                }
                options={(students.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: `${s.full_name} · ${s.admission_no}${
                    s.class_name ? ` · ${s.class_name}` : ''
                  }`,
                }))}
              />
            </Field>

            <Field
              label="Whose account is it?"
              required
              hint="A minor's scholarship is very often credited to a parent's account. Say so here — the name on the transfer has to match."
            >
              <Select
                value={relationship}
                onChange={(v) => { setRelationship(v); if (v === 'self') setGuardianId('') }}
                options={[
                  { value: 'self', label: "The student's own" },
                  { value: 'father', label: "Father's" },
                  { value: 'mother', label: "Mother's" },
                  { value: 'guardian', label: "Guardian's" },
                  { value: 'other', label: 'Someone else' },
                ]}
              />
            </Field>
            {relationship !== 'self' && (
              <Field label="Which guardian" required>
                <Select
                  value={guardianId}
                  onChange={setGuardianId}
                  placeholder={studentId ? 'Choose a guardian' : 'Choose a student first'}
                  options={(guardians.data?.guardians ?? []).map((g) => ({
                    value: g.id,
                    label: `${g.full_name} (${g.relation})`,
                  }))}
                />
              </Field>
            )}

            <Field label="Name on the account" required hint="Exactly as the passbook prints it">
              <Input value={holder} onChange={setHolder} placeholder="Lakshmi Devi" />
            </Field>
            <Field label="Bank" required>
              <Input value={bankName} onChange={setBankName} placeholder="State Bank of India" />
            </Field>
            <Field label="Branch">
              <Input value={branch} onChange={setBranch} placeholder="Kukatpally" />
            </Field>
            <Field
              label="Account number"
              required
              hint={accountBad ? '6 to 20 letters or digits, with no spaces' : undefined}
            >
              <Input
                value={account}
                onChange={setAccount}
                placeholder="50100234567890"
                className={accountBad ? 'border-destructive' : undefined}
              />
            </Field>
            <Field
              label="IFSC"
              required
              hint={
                ifscBad
                  ? 'Eleven characters: four letters, a zero, then six more'
                  : 'Printed in the passbook and on the cheque leaf'
              }
            >
              <Input
                value={ifsc}
                onChange={(v) => setIfsc(v.toUpperCase())}
                placeholder="SBIN0001234"
                className={ifscBad ? 'border-destructive' : undefined}
              />
            </Field>

            <Field label="Notes" wide>
              <Textarea
                value={notes}
                onChange={setNotes}
                rows={2}
                placeholder="Passbook copy on file, collected 12/04/2026"
              />
            </Field>
          </FormGrid>

          <div className="flex flex-wrap gap-6">
            <Checkbox
              checked={seeded}
              onChange={setSeeded}
              label="Aadhaar-seeded"
              hint="What the family told you. DBT refuses an unseeded account, and this is the warning before the credit fails."
            />
            <Checkbox
              checked={primary}
              onChange={setPrimary}
              label="Make this the primary account"
              hint="The one a refund or a DBT run pays into. Only one per student."
            />
          </div>

          <FormNotice error={save.error} ok={save.isSuccess ? 'Account added.' : undefined} />
          <Button
            disabled={
              !studentId || !holder || !bankName || !account || !ifsc ||
              accountBad || ifscBad || needsGuardian || save.isPending
            }
            onClick={() => save.mutate()}
          >
            Add the account
          </Button>
        </div>
      )}
    </Card>
  )
}
