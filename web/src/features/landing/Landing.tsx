import { useEffect, useState } from 'react'

/* THE FRONT DOOR.

   Signing out, or arriving at the address for the first time, used to put a
   sign-in form in front of somebody who had not yet been told what they were
   signing in to. A school looking at the product for the first time saw a
   username box; a parent handed a link saw the same. Neither is a front door.

   So the root address answers with a page that says what this is, who it is
   for, and where the apps are, with sign-in one button away. Everything
   deeper still goes straight to the form: a person opening a link to a fee
   receipt wants the receipt, not an introduction.

   Rendered by the SPA rather than served by Go, because "/" is a static file
   at the edge and this is the one page that must appear instantly, on the
   worst connection, before anything is fetched. There is nothing to fetch: no
   data, no session, no images beyond the mark drawn below in SVG.

   Nothing here appears abruptly. The page fades up once, as a whole, at the
   size it will settle at -- see the standing rule about sudden arrivals. */

const MODULES: { name: string; body: string }[] = [
  {
    name: 'Admissions',
    body: 'Enquiry to enrolment in one thread, with the offer, the seat and the first invoice raised where the decision was made.',
  },
  {
    name: 'Fees',
    body: 'Structures, concessions, instalments and receipts. Numbered without gaps, reconciled against the bank, and readable by the parent who paid.',
  },
  {
    name: 'Attendance',
    body: 'Daily and period-wise, marked from a phone, corrected with a record of who corrected it, and told to the family the same morning.',
  },
  {
    name: 'Examinations',
    body: 'Datesheets, seating, marks entry, moderation and report cards, released to families when the school says so and not the moment a mark is typed.',
  },
  {
    name: 'Timetable',
    body: 'Built against real teachers and real rooms, with substitutions when somebody is away and the cover recorded for payroll.',
  },
  {
    name: 'Transport',
    body: "The driver's own phone becomes the bus's tracker. Parents see the bus on a map and are told when it is near their stop.",
  },
  {
    name: 'Staff and payroll',
    body: 'Appointment to appraisal, leave to salary, with PF, ESI, professional tax and Form 16 where the law expects them.',
  },
  {
    name: 'The family portal',
    body: 'One place a parent reads the circular, the homework, the attendance and the bill, on the web and in the app.',
  },
]

export function Landing() {
  /* One transition, armed after the first paint, so the page arrives rather
     than appearing. Skipped outright when the reader has asked for less
     motion: reduced motion means instant and calm, never a pop. */
  const [shown, setShown] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <div
      className={
        /* The tokens by name, not through `bg-background`.

           bento-theme.css redefines that utility globally to its own
           `--bento-bg`, which is the board's palette and is light whatever
           the reader asked for -- so this page came up light on a dark
           machine while every variable around it said dark. Naming the
           variable directly is immune to a utility being redefined
           elsewhere, which for a page outside the app's layout is the
           safer dependency. */
        'min-h-full bg-[hsl(var(--background))] text-[hsl(var(--foreground))] transition-opacity duration-500 ' +
        (shown ? 'opacity-100' : 'opacity-0')
      }
    >
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight">EDU CLOUD</span>
        </span>
        <nav className="flex items-center gap-1.5 text-[13.5px]">
          <a
            href="/buy"
            className="rounded-md px-3 py-1.5 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--surface-hover))] hover:text-[hsl(var(--foreground))]"
          >
            Pricing
          </a>
          <a
            href="/apps"
            className="hidden rounded-md px-3 py-1.5 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--surface-hover))] hover:text-[hsl(var(--foreground))] sm:inline-block"
          >
            Apps
          </a>
          <a
            href="/login"
            className="rounded-md bg-[hsl(var(--primary))] px-3.5 py-1.5 font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90"
          >
            Sign in
          </a>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="border-b py-16 sm:py-24">
          <h1 className="max-w-3xl text-[32px] font-semibold leading-[1.15] tracking-tight sm:text-[44px]">
            One system for the whole school, from the enquiry to the transfer
            certificate.
          </h1>
          <p className="mt-5 max-w-2xl text-[15.5px] leading-relaxed text-[hsl(var(--muted-foreground))]">
            Admissions, fees, attendance, examinations, timetable, transport,
            staff and payroll, and a portal the family actually opens. Built for
            Indian schools: the fee receipt is numbered the way the auditor
            expects, the payroll knows about PF and ESI, and the bus is on a map
            because a parent asked where it was.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="/buy"
              className="rounded-md bg-[hsl(var(--primary))] px-4 py-2.5 text-[14px] font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90"
            >
              See the plans
            </a>
            <a
              href="/login"
              className="rounded-md border px-4 py-2.5 text-[14px] font-medium transition-colors hover:bg-[hsl(var(--surface-hover))]"
            >
              Sign in to your school
            </a>
          </div>
        </section>

        <section className="py-14 sm:py-16">
          <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
            What is in it
          </h2>
          <div className="mt-7 grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {MODULES.map((m) => (
              <div key={m.name}>
                <h3 className="text-[15px] font-semibold">{m.name}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                  {m.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t py-14 sm:py-16">
          <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
            On the phone
          </h2>
          <div className="mt-7 grid gap-x-10 gap-y-8 sm:grid-cols-3">
            <div>
              <h3 className="text-[15px] font-semibold">For families</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                The portal as an app, on Android and iPhone. Fees, attendance,
                homework, circulars and the bus, without a browser in the way.
              </p>
            </div>
            <div>
              <h3 className="text-[15px] font-semibold">For drivers</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                The bus tracker turns the driver's own handset into the vehicle's
                GPS for the length of a run, and collects nothing between runs.
              </p>
            </div>
            <div>
              <h3 className="text-[15px] font-semibold">For the office</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                A spare handset with a SIM becomes the school's SMS sender, so
                messages reach families without a gateway contract.
              </p>
            </div>
          </div>
          <a
            href="/apps"
            className="mt-7 inline-block text-[14px] font-medium text-[hsl(var(--primary))] underline underline-offset-4"
          >
            Download the apps
          </a>
        </section>
      </main>

      <footer className="mx-auto max-w-5xl px-6 py-10 text-[13px] text-[hsl(var(--muted-foreground))]">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-6">
          <span>EDU CLOUD</span>
          <a href="/login" className="transition-colors hover:text-[hsl(var(--foreground))]">Sign in</a>
          <a href="/buy" className="transition-colors hover:text-[hsl(var(--foreground))]">Pricing</a>
          <a href="/apps" className="transition-colors hover:text-[hsl(var(--foreground))]">Apps</a>
          <a href="/forgot" className="transition-colors hover:text-[hsl(var(--foreground))]">
            Forgotten your password
          </a>
        </div>
      </footer>
    </div>
  )
}

/* The mark, drawn rather than fetched: an image on the front door is a
   request the page has to wait for, and this page must be complete on the
   first paint. */
function Mark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[22px]" aria-hidden="true">
      <path
        d="M4 9.5 12 5.5l8 4-8 4-8-4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 11.4v3.9c0 1.2 2 2.2 4.5 2.2s4.5-1 4.5-2.2v-3.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
