import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Button, Field, FormGrid, FormNotice, Input,
} from '@/components/ui'
import BulkImport from '@/components/BulkImport'
import RoleSelect from '@/components/RoleSelect'

/* Appointing somebody, from the HR account.
 *
 * The HR role has held hr.employees.write since the role set was written, and
 * every screen it could reach was read-only. The only form that appoints
 * anybody lives in the setup wizard, and the wizard is registered to the
 * principal and the platform operator — so an HR manager could be given the
 * permission, sign in, and find no way to use it. The permission and the
 * ability had come apart, which is the kind of gap nobody reports as a bug
 * because it looks like the product simply does not do that.
 *
 * Deliberately without the assignment step the wizard puts underneath it.
 * Appointing somebody needs hr.employees.write; putting them in front of a
 * class needs academics.write, and HR does not hold it. Offering the controls
 * anyway would produce a form half of which 403s on submit — worse than not
 * offering them, because it implies HR can do something they cannot. The note
 * says who to ask instead.
 */

export default function AddStaff({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [added, setAdded] = useState('')


  const blank = {
    employee_code: '', first_name: '', last_name: '',
    email: '', phone: '', role_key: 'faculty', role_keys: [] as string[], create_login: true,
  }
  const [f, setF] = useState(blank)
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v })

  const save = useMutation({
    mutationFn: () => api.post('/api/v1/setup/employees', { ...f, create_login: !!f.email }),
    onSuccess: () => {
      qc.invalidateQueries()
      setAdded(`${[f.first_name, f.last_name].filter(Boolean).join(' ')} added`)
      setF(blank)
      onDone?.()
    },
  })

  if (!open) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => setOpen(true)}>Add a staff member</Button>
        <span className="text-[12.5px] text-muted-foreground">
          Appoint one person, or import your whole staff list from a spreadsheet.
        </span>
      </div>
    )
  }

  return (
    <div className="mb-5 rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-[14px] font-medium">Add a staff member</p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Employee code and first name are required.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setOpen(false); setAdded('') }}>
          Close
        </Button>
      </div>

      <div className="p-4">
        <FormNotice error={save.error} ok={added} />

        <FormGrid>
          <Field label="Employee code" required hint="Whatever your registers already use.">
            <Input value={f.employee_code} onChange={set('employee_code')} placeholder="T-014" />
          </Field>
          <Field label="Role" hint="Every role your school has, including any you have created.">
            {/* Same control as the setup wizard: one main role, plus any
                other hats. A school of forty has one person doing two jobs
                more often than not. */}
            <RoleSelect
              value={f.role_key}
              onChange={(x) => setF((p) => ({ ...p, role_key: x, role_keys: p.role_keys.filter((k) => k !== x) }))}
              extra={f.role_keys}
              onExtra={(v) => setF((p) => ({ ...p, role_keys: v }))}
            />
          </Field>
          <Field label="First name" required>
            <Input value={f.first_name} onChange={set('first_name')} />
          </Field>
          <Field label="Last name">
            <Input value={f.last_name} onChange={set('last_name')} />
          </Field>
          <Field label="Email" hint="Used to sign in. Leave blank for staff who will not.">
            <Input type="email" value={f.email} onChange={set('email')} />
          </Field>
          <Field label="Phone">
            <Input value={f.phone} onChange={set('phone')} />
          </Field>
        </FormGrid>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={save.isPending || !f.employee_code.trim() || !f.first_name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Adding…' : 'Add staff member'}
          </Button>
          <span className="text-[12.5px] text-muted-foreground">
            A teacher added here sees nothing until somebody puts them in front of a class.
            Ask your principal or the head of department to assign them a section and a subject —
            that is what grants access, not the role.
          </span>
        </div>

        <div className="mt-5 border-t pt-5">
          <BulkImport
            entity="staff"
            title="Or add your whole staff list from a sheet"
            hint="Employee code and first name are required. Give an email and a role and they get a login too."
            onDone={onDone}
          />
        </div>
      </div>
    </div>
  )
}
