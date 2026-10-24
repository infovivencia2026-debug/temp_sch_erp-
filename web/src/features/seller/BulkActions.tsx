import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Button, Dialog, Field, FormGrid, FormNotice, Input, Select, Table, Td, Textarea } from '@/components/ui'
import { useToast } from '@/components/Toast'
import { buzz } from '@/lib/haptics'

/* BULK ACTIONS over the schools ticked on Schools (POST /seller/bulk).

   Three actions: change the plan, send the renewal reminder, show an
   announcement. "Preview" asks the server what would change, school by
   school, and changes nothing; only then is "Apply" offered, for exactly
   what was previewed. Each school changed gets its own line in the seller
   audit, which that school reads under Security, Vendor activity. */

type Action = 'plan' | 'reminder' | 'announcement'
interface Row { id: string; name: string; change: string; skipped?: string; done?: boolean; error?: string }
interface Result { applied: boolean; schools: Row[] }

const ACTIONS: { value: Action; label: string }[] = [
  { value: 'plan', label: 'Change the plan' },
  { value: 'reminder', label: 'Send the renewal reminder' },
  { value: 'announcement', label: 'Show an announcement' },
]

export function BulkActions({ ids, plans, onClose }: { ids: string[]; plans: { code: string; name: string }[]; onClose: (changed: boolean) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [action, setAction] = useState<Action>('plan')
  const [plan, setPlan] = useState(plans[0]?.code ?? '')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState<Result | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const payload = (dry: boolean) => ({ action, institution_ids: ids, dry_run: dry, plan_code: plan, title, body })
  const run = useMutation({
    mutationFn: (dry: boolean) => api.post<Result>('/api/v1/seller/bulk', payload(dry)),
    onSuccess: (r) => {
      if (!r.applied) { setPreview(r); return }
      setResult(r)
      buzz('tap')
      void qc.invalidateQueries({ queryKey: ['seller-tenants'] })
      toast.ok(`${r.schools.filter((s) => s.done).length} of ${r.schools.length} schools done`)
    },
  })
  const reset = () => { setPreview(null); setResult(null) }
  const ready = action === 'plan' ? !!plan : action === 'announcement' ? title.trim() !== '' : true
  const shown = result ?? preview
  const willChange = preview?.schools.filter((s) => !s.skipped && !s.error).length ?? 0

  return (
    <Dialog
      onClose={() => onClose(!!result)}
      size="lg"
      title={`${ids.length} ${ids.length === 1 ? 'school' : 'schools'} chosen`}
      description="Preview shows what would change in each school. Nothing changes until you apply it."
      footer={
        result ? <Button onClick={() => onClose(true)}>Done</Button> : (
          <>
            <Button variant="ghost" onClick={() => onClose(false)}>Cancel</Button>
            {preview ? (
              <Button needsNetwork disabled={willChange === 0} pending={run.isPending} onClick={() => run.mutate(false)}>
                Apply to {willChange} {willChange === 1 ? 'school' : 'schools'}
              </Button>
            ) : (
              <Button variant="secondary" disabled={!ready} pending={run.isPending} onClick={() => run.mutate(true)}>Preview</Button>
            )}
          </>
        )
      }
    >
      {!result && (
        <FormGrid>
          <Field label="Action" wide>
            <Select value={action} onChange={(v) => { setAction(v as Action); reset() }} options={ACTIONS} />
          </Field>
          {action === 'plan' && (
            <Field label="New plan" wide>
              <Select value={plan} onChange={(v) => { setPlan(v); reset() }} options={plans.map((p) => ({ value: p.code, label: p.name }))} />
            </Field>
          )}
          {action === 'announcement' && (
            <>
              <Field label="Title" required wide><Input value={title} onChange={(v) => { setTitle(v); reset() }} /></Field>
              <Field label="Detail" wide><Textarea value={body} onChange={(v) => { setBody(v); reset() }} rows={3} /></Field>
            </>
          )}
        </FormGrid>
      )}
      {action === 'reminder' && !shown && (
        <p className="mt-3 text-[13px] text-muted-foreground">Emails each school's administrator its renewal date and any balance owed.</p>
      )}
      {shown && (
        <div className="mt-4">
          <Table head={['School', result ? 'Result' : 'What changes']}>
            {shown.schools.map((s) => (
              <tr key={s.id}>
                <Td className="font-medium">{s.name || s.id}</Td>
                <Td>
                  {s.error ? <Badge tone="danger">{s.error}</Badge>
                    : s.skipped ? <span className="text-muted-foreground">Skipped: {s.skipped}</span>
                      : <span>{s.change}{s.done && <Badge tone="success" className="ml-2">Done</Badge>}</span>}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      <FormNotice error={run.error} />
    </Dialog>
  )
}
