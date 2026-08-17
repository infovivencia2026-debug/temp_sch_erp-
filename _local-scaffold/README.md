# School ERP

A multi-tenant K–12 school ERP for Indian schools. Go modular monolith,
PostgreSQL, Redis, S3-compatible storage.

Architecture and requirements live in [docs/](docs/) — read
[docs/01-product-architecture.md](docs/01-product-architecture.md) first.

**Status: Phase 1 foundation + core SIS.** Working and tested: authentication,
RBAC, multi-tenancy, audit, schools, and the student information system —
students, guardians, academic structure and enrollment, with scope rules for
teachers and parents. Not built yet: admissions, attendance, timetable,
examinations, finance, HR, and everything after.
See [the roadmap](docs/05-india-design-roadmap.md#p-implementation-roadmap).

## Running it locally

Requires Go 1.23+, PostgreSQL 16+, and Redis (or Valkey).

```bash
make setup      # create the database and the unprivileged app role
make migrate    # apply the schema
make seed       # load development data
make run        # start the API on :8080
```

Then sign in as any seeded user with the password `Password123!`:

| Email | Role | Scope |
|---|---|---|
| `priya.nair@vidyaniketan.test` | org_admin | organisation-wide |
| `radhika.menon@vidyaniketan.test` | principal | VNPS-HYD |
| `suresh.kumar@vidyaniketan.test` | accountant | VNPS-HYD |
| `anitha.reddy@vidyaniketan.test` | teacher | VNPS-HYD |
| `deepak.varma@vidyaniketan.test` | school_admin | VNPS-SEC |
| `lakshmi.rao@vidyaniketan.test` | auditor | organisation-wide |
| `ramesh.chowdary@example.test` | parent | two children, in different classes |

The seed builds a real school: 13 classes from Nursery to Class 10, 23 sections,
~525 students with guardians, and Anitha as class teacher of Class 6A. The second
school is left deliberately empty — it is what proves a principal at one school
sees none of the other's students.

```bash
curl -c jar -X POST localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"priya.nair@vidyaniketan.test","password":"Password123!"}'

curl -b jar localhost:8080/api/v1/schools
```

Run `make help` for the rest.

## Why the application does not connect as the database owner

`make setup` creates a separate, unprivileged `schoolerp_app` role, and the
application connects as that. This is not tidiness — PostgreSQL lets a superuser
*and the table owner* bypass row-level security. Running the app as the owner
would silently disable every tenant-isolation policy in the schema without
producing a single error. Migrations run as the owner; the app runs as the
tenant-constrained role.

`TestRowLevelSecurityFailsClosed` in [tests/](tests/) asserts this: with no
organisation bound to the connection, the app role must see zero rows.

## Layout

```
cmd/api           HTTP server; also `migrate` and `seed` subcommands
cmd/worker        background jobs (Asynq) and the outbox relay
internal/         domain modules — each owns its handlers, service,
                  repository, policy and tests
pkg/              infrastructure with no domain knowledge:
                  database, auth, rbac, httpx, queue, observability, config
migrations/       forward-only SQL, embedded into the binary
tests/            integration and authorization suites (real Postgres, real Redis)
docs/             architecture and requirements
```

A module may import `pkg/*` and another module's exported interface — never
another module's repository or tables.

## The three authorization gates

Every request passes all three, server-side, deny by default:

1. **Tenant** — is this row in the caller's organisation? Enforced by RLS on the
   connection, not by remembering a `WHERE` clause.
2. **Grant** — do the caller's roles carry the permission? Declared per route in
   the handler.
3. **Scope** — does the caller's scope cover *this* object? Checked in the
   service, against the row it actually loaded.

Gates 2 and 3 fail differently on purpose: `PERMISSION_DENIED` means you lack the
permission, `OUT_OF_SCOPE` means you have it but not over this object. Conflating
them makes support impossible.

### Scope is derived from data, never from the request

A permission can say "may read students". It cannot say "only my own children" —
so that lives in [internal/sis/scope.go](internal/sis/scope.go), resolved per
request from the database:

| Role | Sees | Derived from |
|---|---|---|
| org admin, auditor | everything in the organisation | membership |
| principal, accountant | everything in their school | membership |
| class / subject teacher | students in the sections they teach | `section_teachers` |
| parent | their own children | `student_guardians` → `guardians.user_id` |
| student | themselves | `students.user_id` |

Two consequences worth knowing. Moving a teacher's class allocation moves their
data access with it — no grant to remember to revoke. And a student outside your
scope returns **404, not 403**: confirming a student exists would let a parent
probe for another family's admission number.

## Testing

```bash
make test-unit          # no external dependencies
make test-integration   # real PostgreSQL and Redis
```

The integration suite creates its own database and seeds it. It asserts, among
other things, that a foreign tenant reads zero rows from every table, that the
application role cannot UPDATE or DELETE `audit_logs`, and that a failed write
leaves no orphan audit entry behind.

## Configuration

Copy `.env.example` to `.env`. Required values have no fallback: the process
refuses to start rather than quietly defaulting to localhost. `TRUSTED_PROXIES`
is empty by default — Gin otherwise believes any `X-Forwarded-For` it is sent,
which would let a caller choose the IP recorded in the audit log.
