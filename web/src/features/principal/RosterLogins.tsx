import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Badge, Button, Card, CardHeader, Field, FormNotice, Select, Table, Td,
} from '@/components/ui'

/* THE CLASS AS IT STANDS, NOT THE ACCOUNTS THAT HAPPEN TO EXIST.
 *
 * Logins & access listed logins, so a school whose children have none saw
 * "Students 0" and had nothing to act on -- which is the very school that needs
 * the screen. This lists the roll instead: every child in a class or section,
 * each with their guardians beside them, and against each of them whether they
 * can sign in and what they would type.
 *
 * A mother and a father appear as two rows under their child rather than two
 * strangers in an alphabetical list, because that is the sheet a class teacher
 * hands out: one family at a time.
 *
 * A password is shown once and cannot be read back, so the ones issued in this
 * sitting are held here beside the person until the page is left. That is also
 * what the download carries: a family to a line, both parents' names, sign-ins
 * and passwords side by side, in the roll's own order.
 */

interface Guardian {
  id: string
  full_name: string
  relation: string
  phone: string
  has_login: boolean
  sign_in_as: string
}
interface Child {
  id: string
  name: string
  admission_no: string
  roll_no?: number
  class_name: string
  section_name: string
  has_login: boolean
  sign_in_as: string
  guardians: Guardian[]
}
interface Section {
  id: string
  class_id: string
  class_name: string
  name: string
}

const csvCell = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"'

