import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, MessageCircle, Printer, RotateCcw, X } from 'lucide-react'
import { api } from '@/lib/api'
import {
  Badge, Button, Card, CardHeader, Checkbox, Field, FormNotice, Input, Select, Table, Td,
} from '@/components/ui'
import { downloadLogins, printSlips } from './StudentLoginsCard'

/* THE CLASS AS IT STANDS, NOT THE ACCOUNTS THAT HAPPEN TO EXIST.
 *
 * Logins & access listed logins, so a school whose children have none saw
 * "Students 0" and had nothing to act on -- which is the school that needs this
 * screen most. This lists the roll: every child in a class or section, each
 * with their guardians, and against each of them whether they can sign in.
 *
 * WHY A TICK BOX PER ROW. The errand is almost never "everybody" or "one".
 * It is the eleven children in 6-B who were admitted after the logins went out,
 * and issuing to the whole class to reach them resets the twenty-seven who are
 * already using theirs. Choose, then act on the chosen.
 *
 * A password is shown once and cannot be read back, so the ones issued in this
 * sitting stay on screen beside the person until the page is left -- and that
 * is what the print and the download carry.
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

/** One person as this screen deals with them, child or guardian alike. */
interface Row {
  id: string
  name: string
  /** Roll and class for a child; the relation for a guardian. */
  under: string
  /** Admission number for a child, phone for a guardian. */
  code: string
  signIn: string
  hasLogin: boolean
  /** Whose parent, or which parents. The column the office reads down. */
  context: string
  child: Child
}

