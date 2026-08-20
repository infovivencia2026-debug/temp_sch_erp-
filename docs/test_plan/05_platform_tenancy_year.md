# Acceptance tests 05 — Platform, tenancy and the year

## Scope

This file covers the three chains that hand work between Seller Admin, Super Admin
(platform operator) and Institution Admin: **selling and provisioning a school**,
**keeping one school's data out of another's**, and **running the academic year**.
Every test below is grounded in an endpoint registered in `internal/api/api.go` or a
screen in `web/src/features/`, cited by file and line. The tenant-isolation tests come
first because they are the property the whole product rests on and every one of them is
a negative test: the pass condition is that nothing comes back. Where
`docs/gap_analysis/00_TIMELINE.md` or `04_rollover_and_seller.md` records that a chain
is cut, the test says so under **Known gap** and states the observed behaviour rather
than pretending it passes — those tests are written so that a fix turns them green
without rewriting them. Line numbers are against the working tree at the time of
writing; the gap analysis cites some handlers at older offsets (e.g. `promoteStudents`
is at `mod_academics.go:739`, not `:524`), and the numbers here are the current ones.

**Standing fixtures.** Unless a test says otherwise, assume two tenants provisioned
through `POST /api/v1/seller/tenants` (`internal/api/seller.go:196`):

- **School A** — "Kendriya Vidyalaya Bowenpally", plan `complete`, admin `admin-a`.
- **School B** — "St Ann's High School", plan `starter`, admin `admin-b`.
- **Vendor** — a `seller_admin` / platform account holding `platform.tenants.write`,
  `PlatformAdmin = true`, `institution_id = NULL`.

Each school has at least one academic year, two classes, four sections, twenty
students, one exam with marks, and a fortnight of attendance.

---

# Part 1 — Tenant isolation (PL-01 … PL-12)

Every table carries `FORCE ROW LEVEL SECURITY` (188 statements across `migrations/`)
with the policy

```sql
CREATE POLICY tenant_isolation ON <table>
  USING      (app_is_platform_admin() OR institution_id = app_current_institution())
  WITH CHECK (app_is_platform_admin() OR institution_id = app_current_institution());
```

— `migrations/00001_baseline.sql:3239` onward. The GUCs are set by
`database.InTenant` (`internal/database/db.go:70`) with `set_config(..., true)`, i.e.
transaction-local, and `AsPlatform` (`:116`) is `InTenant` with `PlatformAdmin: true`.
The disjunct `app_is_platform_admin()` is what makes PL-06 through PL-09 necessary.

---

### PL-01 · A school administrator cannot fetch another school's student by id

| | |
|---|---|
| **Roles** | Institution Admin (School A), Institution Admin (School B) |
| **Features** | `institution_admin.students.*`, `student.exams_results.academic_record` |
| **Endpoints** | `GET /api/v1/students/{id}` → `getStudent` `internal/api/students.go:167`; route `internal/api/api.go:85` |

**Setup.** Two tenants. Note the UUID of a School B student, `SID_B`, taken directly
from the database.

**Steps.**
1. Sign in as School A's administrator.
2. `GET /api/v1/students/{SID_B}`.
3. Repeat as School B's administrator with a School A student id.

