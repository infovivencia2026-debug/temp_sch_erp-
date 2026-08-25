# What the words mean

Terms this product uses, in the sense it uses them.

**Workspace** — the top grouping in the sidebar, like Fees or Academics. A role
owns workspaces; a workspace holds sections; a section holds screens.

**Section** — the grey heading inside a workspace. Purely a grouping; it is not
something you can open.

**Scope** — the boundary on what a screen can see. Not the same as permission.
Permission decides whether you may open a screen; scope decides which rows are
in it. A teacher and a principal can both open a register; the teacher sees
their own sections, the principal sees the school. This is enforced in the
database, not in the page, so it holds however the screen is reached.

**On roll** — students currently enrolled. The denominator for most counts.

**In arrears** — a student with fees outstanding past their due date.

**Fee head** — one chargeable item: tuition, transport, a lab fee. A **fee
structure** is the set of heads a class is charged.

**Concession** — a reduction granted to a family against their fee. Above a
threshold it needs a second sign-off rather than being applied by whoever
raises it.

**Day book** — the day's receipts, the thing a counter is reconciled against
at the end of a session.

**Class teacher** — the teacher who owns a section's register and its remarks,
distinct from a subject teacher who teaches into it. Several screens are
visible only to the class teacher of the section.

**APAAR** — the national student identifier captured at admission, alongside
Aadhaar.

**UDISE** — the government school return. The Compliance screens exist to
produce it from the data already in the system.

**TC / Transfer Certificate** — the document a child brings from a previous
school, and the one this school issues when they leave.

**PTM** — parent–teacher meeting, and the screens for scheduling and recording
one.

**Catalogued** — a feature that has a permission, a data scope and a place in
the navigation, but no screen yet. It renders a page saying so rather than
showing invented numbers.

**Institution** — one school in the system. Every row of data belongs to
exactly one, and the database refuses to return rows belonging to another,
whatever the query asks for.

**Platform admin** — an account that can act across institutions, used for
support and for the seller's own screens. Ordinary school accounts, including
the Principal's, are not platform admins.
