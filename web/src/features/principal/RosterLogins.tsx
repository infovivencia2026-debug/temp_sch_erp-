import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Printer, RotateCcw, X } from 'lucide-react'
import { api } from '@/lib/api'
import {
  Badge, Button, Card, CardHeader, CellGrid, Checkbox, Field, FormNotice, Input, Select, Stat, Table, Td,
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
  login_code: string
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
  login_code: string
  /** What the school holds for reaching them. Staff only, so far. */
  email?: string
  phone?: string
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
  /** The account's own ten characters, once it has one. */
  loginCode: string
  /** Whose parent, or which parents. The column the office reads down. */
  context: string
  /** Phone and email as the record holds them, shown rather than implied. */
  contact: string
  child: Child
}

/* Which endpoint issues a login for each audience. They differ by more than
   the word: a child's first password is their admission number, a parent's is
   their phone, and a member of staff's is phone-then-email -- each route knows
   its own rule, so the screen only has to know which to call. */
const ROUTE = { students: 'students', guardians: 'guardians', staff: 'employees' } as const

export function RosterLogins({ kind, signedIn, initialStatus = '' }: { kind: 'students' | 'guardians' | 'staff'; signedIn?: number; initialStatus?: string }) {
  const qc = useQueryClient()
  const [target, setTarget] = useState('')
  const [needle, setNeedle] = useState('')
  const [status, setStatus] = useState(initialStatus)
  const [picked, setPicked] = useState<Record<string, true>>({})
  /* What was issued in this sitting, by person id. The server will not say it
     twice and the page cannot ask again. */
  const [issued, setIssued] = useState<Record<string, { signIn: string; password: string }>>({})

  const sections = useQuery({
    queryKey: ['academics-sections'],
    queryFn: () => api.get<{ items: Section[] }>('/api/v1/academics/sections'),
  })

  const [scope, id] = target.split(':')
  /* Staff sit in no class, so the picker above does not apply to them and the
     whole roll comes back in one go. Keeping `target` in the key regardless
     costs nothing and means the three tabs never read each other's cache. */
  const roster = useQuery({
    queryKey: ['login-roster', kind, target],
    queryFn: () =>
      api.get<{ items: Child[] }>(
        '/api/v1/setup/logins/roster' +
          (kind === 'staff'
            ? '?kind=staff'
            : target
            ? '?' + (scope === 'class' ? 'class_id=' : 'section_id=') + id
            : ''),
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
          '/api/v1/setup/' + ROUTE[kind] + '/' + personID +
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
      void qc.invalidateQueries({ queryKey: ['login-roster', kind, target] })
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
    /* A member of staff is one person and one row, like a child, but placed by
       what they do rather than where they sit: designation on the name, and
       the department in the column the other tabs give to family. */
    if (kind === 'staff') {
      return children.map((p) => ({
        id: p.id,
        name: p.name,
        under: p.class_name || 'Staff',
        code: p.admission_no,
        signIn: p.sign_in_as,
        hasLogin: p.has_login,
        loginCode: p.login_code,
        context: p.section_name || '—',
        contact: [p.phone, p.email].filter(Boolean).join(' · '),
        child: p,
      }))
    }
    if (kind === 'students') {
      return children.map((ch) => ({
        id: ch.id,
        name: ch.name,
        /* A child with no active enrolment has no class, no section and no
           roll, and "Roll — · " read as a broken row rather than an unplaced
           one. The state has a name; the row says it. */
        under: ch.class_name
          ? 'Roll ' + (ch.roll_no ?? '—') + ' · ' + [ch.class_name, ch.section_name].filter(Boolean).join('-')
          : 'Not in a class yet',
        code: ch.admission_no,
        signIn: ch.sign_in_as,
        hasLogin: ch.has_login,
        loginCode: ch.login_code,
        context: ch.guardians.map((g) => g.full_name).join(', ') || 'No guardian on record',
        contact: '',
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
          loginCode: g.login_code,
          context: where,
          contact: g.phone,
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
    return (r.name + ' ' + r.code + ' ' + r.under + ' ' + r.context + ' ' + r.contact).toLowerCase().includes(t)
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
    login_code: r.loginCode,
    existing: r.hasLogin,
    child_name: kind === 'guardians' ? r.child.name : undefined,
    /* Designation and department, not class and section, but the same two
       columns underneath -- the sheet is one shape for all three audiences. */
    admission_no: r.child.admission_no,
    class_name: r.child.class_name,
    section_name: r.child.section_name,
    roll_no: r.child.roll_no,
    phone: r.child.phone,
    email: r.child.email,
  }))

  /* Only those whose password this sitting actually produced: resetting is what
     yields one, and a row that merely already had a login has nothing to show. */
  const justIssued = rows.filter((r) => issued[r.id]?.password)

  const initials = (name: string) =>
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'

  /* The words this audience is called by, in one place: the print heading, the
     file name and the two columns that change. Three tabs' worth of ternaries
     down the render was how "Parent logins" ended up printed over a staff
     sheet the first time staff were added. */
  const WORDS = {
    students: { title: 'Student logins', file: 'student-logins', who: 'Child', beside: 'Guardians', id: 'Admission no' },
    guardians: { title: 'Parent logins', file: 'parent-logins', who: 'Parent', beside: 'Child', id: '' },
    staff: { title: 'Staff logins', file: 'staff-logins', who: 'Name', beside: 'Department', id: 'Staff code' },
  }[kind]

  /* THE SECTION IN THE FILE NAME AND ON THE PRINT.

     Exporting 6-A and then 6-B put two files called parent-logins-<today> in
     the same folder, the second one named (1), and nothing inside either said
     which class it was. A sheet of passwords nobody can place is a sheet
     nobody can hand out. */
  const where = targets.find((t) => t.value === target)?.label.trim() ?? ''
  const slug = where.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  const fileStem = slug ? WORDS.file + '-' + slug : WORDS.file
  const printTitle = where ? WORDS.title + ' — ' + where : WORDS.title

  const act = (reset: boolean) => {
    const ids = (chosen.length ? chosen : []).map((r) => r.id)
    if (!ids.length) return
    const word = reset ? 'Give these ' + ids.length + ' a new password? The one they hold now stops working.'
      : 'Issue a login for these ' + ids.length + '?'
    if (!window.confirm(word)) return
    issue.mutate({ ids, reset })
  }

  /* EVERYBODY ON THE LIST, WITHOUT TICKING FORTY BOXES.

     Handing a class its logins is one errand -- a section changes hands in
     June and the slips go out again -- and doing it through the tick boxes is
     forty clicks that must not miss one. This acts on everybody currently
     listed, which is exactly what the class picker and the filters above have
     already narrowed to: what it will touch is what the screen is showing.

     ISSUING AND RESETTING ARE NOT THE SAME RISK, so they do not ask the same
     question. Issuing skips anybody who already has a working login, so the
     worst it can do is give a password to somebody who had none. Resetting
     stops every password in use, so its wording says the count, says where,
     and says the new ones exist on this page and nowhere else.

     The whole school is allowed -- a school opening for the year does mean
     all four hundred -- but then the question says 'the whole school' in
     those words, rather than a number that could be any class. */
  const actAll = (reset: boolean) => {
    const ids = shown.map((r) => r.id)
    if (!ids.length) return
    const place = kind === 'staff' ? 'the staff register'
      : (targets.find((t) => t.value === target)?.label.trim() || 'the whole school')
    const word = reset
      ? 'Give all ' + ids.length + ' of ' + place + ' a new password?\n\n' +
        'Every password they hold now stops working, including the ones already in use. ' +
        'The new ones are shown on this page once and nowhere else, so export or print them before leaving.'
      : 'Issue a login to all ' + ids.length + ' of ' + place + '?\n\n' +
        'Anybody who already has a working login keeps it. The new passwords are shown ' +
        'on this page once, so export or print them before leaving.'
    if (!window.confirm(word)) return
    issue.mutate({ ids, reset })
  }

  const who = kind === 'students' ? 'Students' : kind === 'guardians' ? 'Parents' : 'Staff'
  return (
    <>
    {/* FOUR NUMBERS, ALL COUNTED FROM THE ROLL BELOW, so they always match it.
        "Not issued" is the one to press: it shows exactly who has no working
        login yet, ready to issue. */}
    <CellGrid cols={4}>
      <Stat label={who + ' on the roll'} value={roster.isLoading ? '…' : rows.length}
        hint={status ? 'Show everyone' : 'Everyone below'} active={status === ''} onClick={() => setStatus('')} />
      <Stat label="Can sign in" value={roster.isLoading ? '…' : rows.length - without}
        hint="Have a working login" active={status === 'issued'} onClick={() => setStatus(status === 'issued' ? '' : 'issued')} />
      <Stat label="Not issued" value={roster.isLoading ? '…' : without}
        hint={without ? 'Press to see them and issue' : 'Everybody has a login'} active={status === 'not'} onClick={() => setStatus(status === 'not' ? '' : 'not')} />
      <Stat label="Signed in now" value={signedIn ?? '-'} hint="Active in the last 10 minutes" />
    </CellGrid>
    <Card>
      <CardHeader
        title={
          kind === 'students' ? 'The class, child by child'
            : kind === 'guardians' ? 'The class, family by family'
            : 'The staff roll, person by person'
        }
        description={
          kind === 'students'
            ? 'Every child on the roll, whether or not they can sign in yet.'
            : kind === 'guardians'
            ? 'Every guardian of the children on the roll, whether or not they can sign in yet.'
            : 'Everybody on the staff register, whether or not they can sign in yet.'
        }
      />

      {/* The class, and what to do to it. */}
      <div className="flex flex-wrap items-end gap-3 border-b px-[var(--card-pad)] py-4">
        {/* A member of staff is in no class, so there is nothing here to
            narrow by. A picker that cannot change the list is worse than no
            picker: it reads as the reason the list is empty. */}
        {kind !== 'staff' && (
          <div className="w-64">
            <Field label="Class or section">
              <Select value={target} onChange={setTarget} options={targets} placeholder="Every class" />
            </Field>
          </div>
        )}
        <div className="mr-auto text-[13px] text-muted-foreground">
          <span className="text-[15px] font-semibold text-foreground">
            {rows.length - without} / {rows.length}
          </span>{' '}
          can sign in
          <div className="text-[12px]">
            {kind === 'students'
              ? 'First password is the admission number.'
              : kind === 'guardians'
              ? 'First password is their own phone number.'
              : 'First password is their phone number, or their email if they have no phone.'}
          </div>
        </div>
        {/* Two pairs, and the difference between them is the only thing the
            office has to hold in its head: the left pair acts on everybody the
            filters have left showing, the right pair on the rows ticked. */}
        <Button
          variant="secondary"
          disabled={!shown.length || issue.isPending}
          title={'Give all ' + shown.length + ' listed here a new password'}
          onClick={() => actAll(true)}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset all {shown.length}
        </Button>
        <Button
          variant="secondary"
          disabled={!shown.length || issue.isPending}
          title={'Issue a login to all ' + shown.length + ' listed here'}
          onClick={() => actAll(false)}
        >
          <KeyRound className="h-3.5 w-3.5" />
          Issue all {shown.length}
        </Button>
        <span className="hidden h-6 w-px bg-border sm:block" />
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
            placeholder={
              kind === 'students' ? 'Name, roll or admission no'
                : kind === 'guardians' ? 'Parent, child or phone'
                : 'Name, staff code or designation'
            }
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
          onClick={() => printSlips(sheet, printTitle)}
        >
          <Printer className="h-3.5 w-3.5" />
          Print slips
        </Button>
        <Button
          variant="secondary"
          disabled={!sheet.length}
          onClick={() => downloadLogins(sheet, fileStem, kind)}
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
              <Button variant="secondary" onClick={() => printSlips(sheet, printTitle)}>
                <Printer className="h-3.5 w-3.5" />
                Print slips
              </Button>
              <Button
                variant="secondary"
                onClick={() => downloadLogins(sheet, fileStem, kind)}
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

                  {/* NO "EMAIL IT" BUTTON HERE, ON PURPOSE.

                      Issuing a login already sends the credentials on every
                      channel the person has, so a button beside the password
                      re-sends what went out seconds earlier. It is also greyed
                      out for the majority of parents, who have no address on
                      record, and what it does send is a plaintext password
                      that stays in an inbox for good. Copy it, print the slip,
                      or read it down the phone. */}
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
          WORDS.who,
          /* A parent's phone, their sign-in name and their first password are
             the same ten digits, so three columns of it made the password
             invisible -- it read as the number repeated. The child keeps an
             admission number column, because for a child they differ. */
          ...(WORDS.id ? [WORDS.id] : []),
          /* THE CONTACT THE SCHOOL TYPED IN.
             The roll listed a sign-in name and an account id and nothing the
             office recognised -- a record showing none of the phone or email
             it holds reads as a record that has lost them. */
          ...(kind === 'staff' ? ['Phone & email'] : []),
          'Signs in as',
          /* The permanent one, beside the one they type. A phone changes
             and an admission number is reissued; this never does, and it
             is the only identifier that can still be read back after the
             password has gone. */
          'Account ID',
          'Password',
          WORDS.beside,
          '',
        ]}
        loading={roster.isLoading}
        empty={!shown.length}
        emptyLabel={
          rows.length
            ? 'Nobody matches those filters.'
            : kind === 'staff'
            ? 'Nobody is on the staff register yet.'
            : 'Nobody on this roll.'
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
              {WORDS.id !== '' && (
                <Td className="font-mono text-[12.5px]">{r.code || '—'}</Td>
              )}
              {kind === 'staff' && (
                <Td className="text-[12.5px] text-muted-foreground">{r.contact || '—'}</Td>
              )}
              <Td className="font-mono text-[12.5px]">{got?.signIn || r.signIn || '—'}</Td>
              <Td className="font-mono text-[12.5px] text-muted-foreground">{r.loginCode || '—'}</Td>
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
    </>
  )
}