**Expected.** 404 (or the handler's not-found path) in both directions. The row is
invisible to the query, not merely filtered in Go — confirm by checking the server log
shows no permission denial, i.e. RLS returned zero rows rather than RBAC refusing.

**Negative.** The one case that must fail loudly: if either call returns 200 with a
name, stop the release. Also try `GET /api/v1/students/{SID_B}?institution_id={B}` —
the query parameter is only honoured for platform accounts
(`internal/api/acting.go:42`), so it must change nothing.

---

### PL-02 · Search does not span tenants

| | |
|---|---|
| **Roles** | Institution Admin (School A) |
| **Endpoints** | `GET /api/v1/students?q=` → `listStudents` `internal/api/students.go:43`; the search predicate is `students.go:95-97` |

**Setup.** Create a student in School B named "Zulfiqar Ahmed" — a name that exists
nowhere in School A.

**Steps.**
1. As School A's administrator, `GET /api/v1/students?q=Zulfiqar`.
2. `GET /api/v1/students?q=` (empty), and read `total` in the response envelope.

**Expected.** Step 1 returns `items: []`, `total: 0`. Step 2's `total` equals School A's
own active roll and nothing more. Note that `listStudents` names **no** `institution_id`
predicate — the count at `students.go:106` is `SELECT count(*)` over the same `FROM`
clause — so this test is exercising RLS alone, which is exactly why PL-08 exists.

**Negative.** Sign in as a School A *teacher* and repeat: `resolveScope` /
`StudentPredicate` (`students.go:102`) must further narrow to the sections they teach.
Tenant isolation and scope narrowing are different guarantees; both must hold.

---

### PL-03 · Counts and aggregates do not span tenants

| | |
|---|---|
| **Roles** | Institution Admin |
| **Features** | `super_admin.platform_configuration.audit_log`, `institution_admin.academics.attendance_monitoring` |
| **Endpoints** | `GET /api/v1/admin/audit/summary` → `getAuditSummary` `internal/api/audit.go:275`; `GET /api/v1/principal/dashboard` `internal/api/api.go:236` |

**Setup.** Generate 50 audited mutations in School B and none in School A for the last
24 hours.

**Steps.**
1. As School A's administrator, `GET /api/v1/admin/audit/summary`.
2. As School A's administrator, `GET /api/v1/principal/dashboard`.

**Expected.** Step 1's per-entity counts reflect School A only; the 50 School B rows do
not appear in any bucket. Step 2's headline numbers match School A's own roll.

**Negative.** An aggregate is the most dangerous leak because it does not name a child
and so does not look like a breach. If School A's audit summary count rises when School
B is busy, that is a fail even though no row was displayed.

---

### PL-04 · CSV export does not span tenants

| | |
|---|---|
| **Roles** | Institution Admin |
| **Endpoints** | `GET /api/v1/export/{name}` → `exportCSV` `internal/api/export.go:154`; allow-list `internal/api/export.go:24-148`; route `internal/api/api.go:178` |

**Setup.** Both tenants populated. School A's roll = 20, School B's = 20.

**Steps.**
1. As School A's administrator, `GET /api/v1/export/students`.
2. Repeat for `defaulters`, `collections`, `attendance`, `staff`, `udise`.

**Expected.** Each file contains exactly School A's rows (20 data rows for `students`),
a UTF-8 BOM, and no marker line `# EXPORT FAILED`.

**Negative.** None of the six queries in `exportable` names `institution_id` — they
depend entirely on RLS. That is correct for a school user and is the exact seam PL-08
attacks.

---

### PL-05 · The audit trail is the school's own

| | |
|---|---|
| **Roles** | Institution Admin (School A), Institution Admin (School B) |
| **Features** | `super_admin.platform_configuration.audit_log` |
| **Endpoints** | `GET /api/v1/admin/audit` → `listAudit` `internal/api/audit.go:250`; route `internal/api/api.go:640`, gated on `rbac.AuditRead`; screen `web/src/features/super_admin/AuditLog.tsx` |

**Setup.** In School B, change a student's name (an audited mutation).

**Steps.**
1. As School A's administrator, `GET /api/v1/admin/audit?limit=500`.
2. Filter by the School B actor's user id: `GET /api/v1/admin/audit?actor={B_USER}`.

**Expected.** Neither call returns the School B mutation. Step 2 returns an empty list
rather than an error — a filter on a foreign actor is not a lookup that should confirm
the actor exists.

**Negative.** `listAudit` names no `institution_id` predicate (`audit.go:257-263`).
Confirm with a vendor account in PL-09 that this is load-bearing.

---

### PL-06 · A vendor support ticket can never name a child, and a school sees only its own

| | |
|---|---|
| **Roles** | Institution Admin (School A), Seller Admin |
| **Features** | `seller_admin.support.support_tickets` |
| **Endpoints** | `POST /api/v1/admin/platform/support/tickets` → `raiseVendorTicket` `internal/api/platform_config.go:2968`; `GET .../support/tickets` → `listOwnVendorTickets` `:2923`; `GET /api/v1/admin/platform/seller/tickets` → `listVendorTickets` `:2819`; `GET /api/v1/seller/tickets` → `listTickets` `internal/api/seller.go:497`. Constraints: `migrations/00038_platform.sql:636-639` |

**Setup.** School A and School B each raise one vendor ticket. Separately, a parent
grievance naming a student is written with `audience='school'`.

**Steps.**
1. As School A's administrator, `GET .../platform/support/tickets`.
2. As the vendor, `GET /api/v1/seller/tickets`.
3. Attempt directly in SQL to set `audience='vendor'` on the ticket carrying a
   `student_id`.

**Expected.** Step 1 shows School A's ticket only. Step 2 shows both schools' vendor
tickets and **not** the parent grievance — `listTickets` filters `t.audience = 'vendor'`
(`seller.go:511`). Step 3 raises `support_tickets_vendor_never_names_a_child`.

**Negative.** Attempt step 3 through the API by raising a vendor ticket with a
`student_id` in the payload; the database must refuse regardless of what the handler
does.

---

### PL-07 · A message cannot be addressed across tenants

| | |
|---|---|
| **Roles** | Institution Admin (School A) |
| **Features** | `institution_admin.messaging.*` |
| **Endpoints** | messaging routes mounted at `internal/api/api.go` via `s.mountComms(r)` (`api.go:113`) and `s.mountMessaging(r)` (`api.go:623`); handlers `internal/api/messaging.go`, `internal/api/messaging_direct.go` |

**Setup.** Two tenants, each with a guardian and a staff user.

**Steps.**
1. As School A's administrator, compose a message and supply a recipient user id
   belonging to School B.
2. Supply a School B section id as the audience.
3. Read the delivery/outbox listing as School B's administrator.

**Expected.** Steps 1 and 2 resolve to zero recipients or refuse — the recipient
resolution runs inside `InTenant`, so a foreign id matches no row. Step 3 shows nothing
was delivered into School B.

**Negative.** A "sent to 0 recipients, 200 OK" answer is acceptable for isolation but
should be reported separately as a usability defect: the sender is told nothing failed.

---

### PL-08 · **A platform operator acting on a school folds every school into that school's export**

| | |
|---|---|
| **Roles** | Seller Admin / Super Admin (platform operator), then Institution Admin (School A) |
| **Features** | `seller_admin.customers.tenant_directory`, `super_admin.institution_setup.institutions_campuses` |
| **Endpoints** | Middleware `ActingInstitution` `internal/api/acting.go:38` (header `X-Acting-Institution`, `acting.go:31`); `tenantScope` `internal/api/api.go:684`; `GET /api/v1/export/students` → `exportCSV` `internal/api/export.go:154,178`; policy `migrations/00001_baseline.sql:3239` |

**Setup.** Both tenants populated with **distinct** student names so the two rolls can
be told apart in one file. Note the total roll across the installation.

**Steps.**
1. Sign in as the vendor. Confirm `PlatformAdmin = true` and no institution.
2. Open School A from `web/src/features/seller/Tenants.tsx`, which calls
   `setActingInstitution` (`web/src/lib/api.ts:41`) so every later request carries
   `X-Acting-Institution: {A}` (`web/src/lib/api.ts:58`).
3. `GET /api/v1/export/students` with that header set.
4. Count the rows and look for any School B name.
5. Repeat for `GET /api/v1/export/defaulters` and `GET /api/v1/export/attendance`.

**Expected (the property under test).** The file contains **School A's 20 students and
no others**.

**Observed / Known gap.** `ActingInstitution` amends `id.InstitutionID` in place but
deliberately leaves `PlatformAdmin` true (`acting.go:27-29, 92`). `tenantScope` copies
both into `database.Scope` (`api.go:684`), so `InTenant` sets
`app.is_platform_admin = on` and the policy's first disjunct is satisfied for every
row on the installation. None of the six `exportable` queries names `institution_id`.
The export therefore returns **every school's students in School A's file**. This is
precisely the case `internal/api/integrations_index.go:306-310` names in a comment —
"the explicit predicate is what stops a platform admin — for whom the tenant policy is
wide open — reading the union of every school on the installation into one school's
row" — and the pattern was applied there and not in `export.go`. A fix must either drop
`PlatformAdmin` from the scope once an acting institution is chosen, or add an explicit
`institution_id = $1` to every allow-listed query. **Fail.**

**Negative.** Repeat step 3 as School A's own administrator: the same URL must return
20 rows. If the two differ, the difference is the leak.

---

### PL-09 · The same fold, through the roster, the audit log and the report builder

| | |
|---|---|
| **Roles** | Seller Admin acting on School A |
| **Endpoints** | `GET /api/v1/students` `internal/api/students.go:43`; `GET /api/v1/students/{id}` `:167`; `GET /api/v1/admin/audit` `internal/api/audit.go:250`; `GET /api/v1/admin/audit/summary` `:275`; `GET /api/v1/report-builder/definitions/{id}/run` and `POST /api/v1/report-builder/preview` `internal/api/report_builder.go:901-917` |

**Setup.** As PL-08.

**Steps.**
1. As the vendor with `X-Acting-Institution: {A}`, `GET /api/v1/students?limit=200` and
   read `total`.
2. `GET /api/v1/students/{SID_B}` — a School **B** student id, while acting on A.
3. `GET /api/v1/admin/audit?limit=500`.
4. `POST /api/v1/report-builder/preview` with a definition that counts students.

**Expected.** Step 1's `total` equals School A's roll. Step 2 returns 404. Steps 3 and 4
return School A's rows only.

**Known gap.** Same root cause as PL-08. Step 2 in particular is the one to run first:
if a platform operator who has explicitly named School A can still open a School B
child's record by id, the acting mechanism gives no containment at all, only a default.
Record the observed result for each of the four calls separately — the fix will have to
be verified per handler until the scope itself is corrected.

---

### PL-10 · An acting institution id is verified, not trusted

| | |
|---|---|
| **Roles** | Seller Admin |
| **Endpoints** | `ActingInstitution` `internal/api/acting.go:62-77`; `GET /api/v1/admin/institutions` → `listInstitutions` `internal/api/acting.go:111` |

**Steps.**
1. As the vendor, send any authenticated request with `X-Acting-Institution: not-a-uuid`.
2. Send one with a well-formed UUID that matches no institution.
3. Suspend School B (PL-21), then send one with School B's id.
4. `GET /api/v1/admin/institutions` with no acting header.

**Expected.** (1) 400 `institution_id must be a uuid`. (2) 404. (3) 404 — the check is
`status = 'active'` (`acting.go:68`), so a suspended tenant cannot be entered. (4) 200
with every school on the installation, and only for a caller with `PlatformAdmin`
(`acting.go:113`).

**Negative.** Call `GET /api/v1/admin/institutions` as School A's administrator: must be
403 with "only a platform operator can list every school".

---

### PL-11 · The acting header is inert for an ordinary user

| | |
|---|---|
| **Roles** | Institution Admin (School A), Faculty (School A) |
| **Endpoints** | `ActingInstitution` `internal/api/acting.go:41-45` |

**Steps.**
1. As School A's administrator, send `GET /api/v1/students` with
   `X-Acting-Institution: {B}`.
2. Repeat with `?institution_id={B}` in the query string (`acting.go:49`).
3. Repeat as a School A teacher.

**Expected.** All three return School A's data unchanged. The middleware returns before
reading the header when `!id.PlatformAdmin`, so the header must have no effect at all —
not even a 400 for a malformed value.

**Negative.** Send a malformed header as a school user: still 200, still School A. If a
school user can provoke the 400 from `acting.go:58`, the guard has moved and this test
should fail.

---

### PL-12 · One sign-in identifier, two tenants

| | |
|---|---|
| **Roles** | Institution Admin (School A), Institution Admin (School B) |
| **Endpoints** | `authenticate` `internal/auth/handler.go:152-183` |

**Setup.** Give School A's and School B's administrators the **same** email address.
`users` is unique per institution (`users_institution_email`), so both rows exist.

**Steps.**
1. Attempt to sign in with that email and School A's password.
2. Attempt with School B's password.
3. Inspect the server log.

**Expected.** Both attempts are refused (`matches != 1` → `pgx.ErrNoRows` →
`ErrMismatch`, `handler.go:174-176`), and the log carries
`ambiguous login identifier across tenants` with the match count
(`handler.go:187-189`). This is the correct safe direction — signing whichever row
sorted first into the wrong school would be the worst isolation failure in the product.

**Negative.** Confirm that the timing of a refused ambiguous login is indistinguishable
from a wrong password: `dummyHash` is verified on the miss path (`handler.go:150, 188`).

**Note for the report.** This is a real operational constraint, not only a test: two
schools on one installation cannot share a principal's email. It belongs in the
onboarding checklist that does not yet exist (PL-24).

---

# Part 2 — Impersonation (PL-13 … PL-16)

`impersonation_grants` (`migrations/00038_platform.sql:474`) is the best-designed table
in the seller tier: a mandatory reason of at least eight characters, a four-hour cap
enforced by a CHECK, the operator's name denormalised so it survives account deletion,
and RLS placing the row in the *school's* tenant so the school can audit the vendor.

---

### PL-13 · A support session needs a reason, and the reason is enforced twice

| | |
|---|---|
| **Roles** | Seller Admin |
| **Features** | `seller_admin.support.impersonation_audit` |
| **Endpoints** | `POST /api/v1/admin/platform/impersonation` → `openImpersonation` `internal/api/platform_config.go:3137`; handler check `:3151-3157`; constraint `impersonation_grants_reason` `migrations/00038_platform.sql:508`; screen `web/src/features/seller/Impersonation.tsx` |

**Steps.**
1. As the vendor, POST with `reason: ""`.
2. POST with `reason: "  fix  "` (five characters after trim).
3. POST with `reason: "reproducing the fee receipt fault in ticket 412"`.
4. Bypass the handler and `INSERT INTO impersonation_grants` directly with a
   three-character reason.

**Expected.** (1) and (2) 400 with "say why you are entering this school…". (3) 201 with
the grant echoed back. (4) rejected by `impersonation_grants_reason`
(`length(btrim(reason)) >= 8`).

**Negative.** Step 4 is the important one: the handler check must not be the only one.
If a direct insert succeeds, the schema has drifted from `00038_platform.sql`.

---

### PL-14 · A support session cannot outlive four hours

| | |
|---|---|
| **Roles** | Seller Admin |
| **Endpoints** | `openImpersonation` `internal/api/platform_config.go:3158-3164` (default 60, refuse > 240); constraint `impersonation_grants_window` `migrations/00038_platform.sql:509-510` |

**Steps.**
1. POST with `minutes: 0` (omitted).
2. POST with `minutes: 241`.
3. POST with `minutes: 240`.
4. Directly `INSERT` a grant with `expires_at = started_at + interval '6 hours'`.
5. Open a second session for the same operator against a different school while the
   first is live.

**Expected.** (1) grant created with `expires_at = now() + 1 hour`. (2) 400 "a support
session may not exceed four hours". (3) 201, `expires_at - started_at = 4h`. (4)
rejected by `impersonation_grants_window`. (5) the first grant is closed with
`ended_reason = 'superseded by a new session'` (`platform_config.go:3188-3195`) — an
operator may hold exactly one live grant.

**Negative.** Step 4 must fail even as the pool's `app_user`; `FORCE ROW LEVEL SECURITY`
does not exempt CHECK constraints, and neither should any migration.

---

### PL-15 · The school audits the vendor, and can end the session

| | |
|---|---|
| **Roles** | Seller Admin, then Institution Admin (School A) |
| **Features** | `seller_admin.support.impersonation_audit`, `super_admin.platform_configuration.audit_log` |
| **Endpoints** | `GET /api/v1/admin/platform/impersonation` → `listImpersonationGrants` `internal/api/platform_config.go:3075`; `GET .../{id}/activity` → `getImpersonationActivity` `:3317`; `POST .../{id}/end` → `endImpersonation` `:3243`. All three admit `rbac.AuditRead` **or** `rbac.PlatformTenantsRW` (`platform_config.go:69, 149-154`). Screen: `web/src/features/seller/Impersonation.tsx` |

**Setup.** Vendor opens a grant on School A with a ticket link, then, acting on School A,
makes two audited changes (e.g. updates a student). School B has its own grant from a
different session.

**Steps.**
1. As School A's administrator, `GET .../platform/impersonation`.
2. Read `operator`, `reason`, `started_at`, `expires_at`, `live` and `changes`.
3. `GET .../platform/impersonation/{grant}/activity` and read `covers`.
4. `POST .../platform/impersonation/{grant}/end` with a reason.
5. As School A's administrator, `POST .../{School_B_grant_id}/end`.
6. As the vendor with no acting institution, `GET .../platform/impersonation`.

**Expected.** (1)-(2) School A sees **its own** grant and not School B's — the query
carries no tenant filter (`platGrantSelect`, `platform_config.go:3042`) and relies on
running through `InTenant` (`:3103`). `operator` is a readable name because it is
denormalised, not joined (`00038_platform.sql:481-489`). `changes` = 2. (3) `covers`
states plainly that reads are not recorded. (4) 200 `{"ended": true}`; the grant is no
longer `live`. (5) 404 — RLS refuses another school's grant id before the handler sees
it (`platform_config.go:3271-3278`). (6) the vendor sees every grant on the
installation via `AsPlatform` (`:3100-3101`).

**Negative.** After step 4, confirm the vendor's next acting request is **not** blocked
— see PL-16.

---

### PL-16 · An expired or absent grant does not stop the vendor entering the school

| | |
|---|---|
| **Roles** | Seller Admin, Institution Admin (School A) |
| **Endpoints** | `ActingInstitution` `internal/api/acting.go:38-95`; `openImpersonation` docstring `internal/api/platform_config.go:3131-3135` |

**Setup.** No live grant for the operator on School A.

**Steps.**
1. As the vendor, **without** calling `POST .../platform/impersonation` at all, send
   `GET /api/v1/students` with `X-Acting-Institution: {A}`.
2. Open a grant, end it via PL-15 step 4, then repeat the same request.
3. Open a grant with `minutes: 1`, wait until `expires_at` passes, repeat.
4. As School A's administrator, `GET .../platform/impersonation` and look for a row
   covering the requests made in steps 1-3.

**Expected (the property under test).** Steps 1-3 are refused, or at minimum recorded.
Step 4 shows a grant covering every minute the vendor spent inside the school.

**Observed / Known gap.** `ActingInstitution` consults `institutions` only
(`acting.go:66-69`) and never reads `impersonation_grants`. The handler's own docstring
says so: *"This does not itself grant access — X-Acting-Institution in
internal/api/acting.go still does that… see the handover for the exact amendment"*
(`platform_config.go:3132-3135`), and `migrations/00038_platform.sql:460-465` describes
the same missing half. So all three requests succeed and step 4 shows nothing for step
1's activity. What the school *can* see is the mutation trail, because `acting.go:92`
amends the identity in place so `AuditMiddleware` stamps the right `institution_id` —
but a read-only visit leaves no record at all. **Fail. The register is a control the
door does not consult.** The fix is a lookup in `ActingInstitution` for a live grant on
`(operator_user_id, institution_id)`; this test turns green when it lands.

---

# Part 3 — Seller → school lifecycle (PL-17 … PL-25)

---

### PL-17 · A sale becomes a tenant in one transaction, with credentials that work

| | |
|---|---|
| **Roles** | Seller Admin, then the school's first Institution Admin |
| **Features** | `seller_admin.customers.provision_new_school`, `seller_admin.customers.tenant_directory` |
| **Endpoints** | `POST /api/v1/seller/tenants` → `provisionTenant` `internal/api/seller.go:196` → `provisionSchool` `internal/api/provision.go:90`; `GET /api/v1/seller/tenants` → `listTenants` `internal/api/seller.go:66`; `GET /api/v1/seller/plans` → `listPlans` `:135`. Screen `web/src/features/seller/Tenants.tsx`. Route group `internal/api/api.go:598`, gated on `rbac.PlatformTenantsRW` |

**Setup.** A vendor account. `plans` seeded from `migrations/00011_seller.sql:16`
(`starter`, `standard`, `complete`).

**Steps.**
1. As the vendor, `GET /api/v1/seller/plans` and confirm three plans with prices and
   module lists.
2. `POST /api/v1/seller/tenants` with school name, `plan_code: "standard"`, admin name
   and email, `trial_days: 30`.
3. Read the 201 body: `institution_id`, `sign_in_as`, `password`, the handover note.
4. Repeat step 2 with the same school name.
5. Repeat with `plan_code: "enterprise"`.
6. Sign in to the new tenant with the returned credentials.
7. As the new administrator, `GET /api/v1/catalog` and confirm a populated navigation.
8. `GET /api/v1/seller/tenants` and find the new school.

**Expected.** (3) one institution, one campus named "Main Campus"
(`provision.go:139-141`), one user, the full `institution_admin` role bundle seeded per
tenant (`provision.go:160-177`), and a `trial` subscription with
`trial_ends_on = CURRENT_DATE + 30` (`provision.go:221-228`). (4) 409 `name_taken`.
(5) 400 "that plan does not exist". (6) sign-in succeeds. (7) the menu is not empty —
`SeedCatalogRoles` (`provision.go:168`) is what makes this true; a school with
capabilities and no catalogue roles gets a working API and a blank screen. (8) the new
school appears with `setup_percent` low and `students: 0`.

**Negative.** Provoke a failure mid-provision (e.g. an admin email already used in the
same tenant, `errContactTaken` `provision.go:232`) and confirm **no** institution row
survives. A half-built tenant looks like a customer in every report and cannot be signed
into.

---

### PL-18 · The plan decides which modules exist, and the school sees exactly those

| | |
|---|---|
| **Roles** | Seller Admin, Institution Admin |
| **Features** | `seller_admin.entitlements.module_entitlement_matrix`, `super_admin.platform_configuration.module_configuration` |
| **Endpoints** | `entitlement.ApplyPlan` `internal/entitlement/entitlement.go:274`, called at `provision.go:187` and `seller.go:341`; `GET /api/v1/catalog` → filter at `internal/api/catalog.go:116`; `GET/PUT /api/v1/admin/platform/entitlements` → `getEntitlementMatrix` `internal/api/platform_config.go:3734`, `setEntitlement` `:3854` (both gated on `rbac.PlatformPlansRW`, `platform_config.go:159-160`); screen `web/src/features/seller/Entitlements.tsx` |

**Setup.** School B on `starter`, whose module list is
`students, academics, attendance, fees, communication`
(`migrations/00011_seller.sql:18-19`) — i.e. **no** exams, HR, transport, library,
hostel or inventory.

**Steps.**
1. As School B's administrator, `GET /api/v1/catalog`.
2. Look for sections with slug `library`, `hostel`, `stores`, `transport`,
   `examinations`, `payroll` (the mapping is `entitlement.go:62-118`).
3. As the vendor, `GET /api/v1/admin/platform/entitlements` and read School B's
   `plan_modules`, `enabled` and `beyond_plan`.
4. `PUT /api/v1/seller/tenants/{B}/subscription` with `plan_code: "complete"`.
5. As School B's administrator, `GET /api/v1/catalog` again.

**Expected.** (1)-(2) the excluded sections are **absent**, not greyed out — the code
comment at `catalog.go:112-115` is the acceptance criterion: "A module the school did
not buy is absent… A disabled control that never becomes enabled is an advert wearing
the clothes of a feature". (3) `enabled` matches `plan_modules`; `beyond_plan` is empty
for a freshly provisioned school. (4) `setSubscription` re-applies the plan
(`seller.go:337-344`). (5) every section is now present — `complete` stores an empty
module array, which `entitlement.go:232` reads as "all".

**Negative.** After step 4, downgrade back to `starter` and confirm the modules are
switched **off** again — `ApplyPlan` writes `enabled=false` rows explicitly rather than
deleting them (`entitlement.go:289-298`), so a downgrade must actually remove access.
This is the test that catches "upgrade works, downgrade does not".

---

### PL-19 · The paywall: what a school that is not paying actually sees

| | |
|---|---|
| **Roles** | Seller Admin, Institution Admin |
| **Endpoints** | `RequireSubscription` `internal/api/gate.go:72`, mounted `internal/api/api.go:56`; `entitlement.Resolve` `internal/entitlement/entitlement.go:191`; allow-list `gate.go:63-69`; `PUT /api/v1/seller/tenants/{id}/subscription` → `setSubscription` `internal/api/seller.go:298` |

**Setup.** School B, and a third tenant School C provisioned with no `plan_code` at all
(so `subscriptions` has no row).

**Steps.**
1. As School C's administrator, `GET /api/v1/session`, `GET /api/v1/catalog`,
   `GET /api/v1/profile`, `GET /api/v1/ref-data`.
2. As School C's administrator, `GET /api/v1/students`.
3. As the vendor, set School B to `past_due`; as School B's administrator,
   `GET /api/v1/students`.
4. Set School B to `suspended`; repeat.
5. Set School B's status to `trial` with `trial_ends_on` yesterday (direct update);
   repeat.
6. As School B's administrator while locked, `POST /api/v1/profile/password`.

**Expected.** (1) all four succeed — a locked school must still be able to render the
shell and read the notice (`gate.go:30-35`). (2)-(5) HTTP **402**, body
`{"code": "subscription_none|past_due|suspended|expired", "message": ...}` with the
message written for a head teacher, not a log (`entitlement.go:213-262`). 402 and not
403 is deliberate (`gate.go:37-40`) — verify the code, because a 403 sends an
administrator hunting through role assignments. (5) confirms the trial is checked at
request time, not by a nightly job (`entitlement.go:239-246`). (6) succeeds — being
unable to change your password because an invoice is late is absurd (`gate.go:34-35`).

**Negative.** Platform staff are never gated: as the vendor with no institution,
`entitlementFor` returns `entitlement.Platform()` (`gate.go:46-48`). Confirm the vendor
can still work inside a suspended school's *seller* screens — though note PL-10 step 3,
where a suspended tenant cannot be entered via the acting header at all.

---

### PL-20 · The module paywall is a menu, not a lock

| | |
|---|---|
| **Roles** | Institution Admin (School B, `starter`) |
| **Endpoints** | `RequireSubscription` `internal/api/gate.go:95` (checks `st.Active` only); `State.Allows` `internal/entitlement/entitlement.go:155`, whose **only** caller is `internal/api/catalog.go:116`; library routes `internal/api/api.go:544-547`; hostel/inventory routes `api.go:584-591` |

**Setup.** School B on `starter` — library, hostel, inventory, transport, exams and HR
are not in the plan. Its administrator holds the corresponding RBAC permissions, because
entitlement and permission are deliberately separate concerns (`entitlement.go:10-19`).

**Steps.**
1. As School B's administrator, `GET /api/v1/catalog` and confirm the library section is
   absent (PL-18).
2. With a session cookie and curl, `GET /api/v1/ops/library/audits`.
3. `POST /api/v1/ops/inventory/movements` with a valid body.
4. `GET /api/v1/exams/list`.

**Expected (the property under test).** 402 with `subscription_*` or an equivalent
module-level refusal on steps 2-4.

**Observed / Known gap.** `RequireSubscription` branches on `st.Active` and nothing
else; `Allows` is never consulted outside the catalogue. So steps 2-4 return **200** and
School B can use, via the API, every module it did not buy. This directly contradicts
`gate.go:24-28`: *"Enforcement lives here rather than in the catalog, because a catalog
is a menu and a menu is not a lock… every one of these endpoints is reachable with curl
and a session cookie."* The subscription lock honours that; the module lock does not.
**Fail.** The fix is a section-slug lookup in `RequireSubscription` (the route → section
mapping is the missing piece, not the entitlement logic, which already works).

---

### PL-21 · Suspension and reactivation

| | |
|---|---|
| **Roles** | Seller Admin, Institution Admin |
| **Features** | `seller_admin.customers.suspend_reactivate` |
| **Endpoints** | `PUT /api/v1/seller/tenants/{id}/subscription` → `setSubscription` `internal/api/seller.go:298`, institution status at `:346-356`; screen `web/src/features/seller/Tenants.tsx` |

**Steps.**
1. As the vendor, set School B's subscription `status: "suspended"`.
2. Check `institutions.status` for School B.
3. As School B's administrator, attempt to sign in.
4. Once signed in, `GET /api/v1/students`.
5. As the vendor, attempt `X-Acting-Institution: {B}`.
6. Set School B back to `active`; check `institutions.status` and repeat steps 3-4.
7. Confirm School B's data is intact throughout.

**Expected.** (2) `suspended`. (4) 402 `subscription_suspended`. (5) 404 (PL-10). (6)
`active` again and full access restored, with `ApplyPlan` re-run so modules come back
(`seller.go:337-344`). (7) no data was deleted at any point.

**Observed / partial.** Step 3 **succeeds**: `authenticate`
(`internal/auth/handler.go:166-183`) filters on `users.status = 'active'` and never
reads `institutions.status`. So a suspended school's users still sign in and are then
met by the 402. That is arguably the intended behaviour given `gate.go:15-22` — but the
comment at `seller.go:346` says "A suspended subscription must actually lock the door",
and the door it locks is the API, not the login. Record it; it is a documentation
mismatch rather than a defect, and a tester needs to know which answer is correct.

---

### PL-22 · A cancelled subscription is resurrected instead of replaced

| | |
|---|---|
| **Roles** | Seller Admin |
| **Features** | `seller_admin.subscriptions_billing.subscription_ledger` |
| **Endpoints** | `setSubscription` `internal/api/seller.go:316-331`, specifically the `ON CONFLICT (institution_id) WHERE status <> 'cancelled'` at `:321`; `subscriptions` PK `(institution_id)` `migrations/00001_baseline.sql:1946` |

**Setup.** School B, active on `standard`, with `notes` recording the original deal.

**Steps.**
1. As the vendor, set School B `status: "cancelled"`.
2. Read the `subscriptions` row for School B: how many rows, what `plan_code`, what
   `started_on`?
3. Six months later (simulate), set School B `plan_code: "complete"`, `status: "active"`.
4. Read `subscriptions` again.
5. `GET /api/v1/seller/tenants` and check School B's plan and renewal date.

**Expected (the property under test).** Step 4 shows **two** rows — the cancelled
history and the new deal — or at minimum an event record of the churn and the return.

**Observed / Known gap.** `subscriptions` has `PRIMARY KEY (institution_id)`, so there
can only ever be one row per school. Worse, the arbiter
`ON CONFLICT (institution_id) WHERE status <> 'cancelled'` names a **partial unique
index that does not exist**; Postgres falls back to the primary key, so the `DO UPDATE`
silently **resurrects the cancelled row** rather than inserting a new one. `started_on`
still reads six months earlier, `notes` still carries the old deal, and the churn has
vanished. `listTenants` joins `sub.status <> 'cancelled'` (`seller.go:96`), so before
step 3 School B shows no plan at all. **Fail** — gap analysis
`04_rollover_and_seller.md` §B2 and priority row 13. Also confirm the corollary: there
is no `subscription_ledger`, `subscription_events` or `billing_events` table anywhere in
`migrations/`, and `web/src/features/registry.ts:85-91` routes seven of the twelve
seller features to the same `./seller/Tenants` component. The ledger is the tenant list.

---

### PL-23 · Seat overage and renewal are numbers on a screen

| | |
|---|---|
| **Roles** | Seller Admin |
| **Features** | `seller_admin.subscriptions_billing.seat_overage_renewals` |
| **Endpoints** | `listTenants` `internal/api/seller.go:66`, `OverBy` computed in Go at `:111-113`; `subscriptions.renews_on` index `migrations/00011_seller.sql:51-53`; screen `web/src/features/seller/Tenants.tsx` |

**Setup.** School B licensed for 300 students (`starter`'s `max_students`), with 340
active students. Set `renews_on` to yesterday.

**Steps.**
1. As the vendor, `GET /api/v1/seller/tenants`; read School B's `over_by`.
2. As School B's administrator, admit a 341st student.
3. Wait past `renews_on`, then as School B's administrator use the system normally.
4. Search `cmd/` and the queue jobs for any reader of `renews_on`.

**Expected (the property under test).** (1) `over_by: 40`. (2) refused, or accepted and
recorded as a chargeable true-up. (3) some dunning, grace period or `past_due`
transition. (4) at least one job.

**Observed / Known gap.** (1) passes — `over_by` is correct. (2) succeeds with no
refusal, no record, no charge: the overage is displayed, never persisted or enforced.
(3) nothing happens; `status` moves only when a human calls
`PUT /seller/tenants/{id}/subscription` (`seller.go:298`). (4) nothing reads
`renews_on` — the index exists for the console's own page load. A subscription passes
its renewal date and keeps working until somebody notices. **Fail** —
`04_rollover_and_seller.md` priority rows 8, 9 and 20.

---

### PL-24 · Onboarding, data import and go-live

| | |
|---|---|
| **Roles** | Seller Admin, Institution Admin |
| **Features** | `seller_admin.customers.onboarding_progress`, `super_admin.platform_configuration.import_export` |
| **Endpoints** | `setup_percent` SQL inside `listTenants` `internal/api/seller.go:82-93`; `GET /api/v1/setup/status` → `getSetupStatus` `internal/api/setup.go:948`; `GET /api/v1/setup/import/{entity}/template` and `POST /api/v1/setup/import/{entity}` → `bulkImport` `internal/api/bulk_import.go` (routes `api.go:229-230`); `POST /api/v1/students/import` → `importStudents` `internal/api/students_write.go:378` (route `api.go:88`). Screens `web/src/features/setup/Wizard.tsx`, `web/src/features/setup/Checklist.tsx`, `web/src/features/setup/ImportStudents.tsx` |

**Setup.** A newly provisioned School D with nothing in it, and CSV files from an
incumbent ERP: classes, sections, staff, students, **plus** guardians, fee structures,
opening fee balances, historical marks and attendance history.

**Steps.**
1. As the vendor, `GET /api/v1/seller/tenants`; read School D's `setup_percent`.
2. As School D's administrator, `GET /api/v1/setup/status` and work the wizard.
3. `POST /api/v1/setup/import/classes` with the classes CSV, **without** `?commit=true`.
4. Introduce one bad row and repeat.
5. Repeat with `?commit=true`.
6. Attempt `POST /api/v1/setup/import/guardians`, `.../fee-structures`,
   `.../opening-balances`, `.../marks`, `.../attendance`.
7. Upload an `.xlsx` file to any importer.
8. Re-read `setup_percent`.

**Expected.** (3) a dry-run report: valid/rejected counts and per-row problems with row
numbers — the importer is well built and this must stay true. (4) the whole file is
refused rather than partially written (`bulk_import.go:326-329`). (5) one transaction,
`imported` equals `valid`. (6) each importer exists. (7) accepted or refused with a
clear message. (8) rises in steps of 10.

**Observed / Known gap.** (3)-(5) pass. (6) **fails** — `importSpecs` covers exactly
`classes`, `sections` and `staff`, plus the separate students importer with an 8 MB CSV
cap; there is no importer for guardians, fee structures, **opening fee balances**,
historical marks, attendance history, library catalogue, transport routes or hostel
rooms. (7) fails — no XLSX support anywhere. (8) `setup_percent` is ten `EXISTS` probes
× 10 (`seller.go:82-93`): it is a count of non-empty tables, not a project. There is no
onboarding table, checklist, task, owner, due date, blocker or sign-off, and nothing for
`cutover`, `go_live` or `readiness`. **Fail** — `04_rollover_and_seller.md` §B3, and it
compounds PL-36: a school switching ERPs cannot bring its arrears across by any route.

---

### PL-25 · Go-live day: sixty teachers, one password

| | |
|---|---|
| **Roles** | Seller Admin, Institution Admin |
| **Endpoints** | `provisionSchool` `internal/api/provision.go:145-156` (one user); `POST /api/v1/seller/tenants/{id}/reset-admin` → `resetTenantAdmin` `internal/api/seller.go:368`; `POST /api/v1/admin/users` → `createUser` (route `api.go:635`); `POST /api/v1/setup/employees/{id}/login` → `issueStaffLogin` (route `api.go:217`); `users.status='invited'` `internal/api/admin.go:104` |

**Setup.** School D with 60 employees imported via the `staff` bulk importer.

**Steps.**
1. Count `users` rows in School D immediately after the staff import.
2. As the vendor, `POST /api/v1/seller/tenants/{D}/reset-admin`; confirm the old password
   stops working and the new one is shown once.
3. As School D's administrator, `POST /api/v1/setup/employees/{id}/login` for one teacher
   and hand over the credential.
4. Look for a bulk invitation endpoint: an invite token, an emailed link, a
   set-password-on-first-use flow.
5. Set a user to `status: 'invited'` and attempt to sign in as them.

**Expected (the property under test).** Step 4 finds an invitation mechanism.

**Observed / Known gap.** (1) **one** user — the `staff` importer creates `employees`
rows, not logins. (2) passes. (3) passes, one teacher at a time. (4) **fails** — there
is no invitation table, no invite token, no bulk credentialing, no email delivery path.
(5) the account cannot sign in (`handler.go:168` filters `status = 'active'`) and has no
token with which to activate itself. Day one at a 1,200-pupil school, the ERP has one
working password and a manual issuance loop. **Fail** — `04_rollover_and_seller.md` §B4,
priority row 11. Note also `00_TIMELINE.md` finding 1: `guardians.user_id` is written
only by `cmd/migrate/demo.go`, so **no parent can log in at all** in a real tenant. That
belongs to the parent cluster but it is the same missing mechanism.

---

# Part 4 — The academic year (PL-26 … PL-38)

`academic_years_one_current` (`migrations/00001_baseline.sql:1986`) is a partial unique
index over `(institution_id, COALESCE(campus_id, '000…'))` `WHERE is_current`: exactly
one current year per campus. Roughly twenty call sites resolve "the year" from that
flag. Tests PL-26 to PL-29 are about what happens when a school needs two years alive at
once, which every Indian school does from November.

---

### PL-26 · Creating next year while this year is still teaching

| | |
|---|---|
| **Roles** | Institution Admin |
| **Features** | `super_admin.institution_setup.academic_year_defaults` |
| **Endpoints** | `POST /api/v1/setup/academic-years` → `createAcademicYear` `internal/api/setup.go:60`, the stand-down at `:75-81`; `GET /api/v1/academics/years` → `listAcademicYears` `internal/api/academics.go:78` (route `api.go:121`); index `migrations/00001_baseline.sql:1986` |

**Setup.** School A with 2026-27 current, mid-November, teaching in progress.

**Steps.**
1. As School A's administrator, `POST /api/v1/setup/academic-years` for 2027-28 with
   `is_current: false`.
2. `GET /api/v1/academics/years` and confirm both years exist, one current.
3. `POST` a third year with `is_current: true`.
4. `GET /api/v1/academics/years` again.
5. Attempt a direct `UPDATE academic_years SET is_current = true` on a second year.

**Expected.** (1)-(2) both years exist; 2026-27 is still current. (3) succeeds and
2026-27 is stood down first (`setup.go:77-79`). (4) exactly one `is_current: true`. (5)
rejected by `academic_years_one_current`.

**Negative and Known gap.** Step 3 is the trap. The stand-down is
`UPDATE academic_years SET is_current = false WHERE is_current` — **no `campus_id`
predicate**, so on a multi-campus institution it stands down every campus's current
year, not just this one, while the index permits one per campus. Test this explicitly on
a two-campus tenant. And note the consequence the rest of this section tests: after step
3, the ~20 handlers listed under PL-29 immediately start answering for 2027-28 while the
school is still teaching 2026-27.

---

### PL-27 · Creating next year's sections doubles this year's seat count

| | |
|---|---|
| **Roles** | Institution Admin, Admissions Officer |
| **Features** | `institution_admin.admissions.*` (seat matrix), `super_admin.institution_setup.academic_year_defaults` |
| **Endpoints** | `GET /api/v1/admissions/workflow/seats` → `getSeatMatrix` `internal/api/mod_admissions.go:382` (route `api.go:397`); the offending join is `mod_admissions.go:399-402`; `POST /api/v1/setup/sections` → `createSection` `internal/api/setup.go:~168`; `POST /api/v1/admissions/workflow/applications/{id}/decision` → `decideApplication` `mod_admissions.go:~417`, capacity check at `:437-449` |

**Setup.** School A, 2026-27 current. Class 1 has two sections of 40 = capacity 80,
with 78 active enrolments. Note the seat matrix before anything changes.

**Steps.**
1. `GET /api/v1/admissions/workflow/seats`; record Class 1's `capacity`, `enrolled`,
   `available` and `rte_quota`.
2. Create the 2027-28 academic year (`is_current: false`) as in PL-26.
3. `POST /api/v1/setup/sections` twice for Class 1 with `academic_year_id` = 2027-28,
   capacity 40 each.
4. `GET /api/v1/admissions/workflow/seats` again.
5. Offer a place to a 2026-27 applicant for Class 1 and watch the capacity guard.

**Expected (the property under test).** Step 4's Class 1 row is unchanged from step 1:
capacity 80, available 2, RTE quota 20.

**Observed / Known gap.** `getSeatMatrix` joins `LEFT JOIN sections sec ON sec.class_id
= c.id` (`mod_admissions.go:400`) with **no `academic_year_id` filter** and sums
`sec.capacity` across every year. After step 3, Class 1 reports **capacity 160,
available 82, RTE quota 40** — the statutory 25% reservation is computed off a doubled
intake. Step 5 compounds it: `decideApplication`'s over-sell guard
(`mod_admissions.go:437-449`) uses the identical unfiltered subquery, so the school will
happily offer 82 places into 2 real seats. **Fail** — `00_TIMELINE.md` November row,
`04_rollover_and_seller.md` priority row 2. The fix is one predicate in two places; the
test is written so it turns green when it lands.

---

### PL-28 · Next year's sections cannot be imported

| | |
|---|---|
| **Roles** | Institution Admin |
| **Features** | `super_admin.platform_configuration.import_export` |
| **Endpoints** | `POST /api/v1/setup/import/sections?commit=true` → `bulkImport` `internal/api/bulk_import.go`, year resolution at `bulk_import.go:338-342`; `POST /api/v1/setup/sections` → `createSection` `internal/api/setup.go:174-181` |

**Setup.** School A with 2026-27 current and 2027-28 created but not current
(PL-26 step 1). A CSV of 24 sections for 2027-28.

**Steps.**
1. `GET /api/v1/setup/import/sections/template` and inspect the columns. Is there an
   `academic_year` or `academic_year_id` column?
2. `POST /api/v1/setup/import/sections` (dry run) with the CSV.
3. Repeat with `?commit=true`.
4. Query `sections` and read `academic_year_id` on the 24 new rows.
5. As a control, `POST /api/v1/setup/sections` (single) with an explicit
   `academic_year_id` = 2027-28 and check the row.

**Expected (the property under test).** The 24 rows carry the 2027-28 year id.

**Observed / Known gap.** `bulkImport` resolves the year once per run with
`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`
(`bulk_import.go:340`) and offers **no** override — step 1 finds no year column. All 24
sections land in **2026-27**, silently, and become the doubled capacity of PL-27 in the
wrong direction: they collide with the existing sections on the unique key
`(class_id, academic_year_id, name)` and are absorbed by an upsert, overwriting this
year's capacities. Step 5 is the control and **passes** — `createSection` honours an
explicit `academic_year_id` (`setup.go:174-176`) and only falls back to
`ORDER BY is_current DESC` when it is omitted. So the single-row path is correct and the
bulk path is not, which is the whole finding. **Fail** — `04_rollover_and_seller.md`
§B3, `00_TIMELINE.md` November row.

---

### PL-29 · Flipping `is_current` redirects the whole product at once

| | |
|---|---|
| **Roles** | Institution Admin |
| **Endpoints** | `createAcademicYear` `internal/api/setup.go:77-79`. The readers, all resolving the year from the flag with no override: `admin_academics.go:242,343,638,1818,1948,2414`; `collections.go:1572`; `hpc.go:579`; `library_desk.go:657`; `transport_office.go:257`; `board_exams.go:456`; `infirmary.go:584`; `admin_ops.go:1851`; `hr_growth.go:2691`; `statutory.go:162`; `mdm.go:504`; `bulk_import.go:340`; `mod_admissions.go:566`; `students_write.go:171`; `setup.go:181,537,671`; `timetable_ops.go:168`. The honourable exception: `rollupYear` `admin_rollups.go:201-215`, which takes an explicit `?year=` |

**Setup.** School A mid-year in 2026-27, with fee collection, library issues, transport
allocations and infirmary records being written daily.

**Steps.**
1. Record the current year id. Issue a library book, allocate a transport route, record
   an infirmary visit, take a fee payment. Confirm each row's resolved year is 2026-27.
2. Create 2027-28 with `is_current: true` (the only way to run next year's admissions
   through the handlers that do not accept a year).
3. Repeat every action in step 1, unchanged.
4. Read `academic_year_id` on each new row.
5. `GET /api/v1/admin/rollups/...?year={2026-27 id}` — any endpoint served by
   `rollupYear`.

**Expected (the property under test).** Step 4's rows still carry 2026-27, because the
school is still teaching 2026-27. Some notion of a working year, per session or per
request, distinguishes "the year being taught" from "the year being admitted into".

**Observed / Known gap.** Every row in step 4 carries **2027-28**. There is no active-
years concept, no per-session year context, no year switcher in the request scope. A
school running November admissions must choose between attributing those admissions
correctly and keeping this year's operations correct; it cannot have both. Step 5 is the
control and **passes** — the reporting layer already does it right and the pattern was
simply not propagated. **Fail** — `00_TIMELINE.md` finding 2,
`04_rollover_and_seller.md` §A1, priority row 2.

---

### PL-30 · Promotion preserves identity and history — this part is built correctly

| | |
|---|---|
| **Roles** | Institution Admin |
| **Features** | `institution_admin.students.class_section_promotion`, `student.exams_results.academic_record` |
| **Endpoints** | `POST /api/v1/lifecycle/promote` → `promoteStudents` `internal/api/mod_academics.go:739`, the CTE at `:768-784` (route `api.go:473`, gated `rbac.StudentsWrite`); `GET /api/v1/portal/academic-record` → `getAcademicRecord` `internal/api/student_learning.go:2263` (route `student_learning.go:103`) |

**Setup.** School A. 2026-27 current with Class 5-A holding 30 active enrolments;
2027-28 created with Class 6-A already built. Pick one child, `SID`, note their
`students.id`, admission number and their 5-A `enrollments.id` (`ENR_OLD`).

**Steps.**
1. `POST /api/v1/lifecycle/promote` with `from_section_id` = 5-A, `to_section_id` = 6-A,
   `academic_year_id` = 2027-28.
2. Read the response `promoted` count.
3. Read `students` for `SID`.
4. Read `ENR_OLD`.
5. Read the new enrolment row for `SID`.
6. `GET /api/v1/portal/academic-record` for `SID`.
7. Re-run step 1 unchanged.
8. Run step 1 again with `student_ids: [one child]` from a different section.

**Expected — all of these must pass.**
- (2) `promoted: 30`.
- (3) **one** `students` row, same `id`, same admission number. Identity persists; it is
  not copied.
- (4) `ENR_OLD` still exists, `class_id`/`section_id`/`roll_no` **unchanged**, status now
  `promoted`. The old year's academic record is not mutated
  (`mod_academics.go:775-778`).
- (5) a **new** `enrollments` row: `academic_year_id` = 2027-28, `class_id` = Class 6,
  `section_id` = 6-A, `status` = `active`, and **`promoted_from_id` = `ENR_OLD`**
  (`mod_academics.go:779-782`).
- (6) the record shows both years side by side, the 5-A year marked `promoted`, with
  each year's own report card (`student_learning.go:2287-2300`).
- (7) idempotent: `promoted: 0`, no duplicate rows —
  `(student_id, academic_year_id)` is unique and the insert is `ON CONFLICT DO NOTHING`
  (`mod_academics.go:783`).

**Negative.** (8) a `student_ids` list from another section promotes nobody: the CTE
requires both `section_id = $1` and membership of the array
(`mod_academics.go:769-773`). Also attempt a promotion where `to_section_id` belongs to
another tenant — RLS must make the `SELECT class_id FROM sections`
(`mod_academics.go:764-766`) return no rows and the whole transaction fail.

**Note.** This is the strongest thing in the annual cycle and it must not regress. What
it does *not* do is separately catalogued: one section at a time, target sections must
already exist, no dry run, no preview, no undo, no audit row, no eligibility check, and
nothing carried forward. See PL-31.

---

### PL-31 · What promotion does not do

| | |
|---|---|
| **Roles** | Institution Admin |
| **Endpoints** | `promoteStudents` `internal/api/mod_academics.go:739`; `enrollments.status` allows `'detained'` (schema) but is written by no handler — only rendered, at `internal/api/attention.go:661` |

**Setup.** As PL-30, plus: three children in 5-A are to be detained; the school has
transport and hostel allocations for 2026-27; a full 2026-27 timetable; a 2026-27 fee
structure.

**Steps.**
1. Attempt to mark the three children `detained` through any endpoint.
2. After promotion, check `transport_allocations` and `hostel_allocations` for 2027-28.
3. Check `timetable_entries` for 2027-28.
4. Check `fee_structures` for 2027-28.
5. Look for a promotion dry-run or preview parameter, and for an undo.
6. `GET /api/v1/admin/audit?entity=enrollments` after the promotion.

**Expected (the property under test).** (1) a handler writes `detained`. (2)-(4) a
roll-forward exists. (5) a dry run and an undo. (6) an audit row naming the promotion.

**Observed / Known gap.** (1) **fails** — no handler writes `'detained'` anywhere; the
status is decorative and detention decisions are made outside the system. (2)-(4)
**fail** — there is no clone-structure, copy-timetable, carry-transport,
carry-hostel or clone-fee-structure endpoint (`grep` for
`func (s *Server) (copy|clone|duplicate|rollover)` returns nothing). Note
`hostel_allocations` has no `academic_year_id` at all, so beds stay occupied across the
summer, while `transport_allocations` is correctly year-scoped and therefore must be
rebuilt entirely. (5)-(6) **fail**. **Known gap** —
`04_rollover_and_seller.md` priority rows 14 and 15, `00_TIMELINE.md` March row.

---

### PL-32 · Last year's marks are still editable

| | |
|---|---|
| **Roles** | Faculty, Institution Admin |
| **Features** | `institution_admin.examinations.exams_results` |
| **Endpoints** | `POST /api/v1/exams/marks` → `enterMarks` `internal/api/mod_academics.go:261`, the upsert at `:314-324` (route `api.go:432`, gated `rbac.MarksWrite`); `POST /api/v1/exams/report-cards/generate` → `generateReportCards` `:399` (route `api.go:433`); `exams.is_published` |

**Setup.** School A. A 2025-26 final exam, published, with report cards generated and a
child's Mathematics mark of 71. 2026-27 is now current.

**Steps.**
1. As a subject teacher (or the administrator), `POST /api/v1/exams/marks` for the
   2025-26 `exam_subject_id`, changing 71 to 91.
2. Read `marks` for that student and paper.
3. Read the stored `report_cards` row: `percentage`, `grade`, `rank_in_section`.
4. `GET /api/v1/portal/academic-record` for the child.
5. Repeat step 1 against an exam in a year that has been "closed" by every mechanism the
   school can reach.
6. Check `academic_years` for a `status`, `closed_on` or `closed_by` column.

**Expected (the property under test).** Step 1 is refused — 409 or 403 — with a message
naming the closed year. Step 6 finds a status column.

**Observed / Known gap.** Step 1 **succeeds**: `enterMarks` checks the mark against
`max_marks` and nothing else — no year check, no publish check, no lock. Step 3 shows
the report card's stored `percentage` and `rank_in_section` are now **inconsistent with
the marks behind them**, because nothing recomputes them. Step 5 has no mechanism to
invoke. Step 6 finds nothing — `academic_years` has no status column at all, and there is
no trigger on `marks`, `student_attendance`, `enrollments`, `report_cards` or `exams`.
An auditor cannot be told that last March is final, because it is not. **Fail** —
`00_TIMELINE.md` finding 3, `04_rollover_and_seller.md` §A5, priority row 1.

---

### PL-33 · Last year's attendance register is still writable

| | |
|---|---|
| **Roles** | Faculty, Institution Admin |
| **Endpoints** | `POST /api/v1/attendance` → `markAttendance` `internal/api/attendance.go:81`, date handling at `:93-99` (route `api.go:137`, gated `rbac.AttendanceWrite`); `POST /api/v1/attendance-workflow/corrections` → `requestCorrection` `internal/api/mod_academics.go:32` (route `api.go:409`) |

**Setup.** School A, 2026-27 current. A section that existed in 2025-26 and still exists.

**Steps.**
1. As a teacher with `attendance.write` for that section, `POST /api/v1/attendance` with
   `on_date: "2025-08-14"` — a date inside the previous, completed session.
2. Read `student_attendance` for that date.
3. Recompute the child's 2025-26 attendance percentage from the register.
4. Compare with the attendance percentage printed on their already-issued 2025-26 report
   card and, if one was issued, their transfer certificate.
5. `POST /api/v1/attendance` with `on_date` far in the future.

**Expected (the property under test).** Step 1 is refused for a date outside the current
academic year's `starts_on`/`ends_on`.

**Observed / Known gap.** `markAttendance` validates only that `on_date` parses as
`YYYY-MM-DD` (`attendance.go:96-99`) — no lower bound, no upper bound, no year check.
Step 1 succeeds. Step 4 shows the previously issued documents now disagree with the
register they were derived from, and neither is recomputed. Step 5 also succeeds:
attendance can be marked for next August. **Fail** — same root cause as PL-32.

---

### PL-34 · The close machinery exists and was never pointed at the academic year

| | |
|---|---|
| **Roles** | Institution Admin / Accountant |
| **Features** | `finance.ledgers.financial_year_closing` |
| **Endpoints** | `POST /api/v1/finance/ledgers/years/close` → `closeAccountingYear` `internal/api/ledgers.go:1401` (route `ledgers.go:70`); trigger `accounting_year_close_is_final()` `migrations/00033_ledgers.sql:430`; the other four freezes: `bank_reconciliations` `migrations/00046_banking.sql:368`, `mdm_monthly_returns_frozen` and `fee_regulatory_filings_frozen` `migrations/00053_admin_ops.sql:986,1641`, service book |

This is the control test for PL-32 and PL-33: it proves the product knows how to freeze
a period, so the academic gap is an omission and not an absence of capability.

**Steps.**
1. As the accountant, post a voucher into FY 2025-26.
2. `POST /api/v1/finance/ledgers/years/close` for 2025-26.
3. Attempt to post another voucher into 2025-26.
4. Attempt `UPDATE accounting_years SET status = 'open'` for 2025-26.
5. Attempt `DELETE FROM accounting_years` for 2025-26.
6. Now attempt the same three moves against **academic** year 2025-26.

**Expected.** (2) succeeds and writes `closed_on`, `closed_by`, the frozen surplus and a
permanent closing voucher. (3) refused. (4) `the books for 2025-26 are closed and cannot
be reopened` (`00033_ledgers.sql:441-444`). (5) `the closed year 2025-26 cannot be
deleted` (`:435-437`). (6) **there is no operation to attempt** — no endpoint, no
column, no trigger.

**Known gap.** Steps 1-5 pass and are the model a fix should copy verbatim.
Step 6 is the gap: `04_rollover_and_seller.md` priority row 1.

---

### PL-35 · Detained, graduated and withdrawn have no writer

| | |
|---|---|
| **Roles** | Institution Admin |
| **Endpoints** | `enrollments.status` and `students.status` enums (schema); `issueCertificate` `internal/api/mod_academics.go:811` is the **only** path that sets `students.status`, `exit_date`, `exit_reason` (`:884-893`); rendering only at `internal/api/attention.go:661` |

**Steps.**
1. Attempt to record a Class 5 child as detained (PL-31 step 1).
2. Attempt to graduate a Class 10 cohort to alumni in bulk.
3. Withdraw a child who is leaving but does **not** want a TC.
4. Check `alumni_profiles` for any row created by a handler.

**Expected.** Each of the four has an endpoint.

**Observed / Known gap.** All four **fail**. The only exit route in the product is
issuing a transfer certificate, which sets `students.status='transferred'` as a side
effect. A school that needs to record a withdrawal without a TC must issue one anyway.
`04_rollover_and_seller.md` Part A table, rows "Detention / retention decision",
"Student withdrawal (non-TC)" and "Graduate class 10/12 to alumni".

---

### PL-36 · A family owing two terms in March starts April owing nothing

| | |
|---|---|
| **Roles** | Institution Admin, Accountant |
| **Features** | `finance.student_dues.student_ledger`, `finance.student_dues.defaulters_reminders` |
| **Endpoints** | `POST /api/v1/finance/invoices/generate` → `generateInvoices` `internal/api/fees.go:575`, year resolution at `:602-607`, student selection at `:612-622` (route `api.go:315`); `GET /api/v1/finance/invoices` → `listInvoices` (`api.go:299`); `GET /api/v1/export/defaulters` `internal/api/export.go:53` |

**Setup.** School A. Child `SID` in 2026-27 owes ₹48,000 across two unpaid term
invoices. 2027-28 exists with a fee structure. `SID` is promoted (PL-30).

**Steps.**
1. Before rollover, `GET /api/v1/export/defaulters` and confirm `SID` at ₹48,000.
2. `POST /api/v1/finance/invoices/generate` with the 2027-28 fee structure,
   `instalment_no: 1`.
3. Read the new invoice for `SID`: its lines, its `net_paise`, and any
   opening-balance or arrears line.
4. `GET /api/v1/finance/invoices?student_id={SID}` and compute the child's total
   outstanding across both years.
5. Attempt to promote or issue a TC to a child with dues and see whether anything blocks.
6. Search the schema for `arrears`, `opening_balance`, `brought_forward`,
   `previous_year` in the fee engine.

**Expected (the property under test).** Step 3's April invoice carries the ₹48,000 as a
brought-forward line or the school has a consolidated demand note showing total
outstanding across years. Step 5 blocks or warns.

**Observed / Known gap.** Step 3's invoice contains **only** 2027-28's own heads.
`generateInvoices` reads the year from the fee structure (`fees.go:602-607`) — correct
in itself — and adds nothing from any prior year. Step 4 requires the reader to sum two
years by hand; the product has no "total outstanding" view. Step 5 does not block. Step
6 returns nothing in the fee engine: the only hit repo-wide is
`bank_reconciliations.opening_balance_paise`, a bank statement field. The codebase knows
the shape of the problem — `admin_rollups.go:644` warns in a comment that a naive
"latest enrolment" join "makes a Grade 9 look like a defaulter for a debt they ran up in
Grade 8" and correctly joins the invoice's own year — but knowing an old debt exists is
not carrying it forward. Every Indian school reconciles arrears in April; this one does
it in Excel. **Fail** — `00_TIMELINE.md` finding 5, `04_rollover_and_seller.md` §A3,
priority row 3. Combined with PL-24, a school switching ERPs cannot even import the
opening balances it would need.

---

### PL-37 · Attendance percentage is a lifetime average

| | |
|---|---|
| **Roles** | Student / Parent, Institution Admin |
| **Features** | `student.exams_results.academic_record` |
| **Endpoints** | `GET /api/v1/portal/academic-record` → `getAcademicRecord` `internal/api/student_learning.go:2263`, the unfiltered aggregate at `:2280-2282`; `student_attendance` has **no** `academic_year_id` — the year is reachable only via `section_id → sections.academic_year_id` |

**Setup.** A Class 9 child with a full attendance history: 96% in Classes 1-8, and 61%
in Class 9 (2026-27) after a long illness.

**Steps.**
1. Compute the child's 2026-27 attendance from `student_attendance` joined through
   `sections` to the current year. Expect ~61%.
2. `GET /api/v1/portal/academic-record` for the child and read the headline
   `attendance_percent`.
3. Read the per-year `attendance_percent` inside each `recordYear` entry.
4. Compare with the attendance printed on the child's 2026-27 report card.

**Expected (the property under test).** Step 2 shows the **current session's** figure,
~61%, or is labelled unambiguously as lifetime.

**Observed / Known gap.** The headline aggregate is
`SELECT round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late')) /
nullif(count(*),0),1) FROM student_attendance sa WHERE sa.student_id = st.id`
(`student_learning.go:2280-2282`) — **no join to `sections`, no year filter**. It reports
roughly **92%**, the average of Classes 1-9, next to a year in which the child attended
61%. Step 3 is correct, because the per-year figure comes from the stored
`report_cards.attendance_percent`, so the screen shows two different numbers for the same
child with no explanation of why. **Fail** — `04_rollover_and_seller.md` §A2, priority
row 4. The fix is a join through `sections`; the reason it was easy to get wrong is that
`student_attendance` carries no `academic_year_id`, so every consumer must remember it.

---

### PL-38 · The transfer certificate prints a multi-year average on a legal document

| | |
|---|---|
| **Roles** | Institution Admin / Front Office |
| **Features** | `institution_admin.students.certificates_documents` |
| **Endpoints** | `POST /api/v1/lifecycle/certificates` → `issueCertificate` `internal/api/mod_academics.go:811` (route `api.go:474`, gated `rbac.StudentsWrite`); the snapshot at `:852-868`, the lifetime attendance at `:859-862`, the dues sum at `:863-865`, the serial at `:843`; `GET /api/v1/lifecycle/certificates` → `listCertificates` `:927`; `serial_prefix` configured at `internal/api/admin_academics.go:2766,2777` |

**Setup.** The Class 9 child from PL-37, leaving mid-2026-27, with ₹48,000 outstanding
(PL-36) and two library books on loan. A `certificate_types` row for `TC` with
`serial_prefix = 'TC/2026/'` and `requires_approval = true`.

**Steps.**
1. `POST /api/v1/lifecycle/certificates` with `type_code: "TC"`.
2. Read the returned `serial_no`.
3. Read the stored `issued_certificates.snapshot` and enumerate its keys.
4. Read `snapshot->>'attendance_percent'` and compare with PL-37 step 1.
5. Read `snapshot->>'dues_paise'` and check whether issuance was blocked.
6. Read `students.status`, `exit_date`, `exit_reason` and the child's active enrolment.
7. Issue a `BONAFIDE` and a `CONDUCT` certificate, and a staff certificate via
   `internal/api/hr_lifecycle.go:810`, then compare all four serial numbers.
8. Delete the `TC` `certificate_types` row and issue another TC.
9. Compare with the staff exit path, where `exit_clearances` blocks settlement **in the
   database** (`migrations/00031_hr_lifecycle.sql:205`).

**Expected (the property under test).** (2) the serial begins `TC/2026/`. (3) the
snapshot carries the ~20 fields a CBSE/state TC is prescribed to have. (4) the current
session's attendance. (5) issuance is blocked, or at least gated, while dues are
outstanding and library books are out. (7) TCs form a contiguous register of their own.
(8) approval is required.

**Observed / Known gap — five defects, each load-bearing.**
- (2) **`serial_prefix` is ignored.** The issuer calls
  `fees.NextNumber(…, "certificate")` (`mod_academics.go:843`) — a single series shared
  by TC, bonafide, conduct **and** staff certificates. Step 7 confirms the four
  interleave. TC serials are therefore not a contiguous register, which is the one thing
  an inspector checks.
- (3) **Eight fields, not twenty**: name, admission_no, date_of_birth, class, section,
  admission_date, apaar_id, attendance_percent, dues_paise. Missing: last examination
  passed, whether qualified for promotion to the higher class, working days / days
  present, subjects studied, general conduct, date of leaving, concession availed, games
  played. Several are missing because the underlying facts are not stored — see PL-31
  (no annual result) and PL-37.
- (4) **Lifetime attendance on a legal document.** `mod_academics.go:859-862` is the same
  unfiltered aggregate as PL-37, with no join to `sections`. The TC prints ~92% where the
  board expects the current session's figure.
- (5) **No dues or clearance gate.** The snapshot merely *records* `dues_paise`, summed
  across all years, and nothing blocks issuance. The child leaves with ₹48,000 owing and
  two library books, and the school's only record is a number on a certificate it has
  already handed over. Step 9 is the contrast that makes this a defect rather than a
  choice: staff cannot be settled until every clearance row is signed off, enforced in
  the database.
- (8) **Approval is bypassed.** If the type does not exist the handler creates it with
  `requires_approval = false` (`mod_academics.go:833-836`), so a TC issues on one clerk's
  click.

**What passes and must not regress.** (6) the TC correctly ends the child's time at the
school — `students.status='transferred'`, `exit_date`, `exit_reason`, and the active
enrolment closed (`mod_academics.go:884-893`) — and the snapshot is genuinely frozen, so
an old TC does not change its contents when the student is archived. TC issuance exists
and is better than the catalogue implies; the defects are narrower and specific.
`04_rollover_and_seller.md` §A4, priority row 5.

---

# Chains that could not be tested, because the endpoint does not exist

These are findings, not gaps in the exercise. Each was searched for in `migrations/`,
`internal/api/` and `web/src/features/registry.ts` before being listed.

**Seller tier — pre-sale and commercial.** No test can be written for any of these
because there is nothing to call.

1. **Quotation to a school.** Zero hits for `quotation`, `quote`, `proposal`,
   `estimate`, `proforma` in `migrations/`. No vendor→school quote object exists.
2. **Negotiated price.** There is no per-tenant price column anywhere. Price is a
   property of `plans.code` (`migrations/00011_seller.sql:16`, `00120:22`). A school
   cannot be sold at a negotiated rate at all, so PL-17 can only be run at one of three
   list prices.
3. **Discount approval.** Follows from (2): nothing to approve.
4. **Contract / MSA.** No contract table, term length, end date, auto-renew flag, notice
   period, signatory or signed document. `subscriptions` has `started_on` and
   `renews_on` and nothing else.
5. **Vendor invoice to the school.** No table bills a tenant. `invoices` is
   `institution_id`-scoped and `student_id`-bearing with FORCE RLS — the school billing
   a parent. No vendor GSTIN, HSN/SAC, place of supply or invoice series.
6. **Recurring collection.** The only vendor-facing payment path is `signup_orders`, and
   `internal/api/signup.go:45-52` states that it is a **simulator**: Razorpay's shape
   reimplemented locally with the signature minted by `sign` (`signup.go:466`) and
   verified by the same code. It fires once, at self-signup. No card on file, no eNACH
   mandate, no second payment ever.
7. **Dunning.** Zero hits repo-wide. `past_due` is set by hand (PL-23).
8. **Renewal workflow.** No renewal quote, task, reminder, auto-renew job or expiry
   sweeper (PL-23 step 4).
9. **Cancellation as a process.** No cancellation date, reason code, requester or
   effective date; no offboarding, no win-back. `entitlement.go:257` tells a cancelled
   school "Your data is retained" and **nothing implements retrieval** — so the data
   export a churning school is promised cannot be tested either.
10. **Demo / sandbox / pilot tenant.** `purchase_enquiries.status='demo_booked'` is a
    string with no date, scheduler, attendee or outcome. No `poc`, `pilot`, `sandbox` or
    evaluation-tenant concept.
11. **Lead pipeline.** `purchase_enquiries` (`migrations/00013_purchase_enquiries.sql:14`,
    served by `GET /api/v1/seller/enquiries` → `listSalesEnquiries`
    `internal/api/buy.go:267`) is a contact-form inbox: no owner, no next-follow-up date,
    no activity log, no stage history, no deal value. It is testable as a list and
    nothing more. Note it is **not** catalogued among the twelve `seller_admin` features.
12. **Vendor training records.** `staff_training_records` is the *school's* own CPD/NEP
    register, not the vendor's delivery. No vendor training session, attendee, material
    or completion record.
13. **SLA and escalation.** `support_tickets.priority` is a bare enum. No response or
    resolution target, no `due_at`, no first-response stamp, no breach flag, no
    escalation tier, no business-hours calendar, and no link from `plans` to a support
    tier — so the support tiers cannot be sold and PL-06 cannot be extended to cover one.
14. **Go-live / cutover.** Zero hits for `cutover`, `go_live`, `readiness`. The nearest
    artefact is `setup_percent` (PL-24).

**The year.**

15. **Academic year close.** No endpoint, no `academic_years.status`, no `closed_on`,
    no `closed_by`, no immutability trigger. PL-32, PL-33 and PL-34 step 6 are written as
    the tests a fix must turn green; they cannot currently be run in the positive
    direction at all.
16. **Roll-forward of any structure.** No clone-sections, copy-timetable,
    clone-fee-structure, carry-transport or carry-hostel endpoint
    (`func (s *Server) (copy|clone|duplicate|rollover)` matches nothing). PL-31 steps 2-4
    are assertions of absence.
17. **Arrears / opening balance.** No column, no fee head, no consolidated demand note
    (PL-36).
18. **Student exit clearance.** `exit_clearances` and `clearance_departments` exist for
    **staff only** (`migrations/00031_hr_lifecycle.sql:205`). PL-38 step 5 has nothing to
    call on the student side.
19. **Annual result / detention.** Nothing stored: no annual result row, no
    division/aggregate rule, no "qualified for promotion to the next higher class" — a
    prescribed TC field. `'detained'` is never written (PL-31, PL-35).
20. **Leave-balance carry-forward.** `leave_types.carry_forward` and
    `leave_policy_rules.carry_forward_max` model the policy; no year-end job computes
    next year's opening balance from it.
21. **Inventory period close.** No opening/closing stock, no year-end valuation, no
    physical-count reconciliation. `inventory_items.on_hand` is a single running number
    with no history.

**Isolation.**

22. **A negative test for the platform-admin RLS fold at the query layer.** PL-08 and
    PL-09 demonstrate the leak per endpoint, but there is no repository-wide guard — no
    linter, no test helper, no `Scope` variant that drops `PlatformAdmin` once an acting
    institution is named — so the property can only be asserted handler by handler.
    `internal/api/integrations_index.go:306-310` shows the correct pattern applied in one
    place; nothing enforces it in the other several hundred queries.