export function RosterLogins({ kind }: { kind: 'students' | 'guardians' }) {
  const qc = useQueryClient()
  const [target, setTarget] = useState('')
  /* What was issued in this sitting, by person id. The server will not say it
     twice and the page cannot ask again. */
  const [issued, setIssued] = useState<Record<string, { signIn: string; password: string }>>({})

  const sections = useQuery({
    queryKey: ['academics-sections'],
    queryFn: () => api.get<{ items: Section[] }>('/api/v1/academics/sections'),
  })

  const [scope, id] = target.split(':')
  /* Everybody, until a class is chosen. The office opens this to find out who
     cannot sign in; asking them to pick a class first hides the answer behind
     a question they have not got yet. */
  const roster = useQuery({
    queryKey: ['login-roster', target],
    queryFn: () =>
      api.get<{ items: Child[] }>(
        '/api/v1/setup/logins/roster' +
          (target ? '?' + (scope === 'class' ? 'class_id=' : 'section_id=') + id : ''),
      ),
  })

  const issue = useMutation({
    mutationFn: (v: { id: string; who: 'student' | 'guardian'; reset: boolean }) =>
      api
        .post<{ sign_in_as?: string; password?: string; temporary_password?: string }>(
          '/api/v1/setup/' + (v.who === 'student' ? 'students' : 'guardians') + '/' + v.id +
            '/login' + (v.reset ? '?reset=true' : ''),
          {},
        )
        .then((r) => ({ id: v.id, signIn: r.sign_in_as ?? '', password: r.password ?? r.temporary_password ?? '' })),
    onSuccess: (r) => {
      setIssued((m) => ({ ...m, [r.id]: { signIn: r.signIn, password: r.password } }))
      void qc.invalidateQueries({ queryKey: ['login-roster', target] })
      void qc.invalidateQueries({ queryKey: ['admin-users'] })
    },
  })

  const items = sections.data?.items ?? []
  const targets = [
    ...[...new Map(items.map((s) => [s.class_id, s])).values()].map((s) => ({
      value: 'class:' + s.class_id,
      label: s.class_name + ', every section',
    })),
    ...items.map((s) => ({ value: 'section:' + s.id, label: s.class_name + ' ' + s.name })),
  ]
  const children = roster.data?.items ?? []

  /* What to show for one person: whatever was issued a moment ago, otherwise
     the sign-in name the account already had. */
  const shown = (personID: string, fallback: string) => {
    const got = issued[personID]
    return { signIn: got?.signIn || fallback, password: got?.password ?? '' }
  }
  const note = (password: string, has: boolean) =>
    password || (has ? 'already set' : 'no login yet')

  const download = () => {
    const head =
      kind === 'students'
        ? ['Class', 'Section', 'Roll', 'Admission no', 'Child', 'Sign in as', 'Password']
        : ['Class', 'Section', 'Child', 'Parent 1', 'Relation', 'Sign in as', 'Password',
           'Parent 2', 'Relation', 'Sign in as', 'Password']
    const lines = [head.map(csvCell).join(',')]
    for (const ch of children) {
      if (kind === 'students') {
        const v = shown(ch.id, ch.sign_in_as)
        lines.push(
          [ch.class_name, ch.section_name, ch.roll_no, ch.admission_no, ch.name, v.signIn,
           note(v.password, ch.has_login)].map(csvCell).join(','),
        )
      } else {
        const a = ch.guardians[0]
        const b = ch.guardians[1]
        const va = a ? shown(a.id, a.sign_in_as || a.phone) : null
        const vb = b ? shown(b.id, b.sign_in_as || b.phone) : null
        lines.push(
          [ch.class_name, ch.section_name, ch.name,
           a?.full_name, a?.relation, va?.signIn, a && va ? note(va.password, a.has_login) : '',
           b?.full_name, b?.relation, vb?.signIn, b && vb ? note(vb.password, b.has_login) : '',
          ].map(csvCell).join(','),
        )
      }
    }
    // The BOM is what makes Excel read this as UTF-8 rather than mangling it.
    const url = URL.createObjectURL(
      new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download =
      (kind === 'students' ? 'student' : 'parent') + '-logins-' +
      new Date().toISOString().slice(0, 10) + '.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const without =
    kind === 'students'
      ? children.filter((c) => !c.has_login).length
      : children.reduce((n, c) => n + c.guardians.filter((g) => !g.has_login).length, 0)

  return (
    <Card>
      <CardHeader
        title={kind === 'students' ? 'The class, child by child' : 'The class, family by family'}
        description={
          kind === 'students'
            ? 'Every child on the roll, whether or not they can sign in yet.'
            : 'Every child with their guardians beside them, whether or not they can sign in yet.'
        }
        action={
          children.length > 0 ? (
            <Button variant="secondary" onClick={download}>
              Download CSV
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-4 px-[var(--card-pad)] py-4 text-[14px]">
        <div className="w-72">
          <Field label="Class or section">
            <Select value={target} onChange={setTarget} options={targets} placeholder="Every class" />
          </Field>
        </div>
        {!roster.isLoading && (
          <p className="text-muted-foreground">
            {children.length} {kind === 'students' ? 'on the roll' : 'families'}; {without}{' '}
            {kind === 'students' ? 'cannot sign in yet' : 'guardians cannot sign in yet'}.
          </p>
        )}
        <FormNotice error={issue.error ?? roster.error} />

        {kind === 'students' && (
          <Table
            head={['Roll', 'Child', 'Admission no', 'Sign in as', 'Password', '']}
            loading={roster.isLoading}
            empty={!children.length}
            emptyLabel="Nobody on this roll."
          >
            {children.map((ch) => {
              const v = shown(ch.id, ch.sign_in_as)
              return (
                <tr key={ch.id}>
                  <Td className="tabular-nums text-muted-foreground">{ch.roll_no ?? '—'}</Td>
                  <Td className="font-medium">{ch.name}</Td>
                  <Td className="tabular-nums">{ch.admission_no}</Td>
                  <Td className="font-mono">{v.signIn || '—'}</Td>
                  <Td>
                    {v.password ? (
                      <span className="font-mono">{v.password}</span>
                    ) : ch.has_login ? (
                      <Badge tone="success">already set</Badge>
                    ) : (
                      <Badge>no login</Badge>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Button
                      size="sm"
                      disabled={issue.isPending}
                      onClick={() => issue.mutate({ id: ch.id, who: 'student', reset: ch.has_login })}
                    >
                      {ch.has_login ? 'Reset' : 'Issue'}
                    </Button>
                  </Td>
                </tr>
              )
            })}
          </Table>
        )}

        {kind === 'guardians' && (
          <Table
            head={['Child', 'Parent', 'Relation', 'Sign in as', 'Password', '']}
            loading={roster.isLoading}
            empty={!children.length}
            emptyLabel="Nobody on this roll."
          >
            {children.flatMap((ch) =>
              ch.guardians.length === 0
                ? [
                    <tr key={ch.id}>
                      <Td className="font-medium">{ch.name}</Td>
                      <Td className="text-muted-foreground">No guardian on record.</Td>
                      <Td>—</Td>
                      <Td>—</Td>
                      <Td>—</Td>
                      <Td>—</Td>
                    </tr>,
                  ]
                : ch.guardians.map((g, i) => {
                    const v = shown(g.id, g.sign_in_as || g.phone)
                    return (
                      <tr key={g.id}>
                        <Td className="font-medium">{i === 0 ? ch.name : ''}</Td>
                        <Td>{g.full_name}</Td>
                        <Td className="text-muted-foreground">{g.relation || '—'}</Td>
                        <Td className="font-mono">{v.signIn || '—'}</Td>
                        <Td>
                          {v.password ? (
                            <span className="font-mono">{v.password}</span>
                          ) : g.has_login ? (
                            <Badge tone="success">already set</Badge>
                          ) : (
                            <Badge>no login</Badge>
                          )}
                        </Td>
                        <Td className="whitespace-nowrap">
                          <Button
                            size="sm"
                            disabled={issue.isPending}
                            onClick={() => issue.mutate({ id: g.id, who: 'guardian', reset: g.has_login })}
                          >
                            {g.has_login ? 'Reset' : 'Issue'}
                          </Button>
                        </Td>
                      </tr>
                    )
                  }),
            )}
          </Table>
        )}
      </div>
    </Card>
  )
}