export function RosterLogins({ kind }: { kind: 'students' | 'guardians' }) {
  const qc = useQueryClient()
  const [target, setTarget] = useState('')
  const [needle, setNeedle] = useState('')
  const [status, setStatus] = useState('')
  const [picked, setPicked] = useState<Record<string, true>>({})
  /* What was issued in this sitting, by person id. The server will not say it
     twice and the page cannot ask again. */
  const [issued, setIssued] = useState<Record<string, { signIn: string; password: string }>>({})

  const sections = useQuery({
    queryKey: ['academics-sections'],
    queryFn: () => api.get<{ items: Section[] }>('/api/v1/academics/sections'),
  })

  const [scope, id] = target.split(':')
  const roster = useQuery({
    queryKey: ['login-roster', target],
    queryFn: () =>
      api.get<{ items: Child[] }>(
        '/api/v1/setup/logins/roster' +
          (target ? '?' + (scope === 'class' ? 'class_id=' : 'section_id=') + id : ''),
      ),
  })

  const issue = useMutation({
    mutationFn: async (v: { ids: string[]; reset: boolean }) => {
      const out: { id: string; signIn: string; password: string }[] = []
      /* One at a time on purpose. The endpoint is per person, and a school's
         section is forty rows: a burst of forty parallel writes against D1 is
         how a batch half-succeeds and nobody can tell which half. */
      for (const personID of v.ids) {
        const r = await api.post<{ sign_in_as?: string; password?: string; temporary_password?: string }>(
          '/api/v1/setup/' + (kind === 'students' ? 'students' : 'guardians') + '/' + personID +
            '/login' + (v.reset ? '?reset=true' : ''),
          {},
        )
        out.push({ id: personID, signIn: r.sign_in_as ?? '', password: r.password ?? r.temporary_password ?? '' })
      }
      return out
    },
    onSuccess: (list) => {
      setIssued((m) => {
        const next = { ...m }
        for (const r of list) next[r.id] = { signIn: r.signIn, password: r.password }
        return next
      })
      void qc.invalidateQueries({ queryKey: ['login-roster', target] })
      void qc.invalidateQueries({ queryKey: ['admin-users'] })
    },
  })

  const items = sections.data?.items ?? []
  /* Each class, then its own sections under it. Listing every class first and
     every section afterwards meant scrolling past twelve classes to reach the
     first section name, and a school picks "6-B" far more often than it picks
     "the whole of 6". */
  const targets = useMemo(() => {
    const byClass = new Map<string, Section[]>()
    for (const s of items) {
      if (!byClass.has(s.class_id)) byClass.set(s.class_id, [])
      byClass.get(s.class_id)!.push(s)
    }
    const out: { value: string; label: string }[] = []
    for (const [classID, list] of byClass) {
      const className = list[0].class_name
      out.push({ value: 'class:' + classID, label: className + ' — every section' })
      for (const s of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ value: 'section:' + s.id, label: '    ' + className + ' ' + s.name })
      }
    }
    return out
  }, [items])
  const children = roster.data?.items ?? []

  /* One flat list of people, whichever tab this is. A child's row is the child;
     a family's rows are its guardians, each carrying the child's name so the
     column can be read straight down. */
  const rows: Row[] = useMemo(() => {
    if (kind === 'students') {
      return children.map((ch) => ({
        id: ch.id,
        name: ch.name,
        under: 'Roll ' + (ch.roll_no ?? '—') + ' · ' + [ch.class_name, ch.section_name].filter(Boolean).join('-'),
        code: ch.admission_no,
        signIn: ch.sign_in_as,
        hasLogin: ch.has_login,
        context: ch.guardians.map((g) => g.full_name).join(', ') || 'No guardian on record',
        child: ch,
      }))
    }
    /* ONE ROW PER PARENT, NOT ONE PER CHILD OF THEIRS.

       A mother with two children in the school appeared twice, and both rows
       carried her guardian id -- so React had two children with the same key
       and reused the wrong one whenever the list was filtered: search for a
       name and rows for other people stayed on screen. It was also two rows
       offering to issue one login, and one login is all she gets: it reaches
       every child she is guardian of.

       So the guardians are merged, and the children gather into the column
       that names them. */
    const seen = new Map<string, Row>()
    for (const ch of children) {
      const where = ch.name + ' · ' + [ch.class_name, ch.section_name].filter(Boolean).join('-')
      for (const g of ch.guardians) {
        const had = seen.get(g.id)
        if (had) {
          had.context += '; ' + where
          continue
        }
        seen.set(g.id, {
          id: g.id,
          name: g.full_name,
          under: g.relation || 'guardian',
          code: g.phone,
          signIn: g.sign_in_as || g.phone,
          hasLogin: g.has_login,
          context: where,
          child: ch,
        })
      }
    }
    return [...seen.values()]
  }, [children, kind])

  const shown = rows.filter((r) => {
    if (status === 'issued' && !r.hasLogin) return false
    if (status === 'not' && r.hasLogin) return false
    const t = needle.trim().toLowerCase()
    if (!t) return true
    return (r.name + ' ' + r.code + ' ' + r.under + ' ' + r.context).toLowerCase().includes(t)
  })
  const chosen = shown.filter((r) => picked[r.id])
  const allOn = shown.length > 0 && chosen.length === shown.length
  const without = rows.filter((r) => !r.hasLogin).length

  const toggleAll = () =>
    setPicked(allOn ? {} : Object.fromEntries(shown.map((r) => [r.id, true as const])))

  /* What print and download are handed: the people on screen, with whatever was
     issued a moment ago filled in beside them. */
  const sheet = shown.map((r) => ({
    name: r.name,
    sign_in_as: issued[r.id]?.signIn || r.signIn,
    password: issued[r.id]?.password,
    existing: r.hasLogin,
    child_name: kind === 'guardians' ? r.child.name : undefined,
    admission_no: r.child.admission_no,
    class_name: r.child.class_name,
    section_name: r.child.section_name,
    roll_no: r.child.roll_no,
  }))

  /* Only those whose password this sitting actually produced: resetting is what
     yields one, and a row that merely already had a login has nothing to show. */
  const justIssued = rows.filter((r) => issued[r.id]?.password)

  const initials = (name: string) =>
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'

  const act = (reset: boolean) => {
    const ids = (chosen.length ? chosen : []).map((r) => r.id)
    if (!ids.length) return
    const word = reset ? 'Give these ' + ids.length + ' a new password? The one they hold now stops working.'
      : 'Issue a login for these ' + ids.length + '?'
    if (!window.confirm(word)) return
    issue.mutate({ ids, reset })
  }

  return (
    <Card>
      <CardHeader
        title={kind === 'students' ? 'The class, child by child' : 'The class, family by family'}
        description={
          kind === 'students'
            ? 'Every child on the roll, whether or not they can sign in yet.'
            : 'Every guardian of the children on the roll, whether or not they can sign in yet.'
        }
      />

      {/* The class, and what to do to it. */}
      <div className="flex flex-wrap items-end gap-3 border-b px-[var(--card-pad)] py-4">
        <div className="w-64">
          <Field label="Class or section">
            <Select value={target} onChange={setTarget} options={targets} placeholder="Every class" />
          </Field>
        </div>
        <div className="mr-auto text-[13px] text-muted-foreground">
          <span className="text-[15px] font-semibold text-foreground">
            {rows.length - without} / {rows.length}
          </span>{' '}
          can sign in
          <div className="text-[12px]">
            {kind === 'students'
              ? 'First password is the admission number.'
              : 'First password is their own phone number.'}
          </div>
        </div>
        <Button
          variant="secondary"
          disabled={!chosen.length || issue.isPending}
          onClick={() => act(true)}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset selected{chosen.length ? ' (' + chosen.length + ')' : ''}
        </Button>
        <Button disabled={!chosen.length || issue.isPending} onClick={() => act(false)}>
          <KeyRound className="h-3.5 w-3.5" />
          {issue.isPending ? 'Issuing…' : 'Issue selected' + (chosen.length ? ' (' + chosen.length + ')' : '')}
        </Button>
      </div>

      {/* Narrow the list, and take it away. */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-surface-sunken/40 px-[var(--card-pad)] py-3">
        <div className="w-64">
          <Input
            value={needle}
            onChange={setNeedle}
            srLabel="Search this roll"
            placeholder={kind === 'students' ? 'Name, roll or admission no' : 'Parent, child or phone'}
          />
        </div>
        <Select
          value={status}
          onChange={setStatus}
          placeholder="Any status"
          options={[
            { value: 'issued', label: 'Can sign in' },
            { value: 'not', label: 'No login yet' },
          ]}
        />
        <Button variant="ghost" disabled={!shown.length} onClick={toggleAll}>
          {allOn ? 'Clear all' : 'Choose all ' + shown.length}
        </Button>
        <span className="mr-auto text-[12.5px] text-muted-foreground">
          {shown.length} of {rows.length}
        </span>
        <Button
          variant="secondary"
          disabled={!sheet.length}
          onClick={() => printSlips(sheet, kind === 'students' ? 'Student logins' : 'Parent logins')}
        >
          <Printer className="h-3.5 w-3.5" />
          Print slips
        </Button>
        <Button
          variant="secondary"
          disabled={!sheet.length}
          onClick={() => downloadLogins(sheet, kind === 'students' ? 'student-logins' : 'parent-logins', kind)}
        >
          Export CSV
        </Button>
      </div>

      {/* A PASSWORD IS SHOWN ONCE.

          It appears in the row as well, but a row is easy to lose in forty of
          them and the thing cannot be asked for again -- so the ones issued in
          this sitting are also gathered here, at the top, until the page is
          left. */}
      {/* WHAT WAS JUST HANDED OUT.

          A password is shown once and cannot be asked for again, so this is the
          only moment it exists anywhere a person can read it. It is drawn as a
          card per person rather than a line of text because the office does one
          of four things with it -- copies it, prints it, sends it, or writes it
          on a slip -- and each of those wants the two values apart and labelled,
          not run together where the sign-in name and the password are the same
          ten digits. */}
      {justIssued.length > 0 && (
        <div className="mx-[var(--card-pad)] mt-4 rounded-2xl border border-success/40 bg-success/5 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-success text-success-foreground">
                <KeyRound className="h-4 w-4" />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[14px] font-semibold">
                    {justIssued.length} password{justIssued.length === 1 ? '' : 's'} issued just now
                  </h3>
                  <Badge tone="warning">Shown once only</Badge>
                </div>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  These will not be shown again once you leave this page. Copy, send, print or download them now.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              <Button variant="secondary" onClick={() => printSlips(sheet, kind === 'students' ? 'Student logins' : 'Parent logins')}>
                <Printer className="h-3.5 w-3.5" />
                Print slips
              </Button>
              <Button
                variant="secondary"
                onClick={() => downloadLogins(sheet, kind === 'students' ? 'student-logins' : 'parent-logins', kind)}
              >
                Download
              </Button>
              <Button variant="ghost" onClick={() => setIssued({})} title="Dismiss">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="mt-4 grid gap-2">
            {justIssued.map((r) => {
              const got = issued[r.id]
              const signIn = got.signIn || r.signIn
              return (
                <div
                  key={r.id}
                  className="flex flex-col gap-3 rounded-xl border border-success/30 bg-card p-3 md:flex-row md:items-center md:justify-between"
                >
                  <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border bg-surface-sunken text-[11px] font-semibold text-muted-foreground">
                      {initials(r.name)}
                    </span>
                    <div>
                      <div className="text-[13.5px] font-semibold">{r.name}</div>
                      <div className="text-[11.5px] text-muted-foreground">{r.under} · {r.context}</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-5">
                    <div>
                      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Username
                      </span>
                      <span className="font-mono text-[13px] font-medium">{signIn}</span>
                    </div>
                    <span className="hidden h-6 w-px bg-border sm:block" />
                    <div>
                      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        First password
                      </span>
                      <span className="inline-flex items-center gap-2">
                        <span className="rounded border border-success/40 bg-success/10 px-2 py-0.5 font-mono text-[13px] font-semibold">
                          {got.password}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Copy the password"
                          onClick={() => { void navigator.clipboard?.writeText(got.password).catch(() => {}) }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    </div>
                  </div>

                  {/* wa.me opens the person's own WhatsApp with the message
                      written; nothing is sent from here, and nothing is stored. */}
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const text = `${r.name}, your login for the school app:
Username: ${signIn}
Password: ${got.password}
You will choose your own password the first time.`
                        window.open('https://wa.me/' + (r.code || '').replace(/\D/g, '') + '?text=' + encodeURIComponent(text), '_blank')
                      }}
                    >
                      <MessageCircle className="h-3.5 w-3.5" />
                      WhatsApp
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <FormNotice error={issue.error ?? roster.error} />

      <Table
        head={[
          /* A column header is a string here, not markup, so choosing
             everybody lives in the toolbar above where its count can be
             read out loud. */
          '',
          kind === 'students' ? 'Child' : 'Parent',
          /* A parent's phone, their sign-in name and their first password are
             the same ten digits, so three columns of it made the password
             invisible -- it read as the number repeated. The child keeps an
             admission number column, because for a child they differ. */
          ...(kind === 'students' ? ['Admission no'] : []),
          'Signs in as',
          'Password',
          kind === 'students' ? 'Guardians' : 'Child',
          '',
        ]}
        loading={roster.isLoading}
        empty={!shown.length}
        emptyLabel={
          rows.length ? 'Nobody matches those filters.' : 'Nobody on this roll.'
        }
      >
        {shown.map((r) => {
          const got = issued[r.id]
          return (
            <tr key={r.id}>
              <Td>
                <Checkbox
                  checked={!!picked[r.id]}
                  onChange={() =>
                    setPicked((m) => {
                      const next = { ...m }
                      if (next[r.id]) delete next[r.id]
                      else next[r.id] = true
                      return next
                    })
                  }
                  label=""
                  srLabel={'Choose ' + r.name}
                />
              </Td>
              <Td>
                <div className="font-medium">{r.name}</div>
                <div className="text-[12px] text-muted-foreground">{r.under}</div>
              </Td>
              {kind === 'students' && (
                <Td className="font-mono text-[12.5px]">{r.code || '—'}</Td>
              )}
              <Td className="font-mono text-[12.5px]">{got?.signIn || r.signIn || '—'}</Td>
              <Td>
                {got?.password ? (
                  <span className="font-mono">{got.password}</span>
                ) : r.hasLogin ? (
                  <Badge tone="success">can sign in</Badge>
                ) : (
                  <Badge tone="warning">no login yet</Badge>
                )}
              </Td>
              <Td className="text-[12.5px] text-muted-foreground">{r.context}</Td>
              <Td className="whitespace-nowrap">
                <Button
                  size="sm"
                  variant={r.hasLogin ? 'secondary' : 'primary'}
                  disabled={issue.isPending}
                  onClick={() => issue.mutate({ ids: [r.id], reset: r.hasLogin })}
                >
                  {r.hasLogin ? 'Reset' : 'Issue now'}
                </Button>
              </Td>
            </tr>
          )
        })}
      </Table>
    </Card>
  )
}
