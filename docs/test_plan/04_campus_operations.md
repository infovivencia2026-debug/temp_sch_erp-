# Acceptance tests 04 — Campus Operations

Institution Admin ↔ Parent ↔ Student ↔ Finance

## Scope

The services a school runs around teaching: the bus, the boarding house, the
library, the sick room, the canteen and store till, the mid-day meal register,
the circular and the grievance, and the passes that get somebody through a gate.
Every test below is grounded in a route that exists in `internal/api/` or a
screen that exists in `web/src/features/`, cited by file and line; nothing is
written from a catalogue name. The base path is `/api/v1` (`cmd/web/main.go:155`),
and the operations desks hang off `r.Route("/ops")` at `internal/api/api.go:526`,
so a handler registered as `/hostel/outpasses` is reached at
`/api/v1/ops/hostel/outpasses`. **Two standing conditions govern this whole
cluster and are restated in each test that depends on them.** First, no guardian
can obtain a portal login: `guardians.user_id` is written only by
`cmd/migrate/demo.go:257-261`, so every parent-facing step here must be executed
against a demo-seeded tenant and is unreachable in a real one
(`docs/gap_analysis/00_TIMELINE.md:73-81`). Second, safeguarding and
confidentiality are the point of this cluster, not a postscript: OP-09, OP-11,
OP-12, OP-21, OP-22, OP-30 and OP-32 are the tests that matter most, and four of
them are expected to fail against the current build (OP-09, OP-11, OP-21, OP-22).

Tests are in dependency order. Where the gap analysis says a chain is cut, the
test says so and states what a tester should actually observe rather than
pretending a pass is available.

---

## Transport

### OP-01 — Routes, stops, fares and vehicles can be read and not created; a driver can be recorded but not assigned to a bus

**Roles** Institution Admin (transport manager)

**Features** `institution_admin.transport.routes_stops`,
`.vehicles`, `.vehicle_master_registry`, `.route_pickup_stop_mapping`,
`.route_distance_fee_slabs`, `.drivers_attendants`, `.driver_attendant_profiles`

**Endpoints**
- `GET /api/v1/ops/transport/routes` — `listRoutes`, route `internal/api/api.go:569`, handler `internal/api/mod_ops.go:1412`
- `GET /api/v1/ops/transport/routes/{id}/stops` — `listRouteStops`, route `internal/api/api.go:570`, handler `internal/api/mod_ops.go:1442` (projects `rs.fare_paise` at `:1451`)
- `GET /api/v1/ops/transport/vehicles` — `listVehicles`, route `internal/api/api.go:550`, handler `internal/api/role_backoffice.go:479`
- `GET /api/v1/ops/transport/staff` — `listTransportStaff`, route `internal/api/api.go:577`, handler `internal/api/transport_office.go:47`
- `POST /api/v1/ops/transport/staff` — `saveTransportStaff`, route `internal/api/api.go:578`, handler `internal/api/transport_office.go:103`
- Screens: `web/src/features/operations/Transport.tsx:78,82,86` — three `api.get` calls and no mutation; `web/src/features/operations/TransportOffice.tsx:125,704` — the driver register

**Setup** A tenant seeded by `cmd/migrate/demo_ops.go:302-321`, which is the only
non-test code in the repository that inserts into `vehicles`, `routes` or
`route_stops`. A transport manager account (`rbac.go:367-368`, holds
`TransportRead`/`TransportWrite`).

**Steps**
1. Transport manager opens `institution_admin.transport.routes_stops`. Confirm routes list.
2. Transport manager expands a route and confirms its stops carry a sequence, a pickup time and a `fare_paise`.
3. Transport manager opens `institution_admin.transport.vehicles` and confirms registration, capacity, driver and status.
4. Transport manager attempts to add a new route, a new stop, or a new vehicle from any screen.
5. Transport manager records a driver with a licence number and expiry, a medical expiry and a police-verification date.
6. Transport manager records a driver with a licence number and **no** expiry.
7. Transport manager records a person with `role: "conductor"`.
8. Transport manager attempts to assign that driver to a specific vehicle.

**Expected** Steps 1–3 return data. Step 4 has no control to click: `Transport.tsx`
issues no `api.post`/`api.put`, and there is no `POST /ops/transport/routes`,
`/routes/{id}/stops` or `/vehicles` anywhere in the route table. Step 5 succeeds
and `listTransportStaff` reports `days_to_lapse` and `lapsed_item` as the soonest
of licence expiry, medical expiry and `police_verified_on + 365`
(`transport_office.go:66-76`), NULLS FIRST so the unchecked driver sorts to the
top. Step 6 → `400` (`transport_office.go:117`). Step 7 is **not** validated in Go
— it reaches the database CHECK `role IN ('driver','attendant','cleaner')`
(`migrations/00021_transport_office.sql:40`) and returns a raw Postgres error
string as a 400; record that as a defect. Step 8 has no endpoint:
`vehicles.driver_employee_id` and `.attendant_employee_id` are only ever read
(`transport_office.go:59-61`), never written outside the demo seeder.

**Negative** A `driver` role (`rbac.go:373-374`, `TransportRead` only) may perform
steps 1–3 and is refused on step 5. Repeat steps against a `finance` account:
expect 403 on all, since `finance` holds no `operations.transport.read`.

**Known gap** The five catalogue keys above are marked *built* and resolve to a
read-only viewer. A school cannot define its own routes, stops, fare slabs or
fleet without direct SQL. This is a precondition failure for OP-02 onward.
`Transport.tsx:48-51,205-208` additionally declares and renders four per-vehicle
expiry cells that `listVehicles` never returns (it projects only the collapsed
`next_expiry`, `role_backoffice.go:485-489`) — they are permanently blank. See OP-07.

---

### OP-02 — A child is allocated to a route and a stop, and the previous allocation is closed rather than deleted

**Roles** Institution Admin (transport manager)

**Features** `institution_admin.transport.student_allocation`, `.student_route_assignment`

**Endpoints**
- `POST /api/v1/ops/transport/allocations` — `allocateTransport`, route `internal/api/api.go:580`, handler `internal/api/transport_office.go:209`
- `GET /api/v1/ops/transport/allocations` — `listTransportAllocations`, route `internal/api/api.go:579`
- Screen: `web/src/features/operations/TransportOffice.tsx` (key `institution_admin.transport.student_allocation`, `web/src/features/registry.ts:311`)

**Setup** OP-01 seeded data. Two routes, each with at least two stops. One active student.

**Steps**
1. Transport manager allocates the student to route A, pickup stop A1.
2. Transport manager re-reads the allocation list and confirms one live row.
3. Transport manager re-allocates the same student to route A, pickup stop A2.
4. Transport manager attempts to allocate the student to route A with a stop that belongs to route B.

**Expected** Step 1 returns `201` with a body of exactly `{"fare_paise": N}`
(`transport_office.go:270`) where `N` is stop A1's fare. Step 3 sets the first
row's `valid_to = current_date - 1` (`transport_office.go:246-252`) and inserts a
second row — the October move stays explicable, the old row is not deleted.
Step 4 returns `400 "that stop is not on that route"` (`transport_office.go:240-241,262-264`).

5. Transport manager allocates a second student to a stop whose `fare_paise` is NULL.
6. Transport manager allocates with a valid `pickup_stop_id` on route A and a `drop_stop_id` belonging to route B.

**Expected for steps 5–6 — two defects to record.** Step 5 returns a `400`
carrying a raw pgx type error, not a success: `route_stops.fare_paise` is nullable
(`migrations/00001_baseline.sql:1210`) but the handler scans it into a plain
`int64` (`transport_office.go:229,259-260`). A school that has not priced a stop
cannot allocate a child to it. Step 6 **succeeds**: only `pickup_stop_id` is
checked against the route (`transport_office.go:234-242`); the drop stop is never
validated, so a child can be recorded as alighting on a route they are not on.

**Negative** Post as a `librarian` (no `TransportWrite`): expect 403. Post with a
`student_id` belonging to another tenant: RLS yields no `academic_years` /
allocation row and the insert fails as a 400. Post a malformed `pickup_stop_id`:
it is never `uuid.Parse`d and surfaces as a raw cast error rather than a sentence.

**Known gap** `academic_year_id` is taken from `WHERE is_current LIMIT 1`
(`transport_office.go:257`) with no override — see `00_TIMELINE.md:82-89`. From
November, an allocation made for next year is stamped with this year. If no
current year exists the column is silently NULL and no error is raised.

---

### OP-03 — The fare computed at allocation is never billed (KNOWN BROKEN)

**Roles** Institution Admin (transport manager) → Finance

**Features** `institution_admin.transport.route_distance_fee_slabs` (catalogued as
"auto-apply them to the student's fee structure"), `finance.billing.*`

**Endpoints**
- `POST /api/v1/ops/transport/allocations` — `allocateTransport`, `internal/api/transport_office.go:209`; fare is read at `:259` and returned at `:270`
- Invoice raising — `raiseInvoices`, `internal/api/fees.go:600` (copies lines from `fee_structure_items` only)

**Setup** One class with two children: child X allocated to a bus stop with
`fare_paise > 0` (via OP-02), child Y with no transport allocation. Both on the
same fee structure.

**Steps**
1. Transport manager allocates child X and records the `fare_paise` returned.
2. Finance raises invoices for the class.
3. Finance opens child X's ledger and child Y's ledger side by side.

**Expected — statement of the defect** The two invoices are **identical**. No
line, no head and no amount corresponds to the bus. `fare_paise` occurs in
exactly five non-test places in `internal/`, all of them reads
(`transport_office.go:173,181,259,270` and `mod_ops.go:1451`); nothing writes it
to an invoice, an invoice line or a fee head. The test **passes** only if the
tester can demonstrate this divergence between what the screen quotes and what
the family is charged; it does not pass by finding a transport line.

**Negative** There is no per-student charge mechanism at all, so the same test
shape applies to any individual levy. Confirm that no `fee_structure_items` row
can be made student-specific.

**Known gap** `docs/gap_analysis/00_TIMELINE.md:29-30` and
`02_onboarding_daily.md` finding 3, rated P0 for finance. A school discovers this
in month two when transport revenue does not appear and starts a parallel ledger.

---

### OP-04 — The daily boarding register is built from the allocation, so an unscanned child is visible

**Roles** Institution Admin / bus attendant

**Features** `institution_admin.transport.route_attendance`, `.transport_attendance_scans`

**Endpoints**
- `GET /api/v1/ops/transport/attendance` — `listBusAttendance`, route `internal/api/api.go:581`, handler `internal/api/transport_office.go:297`
- `POST /api/v1/ops/transport/attendance` — `markBusAttendance`, route `internal/api/api.go:582`, handler `internal/api/transport_office.go:341`

**Setup** Three children allocated to route A (OP-02). Today's date.

**Steps**
1. Attendant opens the morning register for route A before any scan.
2. Attendant marks child 1 `boarded`, child 2 `absent`, and leaves child 3 alone.
3. Attendant re-reads the register.
4. Attendant marks child 1 `alighted` and re-reads.
5. Attendant posts `status: "boarded"` for a child who has **no** transport allocation.

**Expected** Step 1: all three appear with `status: "not_scanned"`
(`transport_office.go:308`), ordered by stop sequence. Step 3: child 3 is still
listed as `not_scanned` — the register does not silently omit the child nobody
saw. Child 1 shows `still_aboard: true` (`transport_office.go:312-314`). Step 4:
`still_aboard` becomes false and `boarded_at` is **preserved**, not erased
(`COALESCE`, `transport_office.go:431-434`). Step 5 returns `200 {"marked":"boarded"}`
but writes nothing, because the `INSERT ... SELECT FROM transport_allocations`
(`transport_office.go:415-425`) matches no row — record this as a silent no-op
defect.

**Negative** Post `status: "left"` → `400 "status must be boarded, alighted or absent"`
(`transport_office.go:412-415`). Post as `front_office` (no `TransportWrite`) → 403.

---

### OP-05 — The bus is cleared before it leaves, and an incident on the run is raised and resolved

**Roles** Institution Admin (transport manager)

**Features** `institution_admin.transport.driver_sobriety_safety_checklist`,
`.delays_exceptions`, `.bus_breakdown_emergency_dispatch`,
`.vehicle_fuel_maintenance_log`

**Endpoints**
- `GET /api/v1/ops/transport/checks` — `listTripChecks`, route `internal/api/api.go:585`, handler `internal/api/transport_office.go:542`
- `POST /api/v1/ops/transport/checks` — `recordTripCheck`, route `internal/api/api.go:586`, handler `internal/api/transport_office.go:603`
- `GET /api/v1/ops/transport/logs` — `listVehicleLogs`, route `internal/api/api.go:583`, handler `internal/api/transport_office.go:420`
- `POST /api/v1/ops/transport/logs` — `recordVehicleLog`, route `internal/api/api.go:584`, handler `internal/api/transport_office.go:466`
- `GET /api/v1/ops/transport/incidents` — `listTransportIncidents`, route `internal/api/api.go:587`, handler `internal/api/transport_office.go:676`
- `POST /api/v1/ops/transport/incidents` — `saveTransportIncident`, route `internal/api/api.go:588`, handler `internal/api/transport_office.go:716`
- Screen: `web/src/features/operations/TransportOffice.tsx:381,385` (checks), `:978,982` (logs), `:129,532` (incidents)

**Setup** Route A with three live allocations (OP-02). A second vehicle to serve as replacement.

**Steps (pre-departure check)**
A1. Transport manager records a morning check with brakes, tyres, lights, first aid,
    extinguisher and doors all true and a breathalyser reading of 0, and sends
    `cleared: false` in the body.
A2. Transport manager records a check with tyres false, and reads the check list.
A3. Transport manager records a check with everything true and a breathalyser reading above zero.
A4. Transport manager records a fuel log with litres and an odometer reading, then a
    second fuel log with a **lower** odometer reading on a later date.
A5. Transport manager records a fuel log with no litres.

**Expected (pre-departure check)** A1: `cleared` comes back **true** — the field is
derived server-side from the six booleans and the breathalyser and is never taken
from the client (`transport_office.go:617-618`), backed by the database CHECK
`trip_checks_cleared_means_clear` (`migrations/00021_transport_office.sql:141-144`).
A2 and A3: `cleared` is false and `failed_items[]` names what failed
(`transport_office.go:550-558`); the list window is a fixed 14 days
(`:542-549`). A4 second call → `400` on `errOdometerBack` (`transport_office.go:491-501`)
— an odometer that goes backwards is a keying error or a swapped vehicle. A5 → `400`
(`transport_office.go:481`). Note `amount_paise` is not validated, so a negative
fuel bill is accepted — record that. Note also that `kind: "insurance"` on a
vehicle log records a **payment** and does not touch `vehicles.insurance_expiry`
(OP-07).

**Steps (incident)**
1. Transport manager records a `breakdown` on route A, morning leg, with a description.
2. Transport manager reads the incident list.
3. Transport manager closes the incident with a resolution and names the replacement vehicle.
4. Transport manager attempts to close a second incident with an empty resolution.
5. Transport manager attempts to record an incident of kind `strike`.

**Expected** Step 2: the open incident sorts first (`transport_office.go:692`)
and reports `children_affected = 3`, counted live from `transport_allocations`
(`transport_office.go:684-686`). Step 3 returns `{"resolved": true}` and stamps
`resolved_at`. Step 4 → `400 "say how it ended — a breakdown closed with no note
cannot be reviewed"` (`transport_office.go:725-727`). Step 5 → `400 "unknown kind strike"`
(`transport_office.go:756-758`).

6. Transport manager closes an incident id that does not exist.

**Expected for step 6 — defect to record.** It returns `200 {"resolved": true}`.
The close-mode `UPDATE` has no `RowsAffected` check (`transport_office.go:734-748`),
so the screen reports success for a case that was never touched.

**Negative** As `driver` (TransportRead only): step 1 → 403.

**Known gap** `parents_informed` is a boolean somebody ticks
(`transport_office.go:738,767-771`). No message event is emitted and there is no
parent-facing incident view — and the endpoint that would carry one is not
mounted at all. See OP-06.

---

### OP-06 — The parent's view of the bus is not mounted on the router at all (KNOWN BROKEN)

**Roles** Parent

**Features** `parent.my_childs_bus.transport_snapshot`, `.live_bus_tracking_map`,
`parent.alerts_preferences.parent_bus_proximity_radius_customizer`,
`.parent_app_live_bus_tracking_refresh_rate_customizer`

**Endpoints — written, gated, narrowed, and unreachable**
- `GET /api/v1/me/child-bus` — `getChildBus`, registered at `internal/api/bus_tracking_views.go:485` inside `mountBusTracking` (`:476`), handler `internal/api/bus_tracking_views.go:189`
- `POST /api/v1/me/child-bus/prefs` — `saveWatchPrefs`, `internal/api/bus_tracking_views.go:486` / `:311`
- `GET /api/v1/transport/live` — `listLiveVehicles`, `internal/api/bus_tracking_views.go:481`
- `GET /api/v1/transport/safety-events`, `POST /api/v1/transport/safety-events/{id}/review` — `:482,:483`
- Screens: `web/src/features/portal/TransportSnapshot.tsx:32`, `.../ChildBus.tsx:46`,
  `.../DriverCall.tsx:31`, `.../BusProximityAlert.tsx:35`, `.../BusRefreshRate.tsx:39`,
  `web/src/features/operations/LiveVehicleMap.tsx:139,144`

**Setup** A demo-seeded guardian G with a portal login and a child allocated per OP-02.

**Steps**
1. G opens "Transport snapshot" (`parent.my_childs_bus.transport_snapshot`).
2. Issue `GET /api/v1/me/child-bus` directly with G's session.
3. As a transport manager, open the live vehicle map and issue `GET /api/v1/transport/live`.

**Expected — statement of the defect** All three return **404**. `mountBusTracking`
(`internal/api/bus_tracking_views.go:476`) is never called: `internal/api/api.go`
invokes only `s.mountBusTrackerDevice(r)` (`api.go:43`) and
`s.mountBusTrackerAdmin(r)` (`api.go:117`). `grep -rn "mountBusTracking"` over
`internal/` and `cmd/` finds the definition and one test call
(`internal/api/bus_tracker_test.go:894`) and nothing else. The same is true of
`mountBusTrackerManage` (`internal/api/bus_tracker_admin.go:528`) and
`mountTransportLiveMap` (`internal/api/transport_live_map.go:58`). Eleven routes
and eight React screens are dead at the router.

**What the code would do if it were mounted** — worth recording so the fix can be
verified in one line. `getChildBus` resolves children through
`student_guardians → guardians.user_id = $1` (`bus_tracking_views.go:203-210`),
joins only live allocations (`:225-227`), nulls out latitude, longitude and the
driver's phone when the school's tracking policy says parents may not watch
(`:276`), and gates `driver_phone` on an open trip in SQL (`:214`). `saveWatchPrefs`
bounds `refresh_seconds` to 10–300 and `proximity_m` to 100–5000, and verifies any
supplied `student_id` is the caller's child, 404 otherwise (`:317-354`). None of
that is reachable.

**Negative** Confirm the office half is equally dead: `/transport/live`,
`/transport/safety-events`, `/transport/trackers`, `/transport/tracking-policy`,
`/transport/stop-events` and `/transport/map-stops` all 404. The only tracker
route that does work is `POST /api/v1/transport/trackers/pair`
(`internal/api/bus_tracker.go:1193`) plus the unauthenticated device group
(`:1176-1186`) — so a school can pair a driver's phone and then see nothing it sends.

**Also record** No parent-facing incident view exists even in the unmounted code:
`getChildBus` projects no incident field, and `transport_incidents` is exposed only
under `/ops` behind `operations.transport.read`.

**Known gap** Two layers deep. Even once mounted, in a real tenant this screen is
empty for every parent because `guardians.user_id` is never set
(`docs/gap_analysis/00_TIMELINE.md:73-81`).

---

### OP-07 — Vehicle insurance, fitness, permit and PUC renewal: nothing to test

**Roles** Institution Admin (transport manager)

**Features** none — no catalogue key covers this

**Endpoints** none. `vehicles.insurance_expiry`, `.fitness_expiry`,
`.permit_expiry`, `.puc_expiry` exist at `migrations/00001_baseline.sql:1587-1590`
and are **read** in two places — `getOperationsDashboard`
(`internal/api/role_backoffice.go:415-419`, counting buses whose soonest document
lapses within 30 days) and `listVehicles` (`internal/api/role_backoffice.go:485-489`,
collapsing all four into a single `next_expiry`). No handler in `internal/` writes
any of the four columns; the only writer is `cmd/migrate/demo_ops.go:302`.

**Expected** Record as a **missing chain**. A tester can confirm: (a) the
operations dashboard shows a "documents expiring" count; (b) the vehicle list
shows one date; (c) there is no screen or endpoint that says *which* of the four
documents that date belongs to, no way to record a renewal, and no alert when one
lapses. A lapsed fitness certificate grounds the bus and is prosecutable under
the Motor Vehicles Act; this product can neither record the renewal nor name the
document.

**Known gap** `docs/gap_analysis/00_TIMELINE.md:29`.

---

## Hostel

### OP-08 — A boarder is allotted a bed, and the bed cannot be double-allotted

**Roles** Institution Admin (hostel warden)

**Features** `institution_admin.hostel.room_allocation`, `.buildings_rooms`, `.hostel_building_room_setup`

**Endpoints**
- `GET /api/v1/ops/hostel/occupancy` — `listHostelOccupancy`, route `internal/api/api.go:551`, handler `internal/api/mod_ops.go:1089`
- `GET /api/v1/ops/hostel/rooms/{id}/boarders` — `listRoomBoarders`, route `internal/api/api.go:552`, handler `internal/api/mod_ops.go:1315`
- `POST /api/v1/ops/hostel/allocate` — `allocateHostelBed`, route `internal/api/api.go:553`, handler `internal/api/mod_ops.go:1023`
- Screen: `web/src/features/operations/Hostel.tsx` (`registry.ts:277-282`)

**Setup** A block with a room of 2 beds. Two students, A and B.

**Steps**
1. Warden reads occupancy and notes the room id, beds and free count.
2. Warden allocates A to bed 1.
3. Warden allocates B to bed 1.
4. Warden allocates B to bed 2, then attempts to allocate B again to another room.
5. Warden allocates A to bed 3 of the same room.

**Expected** Step 1 returns `room_id`, `beds`, `occupied`, `free`
(`mod_ops.go:1089-1105`). Step 2 → `201 {"allocated": true}`. Step 3 → `409
bed_occupied` "that bed is already allocated" (`mod_ops.go:1060-1063`). Step 4
second half → `409 already_allocated` "that student already occupies a bed;
vacate it first" (`mod_ops.go:1064-1068`). Step 5 → 400 "room has only 2 beds"
(`mod_ops.go:1043-1046`).

**Negative** As `front_office` (no `HostelWrite`) → 403 on step 2. Note the
occupancy list exposes `hb.gender` (`mod_ops.go:1096`) but the handler does not
enforce it: allocating a boy to a girls' block succeeds. Record that as a defect.

---

### OP-09 — A guardian of two boarders cannot raise an outpass without choosing which child (SAFEGUARDING — EXPECTED TO FAIL)

**Roles** Parent → Institution Admin (warden)

**Features** `institution_admin.hostel.outpass_leave`, `.digital_outpass_approval`, `parent.consent.consent_acknowledgement`

**Endpoints**
- `POST /api/v1/ops/hostel/outpasses` — `createOutpass`, route `internal/api/api.go:561` (no RBAC on the route by design, see `api.go:554-559`), handler `internal/api/hostel_life.go:125`
- Screen: `web/src/features/portal/Consent.tsx:228` (`RequestTrip`), child resolution at `:222`, submit guard at `:316`

**Setup** A demo-seeded guardian G linked to **two** boarders, C1 and C2, both
with live hostel allocations (OP-08).

**Steps**
1. G opens the Consent screen and clicks "request a trip".
2. G confirms a child picker is drawn (it is only rendered when `children_.length > 1`, `Consent.tsx:264`).
3. G fills reason, leaving, back-by — and does **not** touch the picker. G attempts to submit.
4. **Then, bypassing the form**, G posts directly to `POST /api/v1/ops/hostel/outpasses` with `student_id: ""` and a valid reason and times.
5. Warden opens the outpass board and reads the `student_name` on the new pass.

**Expected**
- Step 3: the Send button is disabled — `student` is `''` until picked (`Consent.tsx:222`) and the guard at `Consent.tsx:316` includes `!student`. **This is the recent fix and it holds.**
- Step 4: **the server still creates a pass.** `createOutpass` catches the
  `uuid.Parse` failure and falls back to `res.StudentIDs[0]`
  (`internal/api/hostel_life.go:143-150`). Worse, `scope.Resolve` builds
  `StudentIDs` from a `UNION` with **no `ORDER BY`**
  (`internal/scope/scope.go:139-146`), so "the eldest sibling" is really
  "whichever row Postgres happened to return first" and may differ between calls.
- Step 5: the warden's board names a child the guardian never chose.

**This test is expected to FAIL against the current build.** The fix was applied
to the form only; the server-side default that the form was hiding is still
there. The correct behaviour is `400` when `student_id` is absent and the caller
has more than one child in scope.

**Negative (wrong child)** G posts `student_id` = a boarder belonging to another
family. Expect `404` — `!res.AllStudents && !res.OwnsStudent(student) && !id.Can(HostelWrite)`
(`hostel_life.go:151-155`), and a 404 rather than 403 so ids cannot be probed.

**Known gap** In a real tenant no guardian can reach this screen at all
(`00_TIMELINE.md:73-81`), which is the only thing currently limiting the blast
radius of the fallback above.

---

### OP-10 — A boarder cannot be signed out of the gate until both the warden has approved and a guardian has consented

**Roles** Parent → Institution Admin (warden) → gate

**Features** `institution_admin.hostel.digital_outpass_approval`, `parent.consent.digital_parent_consent_slips`

**Endpoints**
- `GET /api/v1/ops/hostel/outpasses` — `listOutpasses`, `internal/api/api.go:560` / `internal/api/hostel_life.go:58`
- `POST /api/v1/ops/hostel/outpasses/{id}/decide` — `decideOutpass`, `internal/api/api.go:562` / `internal/api/hostel_life.go:196`

**Setup** A pass created in OP-09 for boarder C1, status `requested`.

**Steps**
1. Warden posts `{"action":"out"}` immediately.
2. Warden posts `{"action":"approve"}`.
3. Warden posts `{"action":"out"}` again.
4. Guardian G posts `{"action":"consent"}`.
5. Warden posts `{"action":"out"}`, then `{"action":"in"}` on return.
6. On a second pass, warden posts `{"action":"reject"}` with no note.

**Expected** Steps 1 and 3 → `409 no_consent`, "the guardian has not consented
yet; a warden's permission alone is not enough to let a boarder off campus"
(`hostel_life.go:246-256`, `:283-285`). Step 5 succeeds, sets `status='out'`,
`actual_out=now()`, `gate_by` = the warden. `listOutpasses` then sorts the pass
to the top while it is out, and flags `overdue` once `expected_in < now()`
(`hostel_life.go:95-99`). Step 6 → `400 "say why it is being refused — a rejection
with no reason is an argument the warden has to have twice"` (`hostel_life.go:210-213`).

**Negative (wrong role)** Guardian G posts `{"action":"approve"}` → `403 "only the
hostel can permit or record a boarder's movement"` (`hostel_life.go:229-234`).
Guardian G posts `{"action":"consent"}` against **another family's** pass → `404`
via `errNotYourChild` (`hostel_life.go:259-270`).

---

### OP-11 — A warden must not be able to supply the guardian's consent (SAFEGUARDING)

**Roles** Institution Admin (warden)

**Features** `institution_admin.hostel.digital_outpass_approval`

**Endpoints** `POST /api/v1/ops/hostel/outpasses/{id}/decide` — `decideOutpass`, `internal/api/hostel_life.go:196`

**Setup** A pass in state `requested` for boarder C1. A warden account holding
`HostelWrite` and **no** guardian link (so `res.StudentIDs` is empty).

**Steps**
1. Warden posts `{"action":"approve"}`.
2. Warden posts `{"action":"consent"}`.
3. Warden posts `{"action":"out"}`.

**Expected — the requirement** Step 2 should be refused. The two approvals exist
precisely so that one person cannot supply both; the file's own doc comment says
so at `hostel_life.go:16-25` and `:189-195`.

**Expected — actual behaviour** Step 2 **succeeds**. The role gate reads
`if len(res.StudentIDs) == 0 && !staff` (`hostel_life.go:235-240`), so a staff
holder passes; and the ownership check inside the transaction is guarded by
`if req.Action == "consent" && len(res.StudentIDs) > 0` (`hostel_life.go:259`),
which a warden with no children skips entirely. Step 3 then finds both
`approved_at` and `guardian_consent_at` set and signs the child out.

**This test is expected to FAIL.** One member of staff can move a boarder from
`requested` to off-campus without any family involvement, and the audit trail
records the warden's user id in both `approved_by` and `guardian_consent_by`
(`hostel_life.go:264-270`, `:277-281`) — so it is at least detectable after the
fact. The fix is to require `res.OwnsStudent` for `consent` regardless of staff
capability.

---

### OP-12 — A visiting relative can be handed a boarder with no outpass at all (SAFEGUARDING)

**Roles** Institution Admin (warden)

**Features** `institution_admin.hostel.hostel_visitor_log`, `admissions.visitors.visitor_gate_pass_generation`

**Endpoints**
- `POST /api/v1/ops/hostel/visits` — `signHostelVisitorIn`, route `internal/api/infirmary.go:57`, handler `internal/api/infirmary.go:1327`
- `POST /api/v1/ops/hostel/visits/{id}/out` — `signHostelVisitorOut`, route `internal/api/infirmary.go:58`
- `GET /api/v1/ops/hostel/visits` — `listHostelVisits`, route `internal/api/infirmary.go:56`, handler `internal/api/infirmary.go:1249`
- Blocklist: `POST /api/v1/office/blocklist` — `addToBlocklist`, `internal/api/api.go:378` / `internal/api/front_office.go:224`
- Screen: `web/src/features/operations/HostelVisitors.tsx`

**Setup** Boarder C1 with a live allocation and **no** outpass in any state. A
named person on `visitor_blocklist`.

**Steps**
1. Warden signs in a visitor claiming to be C1's uncle, with `boarder_released: true` and an `expected_back` time.
2. Warden reads the visits list.
3. Warden signs in the blocklisted person.
4. Warden signs in a visitor with `boarder_released: true` and no `expected_back`.

**Expected** Step 1 **succeeds** and the child leaves the premises. There is no
join to `hostel_outpasses` anywhere in `signHostelVisitorIn` — the two registers
that both control a child leaving campus do not know about each other. Step 2
shows the child as released with an `overdue` flag once `expected_back < now()`
(`infirmary.go:1260-1261`). Step 3 → `409 visitor_blocked`, "this visitor is on
the school's block list and must not be admitted or given a boarder"
(`infirmary.go:1305-1306`, `:1349-1361`, `:1395-1396`). Step 4 → `400` naming
the missing hour (`infirmary.go:1307-1308`, `:1342-1345`).

**Negative (wrong role)** As `front_office` (no `HostelWrite`) step 1 → 403,
even though the same person may sign an ordinary visitor in at
`POST /api/v1/office/visitors` (`api.go:375`).

**Known gap — the chain is cut.** `grep -i outpass` over `internal/api/` outside
`hostel_life.go` finds it only in the hostel roll-call query (`infirmary.go:885,906,922,945`).
No gate scanner — `verifyCampusPass` (`portal_school_life.go:1628`),
`verifyEventPass` (`:1042`), `checkInEventTicket` (`student_learning.go:1752`) —
queries `hostel_outpasses`. The outpass decides which child leaves, and the gate
never asks.

---

### OP-13 — The night-study register knows who is out on an outpass; the mess menu is published

**Roles** Institution Admin (warden) → Student

**Features** `institution_admin.hostel.night_study_room_attendance`, `.hostel_roll_call_attendance`, `.mess_menu_meal_management`

**Endpoints**
- `GET /api/v1/ops/hostel/night-study` — `listNightStudy`, `internal/api/infirmary.go:51`
- `POST /api/v1/ops/hostel/night-study` — `markNightStudy`, `internal/api/infirmary.go:52`
- `GET /api/v1/ops/hostel/mess` — `listMessMenu`, `internal/api/api.go:566` / `internal/api/hostel_life.go:456`
- `PUT /api/v1/ops/hostel/mess` — `setMessMenu`, `internal/api/api.go:567` / `internal/api/hostel_life.go:493`
- Screens: `web/src/features/operations/HostelNightStudy.tsx`, `.../HostelLife.tsx`

**Setup** Three boarders. One of them (C1) currently `out` on an approved outpass from OP-10.

**Steps**
1. Warden opens the night-study register for tonight.
2. Warden marks the two present boarders and leaves C1 unmarked.
3. Warden publishes tomorrow's mess menu.

**Expected** Step 1: C1 is rendered with `on_outpass: true` and the caption
"Signed out on an outpass" (`HostelNightStudy.tsx:35,193-195`), computed from an
`EXISTS` over `hostel_outpasses` (`infirmary.go:885,906,922,945`), and is excluded
from the "unmarked" bulk action (`HostelNightStudy.tsx:266`). Marking C1 absent
would be the failure this design exists to prevent. Step 3 stores the menu and
it reads back from `listMessMenu`.

**Negative** As `student`: `GET /ops/hostel/night-study` → 403 (`HostelRead` not
held by the `student` role, `rbac.go:375-376`). Note this also means a boarder
cannot see the mess menu — `listMessMenu` is open on the route
(`api.go:566`, no `RequirePermission`) but sits under `/ops`, and there is no
student-facing mess key in the catalogue.

---

## Library

### OP-14 — Catalogue → issue → return → overdue → fine

**Roles** Institution Admin (librarian) → Student

**Features** `institution_admin.library.books_copies`, `.accession_register`, `.issue_return`, `.book_issue_return_terminal`, `.overdue_fine_calculation`, `.fines`

**Endpoints**
- `GET /api/v1/ops/library/titles` — `listLibraryTitles`, `internal/api/api.go:529` / `internal/api/mod_ops.go:1231`
- `GET /api/v1/ops/library/titles/{id}/copies` — `listTitleCopies`, `internal/api/api.go:530` / `internal/api/mod_ops.go:1271`
- `POST /api/v1/ops/library/issue` — `issueBook`, `internal/api/api.go:531` / `internal/api/mod_ops.go:874`
- `POST /api/v1/ops/library/loans/{id}/return` — `returnBook`, `internal/api/api.go:532` / `internal/api/mod_ops.go:958`
- `GET /api/v1/ops/library/loans` — `listLibraryLoans`, `internal/api/api.go:537` / `internal/api/role_backoffice.go:443`
- Screen: `web/src/features/operations/Library.tsx`

**Setup** A title with two copies. A student S.

**Steps**
1. Librarian searches the catalogue by title, author and ISBN.
2. Librarian opens the title and confirms both copies show `available`.
3. Librarian issues copy 1 to S with no `due_in_days`.
4. Librarian re-reads the loans list with `?open=true`.
5. Back-date the loan's `due_on` to yesterday (direct SQL — there is no endpoint to age a loan) and re-read.
6. Librarian returns the loan.

**Expected** Step 3 → `201 {"issued": true, "due_in_days": 14}` — the default is
14 (`mod_ops.go:886-888`) and the due date is computed as `CURRENT_DATE + $4` in
SQL (`mod_ops.go:918-920`). Copy 1 flips to `issued` (`mod_ops.go:928-929`).
Step 5: the loan reports overdue, computed at read time as
`returned_on IS NULL AND due_on < CURRENT_DATE` (`role_backoffice.go:443`) —
there is no `is_overdue` column and no nightly job. Step 6 stores
`fine_paise = GREATEST(0, CURRENT_DATE - due_on) * rate` (`mod_ops.go:978-982`)
and returns the copy to `available`.

**Negative** Issue copy 1 again while it is out → `409 already_issued`
(`mod_ops.go:894-901`, `:934-937`). Return the same loan twice → `404` (the
UPDATE is guarded by `returned_on IS NULL`). Issue as a `student` account → 403
(`operations.library.write` not held, `rbac.go:375-376`).

**Defect to record** The fine **rate** arrives in the request body
(`returnBookRequest`, `mod_ops.go:955-957`) defaulting to 100 paise, and the
screen hard-codes it (`Library.tsx`). There is no configuration row, so two
clerks can return the same overdue book at different rates. There is also no
renewal endpoint and no per-reader borrowing limit.

---

### OP-15 — A reserved copy goes to the reader who reserved it

**Roles** Institution Admin (librarian)

**Features** `institution_admin.library.reservations`, `.book_reservation_queue`

**Endpoints**
- `GET /api/v1/ops/library/reservations` — `listReservations`, `internal/api/api.go:541` / `internal/api/library_desk.go:49`
- `POST /api/v1/ops/library/reservations` — `placeReservation`, `internal/api/api.go:542` / `internal/api/library_desk.go:102`
- `POST /api/v1/ops/library/reservations/{id}/decide` — `decideReservation`, `internal/api/api.go:543` / `internal/api/library_desk.go:172`
- `promoteNextHold` — `internal/api/library_desk.go:252`
- Screen: `web/src/features/operations/LibraryDesk.tsx`

**Setup** A title with one copy, on loan to student S1. Students S2 and S3.

**Steps**
1. Librarian places a hold for S2, then for S3.
2. Librarian reads the reservation list and notes each hold's `position`.
3. Librarian places a second hold for S2 on the same title.
4. S1's loan is returned (OP-14 step 6).
5. Librarian re-reads the queue, then issues the copy to **S3**.
6. Librarian issues the copy to S2 instead.

**Expected** Step 1: both `waiting` (no copy free). Step 2: positions 1 and 2,
counted at read time (`library_desk.go:49-100`). Step 3 → `409 already_queued`.
Step 4: `promoteNextHold` runs inside the return transaction
(`mod_ops.go:988-993`, `library_desk.go:252`), promotes S2 (longest-waiting) to
`ready`, sets `collect_by = current_date + 3`, and puts the copy to `reserved`.
Step 5 → `409 held_for_another`, "that copy is behind the counter for a reader
who reserved it" (`mod_ops.go:906-916`, `:938-942`). Step 6 succeeds and closes
the hold to `collected` (`mod_ops.go:922-927`).

**Negative** `decide` with `action: "collect"` on a `waiting` hold → `409 wrong_state`
(`library_desk.go:172-250`). `placeReservation` with both `student_id` and
`employee_id`, or neither → 400.

**Defects to record** (a) The `held_for_another` check reads only
`res.student_id` (`mod_ops.go:906-912`), so a copy held for a **member of staff**
can be issued to a walk-in. (b) `issueBook` writes only `student_id`
(`mod_ops.go:917-921`), so a book cannot be lent to staff at all, though the
reservation queue accepts them. (c) `past_collection_date` is reported but
nothing reclaims the copy — ready holds expire only when somebody clicks.

---

### OP-16 — A library fine is never charged to the family (KNOWN BROKEN)

**Roles** Institution Admin (librarian) → Finance → Parent

**Features** `institution_admin.library.fines`, `.overdue_fine_calculation`

**Endpoints**
- `POST /api/v1/ops/library/loans/{id}/return` — `returnBook`, `internal/api/mod_ops.go:958`; fine written at `:980`
- `GET /api/v1/ops/library/loans` — `listLibraryLoans`, `internal/api/role_backoffice.go:443`
- Family ledger: `GET /api/v1/portal/family/...` (`internal/api/portal_family.go:59-70`)

**Setup** OP-14 completed, leaving a loan with `fine_paise > 0`.

**Steps**
1. Librarian confirms the fine on the loans screen and on the "fines owed" total.
2. Finance opens the student's fee ledger and searches for the amount.
3. Parent opens their fee screen and searches for the amount.
4. Finance attempts to collect the fine at the counter.

**Expected — statement of the defect** Steps 2, 3 and 4 find nothing. The value
is a number on `library_loans.fine_paise` and nowhere else: it is written only at
`mod_ops.go:980`, read only by `listLibraryLoans` and by two React tables, and
the "fines owed" figure on `Library.tsx` is a client-side `reduce`. `invoices.fine_paise`
is a different column fed only by the fee engine's late-fee path
(`internal/fees/fees.go:461`, `internal/fees/fines.go:134`); `grep -rn "library" internal/fees/`
returns nothing. No invoice, invoice line, fee head, payment or journal row is
created on return.

**Negative** Confirm there is also no waiver, no partial payment and no
lost/damaged charge — the fine is simply overwritten on each return.

**Known gap** `institution_admin.library.fines` is catalogued as *built* and is a
read-only view of an uncollectable number.

---

### OP-17 — A single-copy digital holding is lent to one reader at a time, and the audience rules decide who can see it

**Roles** Institution Admin (librarian)

**Features** `institution_admin.library.digital_e_book_journal_integration`

**Endpoints**
- `GET /api/v1/ops/digital-library/catalogue` — `listDigitalCatalogue`, `internal/api/digital_library.go:129` / `:288`
- `POST /api/v1/ops/digital-library/holdings` — `saveDigitalHolding`, `:141` / `:675`
- `PUT /api/v1/ops/digital-library/holdings/{id}/visibility` — `setDigitalVisibility`, `:143` / `:921`
- `GET /api/v1/ops/digital-library/audiences` — `listDigitalAudiences`, `:139` / `:1007`
- `POST /api/v1/ops/digital-library/holdings/{id}/borrow` — `borrowDigitalHolding`, `:131` / `:531`
- `GET /api/v1/ops/digital-library/holdings/{id}/access` — `openDigitalHolding`, `:130` / `:410`
- Screen: `web/src/features/operations/DigitalLibrary.tsx`

**Setup** Two staff accounts, both `librarian` (`rbac.go:358-359`).

**Steps**
1. Librarian creates an ebook holding with `access_model: single_copy_loan`, an `external_url` and `loan_days: 7`.
2. Librarian confirms a shadow `library_titles` row with one copy, accession `DIG-…`, rack `digital` (`digital_library.go:823`).
3. Librarian A borrows the holding, then the desk issues the shadow copy (`POST /ops/library/issue`).
4. Librarian A opens the holding.
5. Librarian B attempts to open it.
6. Librarian sets visibility restricted to one class, then re-reads the catalogue with `?manage=1` and without.
7. Librarian creates a holding with both an `external_url` and a `file_id`; and a `database` holding with `single_copy_loan`.

**Expected** Step 4 → the access grant. Step 5 → `409 not_borrowed`
(`digitalEntitlement`, `digital_library.go:376-408`). Concurrency is enforced by
the physical partial unique index `library_copy_active_loan` on
`library_loans(copy_id) WHERE returned_on IS NULL` (`migrations/00001_baseline.sql:2104`) —
there is no counter column. Step 6: `?manage=1` shows inactive holdings and the
visibility columns only because `librarian` is AND-ed with `LibraryWrite`
server-side (`digitalArgs`, `digital_library.go:199`), so the flag cannot be
forged. Step 7 → 400 on both ("exactly one of url/file", and `database` +
`single_copy_loan` is rejected).

**Negative (wrong audience)** A holding restricted to class 9 must not appear for
a caller with no class-9 enrollment in scope: `digitalVisibility`
(`digital_library.go:169-193`) ORs a role rule against a class rule and requires
an **active** enrollment. Also confirm an unknown role key passed to
`setDigitalVisibility` is silently dropped rather than rejected — record that as
a defect, because a typo produces a holding nobody can see with no error.

**Known gap** `open` and `subscription` access models have no concurrency limit at
all, and a holding attached to any provider is always refused with
`503 provider_unavailable` (`resolveDigitalProvider`, `digital_library.go:488`)
because no provider on this deployment is `live`.

---

### OP-18 — A student reserves a book from the portal; a student cannot reach the digital library at all

**Roles** Student → Institution Admin (librarian)

**Features** `student.notices_calendar.library_book_hold_request`, `institution_admin.library.book_reservation_queue`

**Endpoints**
- `GET /api/v1/portal/library/titles` — `listLibraryCatalogue`, `internal/api/student_learning.go:97` / `:2039`
- `GET /api/v1/portal/library/holds` — `listMyHolds`, `:98` / `:2089`
- `POST /api/v1/portal/library/holds` — `requestBookHold`, `:99` / `:2146`
- `POST /api/v1/portal/library/holds/{id}/cancel` — `cancelBookHold`, `:100` / `:2185`
- Screen: `web/src/features/learning/LibraryHolds.tsx`

**Setup** Student S with a portal login. A title with all copies on loan.

**Steps**
1. S searches the portal catalogue and confirms `holds_waiting` and `my_hold_status`.
2. S places a hold.
3. Librarian opens the desk queue and confirms S's hold is there.
4. S cancels the hold.
5. S attempts to cancel a hold belonging to another student.
6. S attempts `GET /api/v1/ops/digital-library/catalogue`.

**Expected** Step 2 succeeds: `requestBookHold` resolves the child through
`s.portalChild`, overwrites the body's `student_id` with the server-resolved id,
and delegates **in process** to `placeReservation` (`student_learning.go:2146-2218`),
so the portal inherits the `FOR UPDATE SKIP LOCKED` copy claim without holding
`library.write`. Step 3 shows one queue, not two. Step 4 delegates to
`decideReservation` with `action:"cancel"`, freeing the copy and promoting the
next reader. Step 5 → `404`, never 403 (`student_learning.go:2185-2215`).
Step 6 → **403**.

**Known gap — the chain is cut.** The `student` and `parent` roles hold no
`operations.library.read` (`rbac.go:375-378`), and the whole digital library is
mounted under `/ops` (`api.go:528`). There is also no student- or parent-facing
catalogue key for it — `digitalLibraryKeys` maps only
`institution_admin.library.digital_e_book_journal_integration`
(`web/src/features/operations/digital-library-keys.ts:27-31`). So the class-based
and role-based visibility machinery of OP-17 targets an audience that cannot
reach the endpoint. "A digital holding borrowed by a pupil" is untestable.

---

## Infirmary

### OP-19 — A child is seen, and a child who leaves the school's care cannot be signed out until the family has been told

**Roles** Institution Admin (nurse)

**Features** `institution_admin.infirmary.daily_nurse_visit_log`, `.student_health_master_file`

**Endpoints**
- `GET /api/v1/ops/infirmary/visits` — `listInfirmaryVisits`, route `internal/api/infirmary.go:37`, handler `internal/api/infirmary.go:133`
- `POST /api/v1/ops/infirmary/visits` — `recordInfirmaryVisit`, route `internal/api/infirmary.go:38`, handler `internal/api/infirmary.go:199`
- `GET /api/v1/ops/health/students` — `listHealthRecords`, route `internal/api/api.go:568`, handler `internal/api/mod_ops.go:1366`
- Screens: `web/src/features/operations/InfirmaryClinic.tsx`, `.../Infirmary.tsx`

**Setup** A `nurse` account (`rbac.go:369-370`, `HealthRead` + `HealthWrite`).
Student S with `student_health.allergies` populated.

**Steps**
1. Nurse opens today's register before any visit.
2. Nurse records a visit for S with a complaint and outcome `returned_to_class`.
3. Nurse confirms S's recorded allergies and blood group appear on the row.
4. Nurse records a second visit with outcome `sent_home` and `parent_informed: false`.
5. Nurse records it again with `parent_informed: true`.
6. Nurse records a visit with outcome `referred` and no `referred_to`.
7. Nurse records a visit with outcome `gone_home`.

**Expected** Step 1: empty, defaulting to the Indian date, not UTC
(`indiaToday`, `infirmary.go:66`) — a box running UTC would blank the register at
half past five in the evening. Step 3: allergies, chronic conditions and blood
group are **joined live from `student_health`**, never copied
(`infirmary.go:151-155`, and the file's note at `:24-28`). Step 4 → `400`,
"a child who leaves the premises cannot be signed out until the family has been
told" (`infirmary.go:195-196`, `:224-227`). Step 5 succeeds and the server stamps
the hour itself (`CASE WHEN $13 THEN now() END`, `infirmary.go:243`) so a visit
cannot claim the family was told an hour before anyone rang. Step 6 → `400`
"name where the child was sent" (`infirmary.go:228-232`). Step 7 → `400 "unknown outcome gone_home"`.

**Negative** As `class_teacher` (no `HealthRead`, `rbac.go:329-333`) → 403 on
step 1. As `nurse`, `?student_id=not-a-uuid` → `400`, deliberately not a silent
widening to every clinical record in the school (`optionalUUID`, `infirmary.go:78-92`).

---

### OP-20 — A dose is recorded against a named authority, and an emergency dose must say why it could not wait

**Roles** Institution Admin (nurse)

**Features** `institution_admin.infirmary.medication_admin_register`

**Endpoints**
- `GET /api/v1/ops/infirmary/medications` — `listMedicationRegister`, route `internal/api/infirmary.go:39`, handler `internal/api/infirmary.go:285`
- `POST /api/v1/ops/infirmary/medications` — `recordMedication`, route `internal/api/infirmary.go:40`, handler `internal/api/infirmary.go:~380`

**Setup** Student S from OP-19, with a recorded allergy.

**Steps**
1. Nurse records a dose with `authority: "doctor_prescription"` and an authorised-by name.
2. Nurse reads today's register and confirms S's allergy is shown on the row.
3. Nurse records a dose with `authority: "emergency"` and empty notes.
4. Nurse records a dose with `authority: "because matron said so"`.
5. Nurse reads the register with `?incidents=true`.

**Expected** Step 2: the allergy is projected from `student_health`
(`infirmary.go:280-282,306`) so the row that should stop somebody is visible at
the trolley. Step 3 → `400`, "an emergency dose given without anyone's permission
must say in the notes why it could not wait" (`infirmary.go:355`, `:405-408`).
Step 4 → `400` naming the four permitted authorities (`infirmary.go:352`, `:392-394`).
Step 5 returns refusals and adverse reactions **across the whole period**, not
one day (`infirmary.go:296-298`, `:310-312`) — the review view, not the trolley view.

**Negative** As `counsellor` (`HealthRead` but not `HealthWrite`, `rbac.go:367-368`):
step 1 → 403, step 2 → 200. That is the intended split.

---

### OP-21 — The `operations` role reaches every child's full clinical history (SAFEGUARDING — EXPECTED TO FAIL)

**Roles** Institution Admin (operations generalist)

**Features** `institution_admin.infirmary.daily_nurse_visit_log`, `.medication_admin_register`, `.student_health_master_file`

**Endpoints**
- `GET /api/v1/ops/infirmary/visits?student_id={any}` — `listInfirmaryVisits`, `internal/api/infirmary.go:37` / `:133`
- `GET /api/v1/ops/infirmary/medications?student_id={any}` — `listMedicationRegister`, `internal/api/infirmary.go:39` / `:285`
- `GET /api/v1/ops/health/students` — `listHealthRecords`, `internal/api/api.go:568` / `internal/api/mod_ops.go:1366`

**Setup** An account holding **only** the seeded `operations` role
(`internal/rbac/rbac.go:316-320`), which carries `AcademicsRead, StudentsRead,
StudentsReadAll, LibraryRead, LibraryWrite, TransportRead, TransportWrite,
HostelRead, HostelWrite, InventoryRead, InventoryWrite, AssetsWrite, HealthRead,
SelfProfileRead, SelfProfileWrite`. In a real school this is the storekeeper, the
transport clerk and the library assistant. Several children with visit histories,
allergies and chronic conditions.

**Steps**
1. Sign in as the operations account. Confirm it holds no `HealthWrite` — `POST /ops/infirmary/visits` → 403.
2. `GET /api/v1/ops/infirmary/visits` with no parameters.
3. `GET /api/v1/ops/infirmary/visits?student_id={a child this person has no relationship to}`.
4. `GET /api/v1/ops/infirmary/medications?student_id={the same child}`.
5. `GET /api/v1/ops/health/students?flagged=true`.

**Expected — the requirement** Steps 3–5 should be refused, or narrowed to
children this person has a stated reason to see.

**Expected — actual behaviour** All four succeed. `listInfirmaryVisits` calls
`s.resolveScope` **not at all**; its `WHERE` is only
`($1 IS NULL AND v.on_date = $2) OR ($1 IS NOT NULL AND v.student_id = $1)`
(`infirmary.go:156-158`) with no `AllStudents`, `StudentIDs` or section term. Step 3
returns that child's **entire history** — every complaint, observation, treatment,
referral and outcome — together with `sh.allergies`, `sh.chronic_conditions` and
`st.blood_group` (`infirmary.go:151-155`). Step 4 is the same shape
(`infirmary.go:308-312`). Step 5 lists every child in the school with an allergy
or a chronic condition plus the family doctor's name and telephone
(`mod_ops.go:1370-1388`).

**This test is expected to FAIL.** The route gate is `HealthRead`, which the
comment at `infirmary.go:34-36` describes as held by "the nurse, the counsellor
and operations" — and the third of those was never meant to read a case history.
Contrast `internal/api/portal_school_life.go:30-38`, where every family-facing
handler resolves scope and applies `OwnsStudent`; and contrast the ID card
(`portal_school_life.go:1441-1445`), which deliberately carries blood group and
allergies but withholds chronic conditions and medication because a card is left
on a bus seat. Here there is no such judgement at all.

**Negative (wrong role)** As `librarian` (`rbac.go:358-359`, no `HealthRead`) →
403 on all five. That confirms the gate works; the defect is who is behind it.

---

### OP-22 — An `AuditRead`-only role must not be able to read a clinical record through the audit trail (SAFEGUARDING — EXPECTED TO FAIL)

**Roles** Super Admin (IT administrator) / vendor support

**Features** `super_admin.access_security.*` audit viewer

**Endpoints**
- `GET /api/v1/admin/audit` — `listAudit`, route `internal/api/api.go:640`, handler `internal/api/audit.go:250`
- `GET /api/v1/admin/audit/summary` — `getAuditSummary`, route `internal/api/api.go:641`, handler `internal/api/audit.go:275`
- Redaction: `confidentialBody`, `internal/api/audit.go:100-112`; applied at `internal/api/audit.go:206-208`
- Entity derivation: `entityFor`, `internal/api/audit.go:53-62`
- Unit test asserting the intent: `internal/api/audit_confidential_test.go:5-13`

**Setup** An `it_admin` account (`rbac.go:302-305`) — `AuditRead` and nothing
clinical; it cannot open a student record at all. A nurse has recorded at least
one infirmary visit and one counselling message today.

**Steps**
1. As it_admin, `GET /api/v1/admin/audit/summary` and list the entity types present.
2. `GET /api/v1/admin/audit?entity=infirmary.visits`.
3. `GET /api/v1/admin/audit?entity=ops.infirmary`.
4. `GET /api/v1/admin/audit?entity=comms.counselor`.
5. `GET /api/v1/admin/audit?q=infirmary` (the `action` column is `POST /api/v1/ops/infirmary/visits`).

**Expected — the requirement** No request body containing a complaint,
observation, treatment or the identity of the child seen may be returned to a
holder of `AuditRead` alone. The `before`/`after` columns must read
`"[withheld: a confidential record…]"` (`audit.go:114-116`).

**Expected — actual behaviour**
- Step 2 returns **nothing** — but not because it was withheld. `entityFor`
  strips only `/api/v1` and takes the first two path segments
  (`audit.go:53-62`), so the real path `/api/v1/ops/infirmary/visits` yields the
  entity `ops.infirmary`. No row was ever stored as `infirmary.visits`.
- Step 3 returns the rows, **with the full body**. `confidentialBodyPrefixes` is
  `["/api/v1/infirmary/", "/api/v1/comms/counselor/"]` (`audit.go:100-103`), but
  the infirmary is mounted inside `r.Route("/ops")` (`internal/api/api.go:526-527`,
  `internal/api/infirmary.go:32-46`). `strings.HasPrefix("/api/v1/ops/infirmary/visits",
  "/api/v1/infirmary/")` is false, so the redaction never fires — the complaint,
  observations, treatment, outcome and `student_id` are all in the trail.
- Step 4 is correctly withheld: `/api/v1/comms/counselor/...` really is mounted at
  that path (`internal/api/comms.go:131`), so that half of the fix works.
- Step 5 finds the same unredacted rows by a different route.

**This test is expected to FAIL for the infirmary half and pass for the
counselling half.** The unit test at `audit_confidential_test.go:7-8` asserts
`confidentialBody("/api/v1/infirmary/visits")` — a path the router does not
serve — so it passes while the deployed behaviour is wrong. The fix is either
`/api/v1/ops/infirmary/` in the prefix list or a suffix/contains match; the test
should then be re-run against the real path taken from `api.go:526` plus
`infirmary.go:37`.

**Negative** Confirm an ordinary change is **not** redacted: `?entity=fees.payments`
must still show the amount and reason (`audit_confidential_test.go:15-24`), and
`?entity=comms.grievances` must still show its payload. Over-redacting is its own
failure. Confirm also that password fields are `[redacted]` everywhere
(`redactKeys`, `audit.go:70-74`).

---

### OP-23 — The guardian is never actually informed (KNOWN BROKEN)

**Roles** Institution Admin (nurse) → Parent

**Features** `institution_admin.infirmary.emergency_health_alerts`, `parent.home.real_time_push_notifications`

**Endpoints**
- `POST /api/v1/ops/infirmary/visits` — `recordInfirmaryVisit`, `internal/api/infirmary.go:199`
- Parent alert feed: `GET /api/v1/portal/notifications` — `listFamilyNotifications`, `internal/api/portal_school_life.go:95`

**Setup** A demo-seeded guardian G with a portal login, child S.

**Steps**
1. Nurse records a visit for S with outcome `hospitalised` and `parent_informed: true`.
2. G opens the parent notification feed.
3. G looks for the visit anywhere in the portal.
4. Check the message log (`GET /api/v1/admin/messaging/log`) for anything referring to the visit.

**Expected — statement of the defect** Steps 2, 3 and 4 find nothing.
`internal/api/infirmary.go` contains **zero** calls to `notify(` or
`EmitMessageEvent` — `grep -c` returns 0. `parent_informed_at` is a server-stamped
timestamp recording that somebody says they telephoned; it is not a delivery.
There is no parent-facing infirmary key in the catalogue at all. The only health
data a family ever sees is blood group and allergies on the digital ID card
(`portal_school_life.go:1446`).

**Known gap** This is the same shape as the discipline gap recorded at
`docs/gap_analysis/02_onboarding_daily.md` ("Discipline follows the child but
never reaches the parent"): the record is good, the seam to the family is a
checkbox. `institution_admin.infirmary.emergency_health_alerts` is catalogued as
*built* and resolves to `web/src/features/operations/Infirmary.tsx`
(`web/src/features/registry.ts:297`), a staff screen.

---

## Canteen and the school store

### OP-24 — A till session is opened, and only one at a time per counter

**Roles** Finance (counter clerk)

**Features** `finance.collections.pos_canteen_terminal_integration`, `.school_store_merchandise_sales`

**Endpoints**
- `GET /api/v1/finance/collections/terminals` — `listPosTerminals`, `internal/api/collections.go:3304` / `:322`
- `POST /api/v1/finance/collections/terminals` — `savePosTerminal`, `:3305` / `:346`
- `POST /api/v1/finance/collections/sessions` — `openTillSession`, `:3311` / `:563`
- `GET /api/v1/finance/collections/sessions` — `listTillSessions`, `:3307` / `:473`
- Screens: `web/src/features/finance/CanteenTerminal.tsx`, `web/src/features/finance/SchoolStore.tsx`

**Setup** A `finance` account (`rbac.go:344-347`). Note the `/finance` group
requires `InvoicesRead` (`api.go:294`) **in addition** to each route's own
permission, so a role with `PaymentsWrite` but no `InvoicesRead` cannot open a till.

**Steps**
1. Clerk creates a counter of kind `canteen`.
2. Clerk attempts to create a counter of kind `tuckshop`.
3. Clerk opens a till on that counter with an opening float.
4. A second clerk attempts to open a till on the same counter.
5. Clerk attempts to open a till with a negative float.
6. Clerk attempts to open a till on a retired counter.

**Expected** Step 2 → `400 "a counter is either a canteen or a store"`
(`collections.go:364-365`). Step 4 → refusal naming the holder: "%s already has
that till open -- cash it up first" (`collections.go:598`), backed by a partial
unique index so a race cannot produce two. Step 5 → 400 (`colMoney`, non-negative).
Step 6 → "that counter is retired…".

**Negative** As `operations` (holds `InventoryRead`/`InventoryWrite` but no
`FeesRead`/`PaymentsWrite`, `rbac.go:316-320`) → 403 on every route above. The
store clerk who counts the stock is not the person who takes the money.

---

### OP-25 — Items are sold for cash and charged to a student account, and the charge reaches the fee ledger and the parent

**Roles** Finance (counter clerk) → Finance → Parent

**Features** `finance.collections.pos_canteen_terminal_integration`, `.school_store_merchandise_sales`, `parent.fees.child_daily_cafeteria_purchase_timeline`

**Endpoints**
- `POST /api/v1/finance/collections/sales` — `recordPosSale`, `internal/api/collections.go:3317` / `:1629`
- `GET /api/v1/finance/collections/sales/{id}` — `getPosSale`, `:3318` / `:1249`
- `GET /api/v1/portal/family/cafeteria/purchases` — `listCafeteriaPurchases`, `internal/api/portal_school_life.go:100` / `:2010`
- Screen: `web/src/features/portal/Cafeteria.tsx`

**Setup** OP-24's open canteen till. `collections_settings.canteen_fee_head_id`
set (`collections.go:3301` / `:243`). Student S with a demo-seeded guardian G.
A store variant with 3 units in stock.

**Steps**
1. Clerk sells two canteen items to S with `payment_mode: "cash"`.
2. Clerk sells one canteen item to S with `payment_mode: "account"`.
3. Clerk attempts an `account` sale with no student named.
4. Clerk attempts `payment_mode: "card"`.
5. Clerk attempts to sell 5 units of the 3-in-stock variant.
6. Clerk attempts a sale totalling zero.
7. Finance opens S's fee ledger.
8. G opens the cafeteria timeline.

**Expected** Steps 1 and 2 → `201` with a receipt number from the gapless `pos`
series (`fees.NextNumberOn`). Step 3 → `400 "a charge needs an account to charge
-- pick the child"`. Step 4 → the explicit refusal at `collections.go:1650`:
"this counter takes cash or charges the child's fee account. There is no wallet
and no card" — `finance.collections.cashless_campus_wallet` is deliberately
blocked for want of a payment gateway (`collections.go:52`). Step 5 → "only 3 of
X left on the shelf". Step 6 → "a sale of nothing is not a sale". Step 7: the
`account` sale has raised a fee invoice against the canteen head
(`colChargeToAccount`, `collections.go:1531-1545`); the cash sale has **not**.
Step 8: **both** sales appear, because canteen sales for a named student are
mirrored to `cafeteria_purchases` (`colMirrorToCafeteria`, `collections.go:1773`).

**Negative (wrong child)** G requests `?student_id=` another family's child →
`404`, never 403 (`familyChildren`, `portal_school_life.go:116-134`). G with no
`student_id` sees the whole family and nobody else — the query binds
`p.student_id = ANY($1)` from server-resolved ids (`portal_school_life.go:2029`).

**Known gap** In a real tenant step 8 is unreachable — no guardian has a login
(`00_TIMELINE.md:73-81`).

---

### OP-26 — The till is closed and reconciled against what was counted, and a discrepancy must be explained

**Roles** Finance (counter clerk) → Finance (accountant)

**Features** `finance.collections.pos_canteen_terminal_integration`

**Endpoints**
- `POST /api/v1/finance/collections/sessions/{id}/close` — `closeTillSession`, `internal/api/collections.go:3313` / `:639`
- `GET /api/v1/finance/collections/sessions/variance` — `getTillVariance`, `:3310` / `:757`
- `GET /api/v1/finance/collections/settings` — `getCollectionsSettings`, `:3300` / `:207` (holds `variance_tolerance_paise`, default 5000 = ₹50)
- `POST /api/v1/finance/collections/sales/{id}/return` — `returnPosSale`, `:3319` / `:1855`

**Setup** OP-25's session: one cash sale, one account sale, a known opening float.

**Steps**
1. Clerk closes the till with `counted_cash_paise` equal to float + cash sales.
2. On a second session, clerk closes with a counted figure ₹200 short and no reason.
3. Clerk retries with a `variance_reason`.
4. On a third session, clerk closes ₹10 short with no reason (tolerance ₹50).
5. Clerk attempts to close session 1 again.
6. Accountant opens the variance report.
7. Clerk attempts a refund against a closed session.

**Expected** Step 1: variance zero. The expected figure is
`opening_float + cash sales − cash returns − paid_out`, summed **only over
`payment_mode = 'cash'`** (`collections.go:639-745`) — the account sale is
correctly excluded, because that money was never in the drawer. Step 2 → refused,
"the drawer is short by ₹200 -- say what happened before closing". Step 3 succeeds
and freezes the expected figure onto the row so it is not recomputed on read.
Step 4 succeeds and auto-fills "Within tolerance; not investigated." Step 5 →
"that till has already been cashed up" (`collections.go:745`). Step 6 shows only
sessions outside tolerance, ordered by absolute variance rather than by date.
Step 7 → "that till is cashed up -- open a session before refunding".

**Negative** A return of more units than were sold → "only N of X can still come
back". A return against an `account` sale whose invoice is already paid → refused,
with an instruction to refund in cash (`collections.go:1855-1950`) — the handler
will not push a paid invoice into credit. `RefundsWrite` is required for returns
(`collections.go:3319`) and `finance` holds it; a clerk granted only
`PaymentsWrite` gets 403.

**Defect to record** There is no cash-denomination breakdown anywhere —
`grep -rn denomination` over the repo returns nothing. Reconciliation is a single
counted total, so a note-by-note cash-up sheet has to live on paper.

---

## Mid-day meal

### OP-27 — The daily register is kept, closed, and reopened only with a reason

**Roles** Institution Admin

**Features** `institution_admin.mid_day_meal.mid_day_meal_register`

**Endpoints**
- `GET /api/v1/mdm-register/days` — `listMDMRegisterDays`, `internal/api/mdm.go:82` / `:264`
- `GET /api/v1/mdm-register/context` — `getMDMRegisterContext`, `:84` / `:451`
- `POST /api/v1/mdm-register/days` — `saveMDMRegisterDay`, `:86` / `:604`
- `POST /api/v1/mdm-register/days/{id}/close` — `closeMDMRegisterDay`, `:87` / `:838`
- `POST /api/v1/mdm-register/days/{id}/reopen` — `reopenMDMRegisterDay`, `:88` / `:905`
- Screen: `web/src/features/operations/MDMRegister.tsx`

**Setup** An account with `ReportsRead` (the group gate, `mdm.go:76-80`) and
`InstitutionWrite` (the write gate). A campus the account is posted to, and one
it is not. Two sections with known present counts.

**Steps**
1. Post today's register with enrolled/present/meals and per-section lines.
2. Post a register for tomorrow's date.
3. Post a section line where meals exceed present.
4. Post two lines naming the same section.
5. Post to the campus the account is not posted to.
6. Close the day. Close it again.
7. Reopen with no reason; then with a reason.
8. Close a day on which zero meals were served, with no `not_served_reason`.

**Expected** Step 1: the header present/meals figures are **recomputed from the
lines**, not trusted from the header (`mdm.go:604-836`). Step 2 → 400, a future
day is refused (`mdm.go:617`). Step 3 → `400 errMDMLineSum`, "a section cannot be
served more meals than it had children present". Step 4 → 400 on the duplicate.
Step 5 → `403 "you are not posted to that campus"` (`campusReach`, `mdm.go:114-145`).
Step 6 second call → `409 register_closed`. Step 7 first call → 400 "say why this
day is being reopened"; second call writes an `mdm_register_amendments` row with
action `reopen`, the reason and a JSON `before` snapshot, then sets status `open`
— note it is **not** an undo, the figures are unchanged. Step 8 → `409 reason_required`.

**Negative** Editing a **closed** day → `409 register_closed`. Amending a day that
already carries amendments without a `reason` → `409 reason_required`. Negative
figures for enrolled, present, meals, cost or rice → 400. A brand-new day with a
missing figure is refused rather than zeroed (`mdmInt`, `mdm.go:998`).

---

### OP-28 — The monthly utilisation return is computed, finalised and frozen

**Roles** Institution Admin

**Features** `institution_admin.mid_day_meal.mdm_utilisation_report`

**Endpoints**
- `GET /api/v1/admin-ops/mdm/utilisation` — `getMDMUtilisation`, `internal/api/admin_ops.go:191` / `:1735`
- `GET/POST /api/v1/admin-ops/mdm/returns` — `listMDMReturns` / `saveMDMReturn`, `:192,:193` / `:2055,:2091`
- `POST /api/v1/admin-ops/mdm/returns/{id}/finalise` — `finaliseMDMReturn`, `:194` / `:2169`
- `POST /api/v1/admin-ops/mdm/returns/{id}/reopen` — `reopenMDMReturn`, `:195` / `:2229`
- `GET/POST /api/v1/admin-ops/mdm/foodgrain` — `:198,:199` / `:2362,:2394`
- Screen: `web/src/features/operations/MDMUtilisation.tsx`

**Setup** A month of register days from OP-27. A foodgrain receipt with a challan
number. An `mdm_norms` row for the stage.

**Steps**
1. Read the utilisation for the month and note the `checks[]` warnings.
2. Record a foodgrain receipt; record a second with the same challan number.
3. Save a draft return; finalise it with the computed figures.
4. Attempt to save the finalised return.
5. Attempt to finalise it again.
6. Reopen with a reason, and confirm `filed_figures` is cleared.
7. Finalise with an empty `figures` body.

**Expected** Step 1 emits severity-tagged reconciliation warnings computed live
from `mdm_registers` + `mdm_foodgrain_receipts` + `mdm_norms` + the holiday
calendar (`mdmCheck`, `admin_ops.go:1703`). Step 2 second call → unique challan
violation surfaced as a sentence (`mdm_foodgrain_receipts_challan`, `admin_ops.go:80`).
Step 3 freezes the month. Step 4 → refused by the `mdm_monthly_returns_frozen`
trigger, translated into a sentence. Step 5 → "this return is already finalised —
reopen it first". Step 6 clears `filed_figures` and appends "Reopened: …" to
remarks. Step 7 → 400, "the computed return must be supplied so it can be frozen".

**Defect to record** `finaliseMDMReturn` takes `figures` from the client
**verbatim** and does not recompute them from the register
(`admin_ops.go:2169-2228`). A tester should confirm that a return finalised with
figures that contradict `getMDMUtilisation` is accepted without complaint. The
freeze is real; what is frozen is whatever the browser sent.

---

## Communication

### OP-29 — A circular is published, and the author is told how many people it actually reached

**Roles** Institution Admin

**Features** `institution_admin.communication.circulars_announcements`

**Endpoints**
- `POST /api/v1/communication/circulars` — `publishCircular`, route `internal/api/api.go:481`, handler `internal/api/mod_ops.go:72`; recipient SQL `internal/api/mod_ops.go:50-65`, count at `:113-116`
- `GET /api/v1/communication/circulars` — `listCirculars`, route `internal/api/api.go:479`, handler `internal/api/mod_ops.go:221`
- Screen: `web/src/features/comms/Circulars.tsx:49,54`

**Setup** Two sections, each with children whose guardians are **demo-seeded with
logins**, plus at least one child whose guardian has a phone number and no login.

**Steps**
1. Admin publishes a circular to `audience_role: "parents"`, targeted at section A, `requires_ack: true`, `send_sms: true`.
2. Admin notes the `recipients` count returned.
3. Admin publishes a circular to `audience_role: "staff"` and notes the count.
4. Admin attempts to publish with an empty title or body.
5. Admin attempts to schedule the circular for next Monday, or to set an expiry.

**Expected** Step 2: the count is `count(*)` over the recipient CTE, which
**inner-joins** `guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL`
(`mod_ops.go:50-58`). A guardian with a phone and no account is therefore missing
from both the count and the SMS fan-out — even though SMS needs no login. Record
that as the defect: the SMS channel is gated on account existence. Step 3
returns `recipients: 0` — `audience_role IN ('staff','faculty')` matches neither
branch of the UNION, so a staff circular queues no messages at all. Step 4 → 400.
Step 5: there is no control and no field. `publishCircular` hard-codes
`publish_at = now()` and never writes `expires_at` (`mod_ops.go:92-98`), although
both columns exist (`migrations/00001_baseline.sql:193-194`) and the read side
filters on them.

**Negative** As `faculty` — `AnnouncementsWrite` is held (`rbac.go:325-327`), so
publishing succeeds; the teacher's own path is
`POST /api/v1/teaching/broadcasts` (`internal/api/faculty_comms.go:78-79` / `:975`),
which is the only writer of per-child targeting (`announcement_students`). As
`student` → 403.

**Known gap** In a real tenant every circular reaches zero people
(`00_TIMELINE.md:78-81`).

---

### OP-30 — A parent sees notices for their own children only (SAFEGUARDING)

**Roles** Institution Admin → Parent

**Features** `parent.messages.communication`, `institution_admin.communication.circulars_announcements`

**Endpoints**
- `GET /api/v1/communication/circulars` — `listCirculars`, route `internal/api/api.go:479` (**no permission on the route** — auth only), handler `internal/api/mod_ops.go:221`; family branch selected at `:232-234`, family `WHERE` built at `:247-266` and spliced at `:278`
- Screen: `web/src/features/comms/Circulars.tsx`

**Setup** A demo-seeded guardian G with one child in section A. Six announcements
seeded directly (several cannot be created through `publishCircular` — see OP-29):
1. untargeted, `audience_role: 'all'`, live;
2. targeted at section A, `audience_role: 'parents'`, live;
3. targeted at section B, `audience_role: 'parents'`, live;
4. `audience_role: 'staff'`, live;
5. `audience_role: 'all'`, `publish_at` next Monday;
6. `audience_role: 'all'`, `expires_at` yesterday.

**Steps**
1. G lists circulars.
2. G confirms which of the six appear.
3. G acknowledges notice 2.
4. G posts an acknowledgement for notice 4 (the staff-only one) by id.
5. Admin re-reads the list and inspects notice 4's acknowledgement count.

**Expected** Step 2: **notices 1 and 2 only.** The family branch requires
`publish_at <= now()`, `expires_at IS NULL OR expires_at > now()`, an audience of
`all` or a role the caller actually is, and either no targeting at all or a
targeting row matching one of `res.StudentIDs` through an **active** enrolment
(`mod_ops.go:247-266`). Notice 3 fails the section test, 4 the audience test, 5
the publish window, 6 the expiry. Step 3 upserts on the full primary key
`(announcement_id, user_id, student_id)` (`mod_ops.go:329-334`), so acknowledging
twice is idempotent and a parent of two acknowledges once per child.

**Negative (wrong child)** G acknowledges with `?student_id=` another family's
child → `404`, validated by `res.OwnsStudent` (`mod_ops.go:315-322`).

**Defect to record** Step 4 **succeeds**. `ackCircular` never checks that the
announcement is one the caller can read; it validates only the child. Nothing is
disclosed back (the response is a flat `{"acknowledged": true}`), but the office's
acknowledgement counter at `mod_ops.go:272` can be inflated against a notice the
family was never shown.

**Also test** Repeat step 1 as `front_office`. A non-family caller gets
`where = "TRUE"` (`mod_ops.go:230`) and therefore the whole institution register
**including future-dated and expired notices**. That is defensible for the office
but must be confirmed deliberate, because it is the mirror image of the leak this
test exists to catch.

---

### OP-31 — A parent raises a grievance; it is triaged against an SLA, escalated and resolved

**Roles** Parent → Institution Admin (front office) → Parent

**Features** `parent.messages.concerns_grievance_ticketing`, `institution_admin.communication.parent_feedback_grievance_hub`

**Endpoints**
- `POST /api/v1/portal/family/concerns` — `raisePortalConcern`, route `internal/api/portal_requests.go:79`, handler `internal/api/portal_requests.go:709`
- `GET /api/v1/comms/grievances` — `listParentFeedback`, route `internal/api/comms.go:70`, handler `internal/api/comms.go:224`
- `PUT /api/v1/comms/grievances/{id}/triage` — `triageParentFeedback`, `internal/api/comms.go:77` / `:452`
- `POST /api/v1/comms/grievances/{id}/acknowledge` / `/escalate` / `/resolve` — `internal/api/comms.go:79-81`
- `GET /api/v1/comms/grievance-sla` — `listFeedbackSLA`, `internal/api/comms.go:90` / `:1006`
- `GET /api/v1/portal/comms/grievances/{id}` — `getPortalFeedback`, `internal/api/comms.go:148` / `:1112`
- `POST /api/v1/portal/comms/grievances/{id}/satisfaction` — `rateFeedbackResolution`, `internal/api/comms.go:149` / `:1191`

**Setup** A demo-seeded guardian G with child S. An SLA policy for the category
`transport` with respond and resolve hours and a default owner.

**Steps**
1. G raises a concern in category `transport`, naming S, with priority `urgent`.
2. G raises a concern in category `nonsense`.
3. Front office lists the queue and opens the case.
4. Front office triages it — category, department, assignee.
5. Front office acknowledges, then escalates, then resolves.
6. G opens the case and rates the resolution.
7. Front office lists with `?overdue=true`.

**Expected** Step 1: the priority is silently downgraded to `normal` —
"a queue where every family's concern arrives urgent is a queue with no priority
at all" (`portal_requests.go:727-730`). The named child is validated by
`s.portalChild` (`portal_requests.go:736-746`). Step 2 → `400 "choose one of the
listed categories"` (`concernCategories`, `portal_requests.go:702-707`). Step 4:
`respond_due_at` and `resolve_due_at` are set from the SLA policy for the
category, and the default owner is applied when no assignee is named
(`comms.go:519-540`). Step 7 returns only cases past `resolve_due_at` and unresolved
(`comms.go:268-269`).

**Negative (wrong child)** G raises a concern naming another family's child →
`404`. G opens another family's grievance id at
`GET /api/v1/portal/comms/grievances/{id}` → `404`.

---

### OP-32 — A grievance about a member of staff is invisible to that member of staff (SAFEGUARDING)

**Roles** Parent → Institution Admin → the accused member of staff

**Features** `institution_admin.communication.parent_feedback_grievance_hub`

**Endpoints**
- `GET /api/v1/comms/grievances` — `listParentFeedback`, route `internal/api/comms.go:70`, handler `:224`; exclusion at `:264-266`
- `GET /api/v1/comms/grievances/{id}` — `getParentFeedback`, `internal/api/comms.go:308`
- `GET /api/v1/comms/grievances/{id}/updates` — `listFeedbackUpdates`, `internal/api/comms.go:379`; exclusion at `:396-400`
- `GET /api/v1/comms/grievances/summary` — `getFeedbackSummary`, route `internal/api/comms.go:71`, handler `:948`; exclusion at `:974-976`
- `PUT /api/v1/comms/grievances/{id}/triage` — `triageParentFeedback`, `internal/api/comms.go:452`; the `FOR UPDATE` read is under the same exclusion at `:498-505`
- Subject resolution: `callerEmployeeID`, `internal/api/comms.go:167`

**Setup** Teacher T holds `FrontDeskRead` and `FrontDeskWrite` (grant them
explicitly — this is the scenario where a senior teacher also runs the front
desk). A parent raises a grievance; the office triages it with
`subject_employee_id` = T's employee id. A second, unrelated grievance exists in
the same category.

**Steps**
1. As T, list the grievance queue.
2. As T, request the case id directly.
3. As T, request that case's update timeline.
4. As T, read the category summary and compare the counts with those an unrelated
   front-office user sees.
5. As T, attempt to triage the case — clear `subject_employee_id` with `"none"`,
   or reassign it.
6. As the office, clear `subject_employee_id` to `"none"`; then repeat step 1 as T.

**Expected** Step 1: T sees the unrelated grievance and **not** the one naming
them (`comms.go:264-266`). Step 2 → **404, not 403** — "a refusal that
distinguishes 'not yours' from 'does not exist' tells them a complaint has been
filed, which is the fact being withheld" (`comms.go:302-306`). Step 3: the
timeline carries the case's exclusion, so the accused cannot read the complaint
through the update trail (`comms.go:396-400`). Step 4: **the counts differ** —
`getFeedbackSummary` applies the same predicate, so the total, open, breached,
median-days and satisfaction figures T sees all exclude their own case
(`comms.go:974-976`). This is the part that leaks most easily and must be checked
explicitly. Step 5 → the `SELECT … FOR UPDATE` returns no row and the triage fails,
so an accused member of staff cannot triage their own case out of the way
(`comms.go:496-505`). Step 6: once the subject is cleared, T sees the case
normally — confirming the exclusion is driven by `subject_employee_id` and
nothing else.

**Negative** As a parent (no `employees` row), `callerEmployeeID` returns nil and
the predicate excludes nothing (`comms.go:161-176`) — correct, because a parent
cannot be the subject of a staff grievance. Confirm a parent still cannot reach
`/comms/grievances` at all: the group requires `FrontDeskRead` (`comms.go:68-69`).

**Gap to record** The exclusion depends entirely on somebody setting
`subject_employee_id` at triage. A grievance whose body names a teacher in prose
but whose subject field is empty is visible to that teacher. There is no
detection of that case.

---

## Gate, visitors and events

### OP-33 — A visitor is signed in, given a pass number, and signed out; a blocked visitor is refused

**Roles** Institution Admin (receptionist)

**Features** `admissions.visitors.visitor_gate_pass_generation`, `.visitor_checkout_tracking`

**Endpoints**
- `GET /api/v1/office/visitors` — `listVisitors`, `internal/api/api.go:374` / `internal/api/front_office.go:45`
- `POST /api/v1/office/visitors` — `signVisitorIn`, `internal/api/api.go:375` / `internal/api/front_office.go:102`
- `POST /api/v1/office/visitors/{id}/out` — `signVisitorOut`, `internal/api/api.go:376` / `internal/api/front_office.go:159`
- `GET/POST /api/v1/office/blocklist` — `internal/api/api.go:377,378` / `internal/api/front_office.go:197,224`
- Screen: `web/src/features/admissions/FrontDesk.tsx:104,195,202,849,852`

**Setup** A `front_office` account (`rbac.go:352-354`). One name on the blocklist.

**Steps**
1. Receptionist signs in three visitors in succession and records their pass numbers.
2. Receptionist lists today's visitors with `?inside=true`.
3. Receptionist signs the second visitor out and re-reads.
4. Receptionist attempts to sign in the blocklisted person.

**Expected** Step 1: pass numbers are `001`, `002`, `003` — allocated as
`lpad(max(pass_no::int)+1, 3, '0')` **inside the transaction**
(`front_office.go:129-140`), so the front desk and the hostel (OP-12) cannot hand
out the same number at the same moment. Step 2 shows only those still on the
premises (`front_office.go:67`). Step 3 stamps `out_at`. Step 4 → refused against
`visitor_blocklist`.

**Negative** As `faculty` (no `FrontDeskRead`) → 403 on the whole `/office` group
(`api.go:373`). Confirm the hostel visitor register (OP-12) shares the same
`visitors` table and the same blocklist, so a person barred at the front gate is
also barred at the hostel — that cross-check is the one join between the two
registers that does exist.

---

### OP-34 — A family claims a seat at an event, and the pass is admitted exactly once

**Roles** Parent → Institution Admin (door)

**Features** `parent.school_life.live_event_seating_pass`

**Endpoints**
- `GET /api/v1/portal/school-life/event-passes` — `listEventPasses`, `internal/api/portal_school_life.go:77` / `:851`
- `POST /api/v1/portal/school-life/event-passes` — `claimEventPass`, `:78` / `:893`
- `GET /api/v1/portal/school-life/event-passes/verify?code=` — `verifyEventPass`, `:80-81` / `:1042` (`FrontDeskWrite`)
- `POST /api/v1/portal/school-life/event-passes/{id}/admit` — `admitEventPass`, `:82-83` / `:1104` (`FrontDeskWrite`)
- Screen: `web/src/features/portal/EventPasses.tsx:77,93`

**Setup** A published `school_events` row dated tomorrow, untargeted; a second
targeted at section B; a third dated yesterday. Demo-seeded guardian G with child
S in section A.

**Steps**
1. G claims a pass for the untargeted event with no `seats`.
2. G claims again for the same event.
3. G claims for the section-B event.
4. G claims for the past event.
5. G claims 25 seats.
6. Door verifies the pass code, then admits it, then admits it again.
7. Door verifies the code on a day that is not the event date.

**Expected** Step 1 → `201` with `seats: 2` (the default — two parents,
`portal_school_life.go:911-913`), a row label and a seat range allocated under
`FOR UPDATE` on the event so two families cannot take the same chairs
(`:936-968`). Step 2 → the `ON CONFLICT (event_id, student_id) WHERE revoked_at IS NULL
DO NOTHING` path returns "already", not a 500 at commit (`:980-991`). Step 3 →
refused: the section test requires an enrollment (`:949-958`). Step 4 → refused as
past (`:943-946`). Step 5 → `400 "at most 20 seats"`. Step 6: verify returns
`{"valid": true}`; the first admit returns `{"status":"admitted"}`; the second
returns "that pass has already been used or withdrawn", because the single-use
guarantee is the `WHERE admitted_at IS NULL AND revoked_at IS NULL` predicate plus
`RowsAffected()==1` and not a check-then-update (`:1113-1127`). Step 7 → `valid:false`,
"pass is for {date}" (`:1094-1096`).

**Negative (wrong role)** G calls the verify or admit endpoint directly → 403;
both re-gate on `FrontDeskWrite` inside the `/portal` group, "a parent must never
be able to record their own arrival" (`portal_school_life.go:63-68`).

**Gap to record** There is no React screen for `verifyEventPass` or
`admitEventPass` — `grep` over `web/src/` finds no caller. The door's half of this
chain is API-only today. The same is true of `verifyCampusPass`
(`portal_school_life.go:1628`) and `checkInEventTicket` (`student_learning.go:1752`).

---

### OP-35 — A student books a club-event ticket and is checked in at the door

**Roles** Student → Institution Admin (door)

**Features** `student.campus_life.student_club_event_ticketing_qr_check_in`

**Endpoints**
- `GET /api/v1/portal/campus/events` — `listClubEvents`, `internal/api/student_learning.go:84` / `:1556`
- `POST /api/v1/portal/campus/events/{id}/ticket` — `bookEventTicket`, `:85` / `:1633`
- `POST /api/v1/portal/campus/tickets/{id}/cancel` — `cancelEventTicket`, `:86` / `:1701`
- `POST /api/v1/portal/campus/events/check-in` — `checkInEventTicket`, `:88-89` / `:1752` (`FrontDeskWrite`)
- `POST /api/v1/portal/campus/events` — `createClubEvent`, `:90-91` / `:1822` (`AnnouncementsWrite`)

**Setup** A club event: `status='open'`, `starts_at` tomorrow, capacity 2, a
`booking_closes_at` in the future, `min_class_level`/`max_class_level` covering
class 9. Students S1 (class 9), S2 (class 9), S3 (class 9), S4 (class 6).

**Steps**
1. S1 and S2 book. S3 books.
2. S4 books.
3. S1 cancels; S3 books again.
4. Door checks in S1's code, then the same code again.
5. Door checks in a code from a different campus's event.

**Expected** Step 1: S3 is refused on capacity. Every rule — campus match,
`status='open'`, `starts_at > now()`, `booking_closes_at`, class-level band and
capacity — is enforced in a single `INSERT … SELECT`
(`student_learning.go:1661-1678`), so there is no check-then-insert race. Step 2 →
refused on class level. Step 3: the freed seat is available. Step 4: the second
check-in → `409`, idempotency via `status <> 'booked'` (`:1770-1790`).

**Negative** S1 calls `POST /portal/campus/events/check-in` directly → 403
(`FrontDeskWrite`). S1 calls `POST /portal/campus/events` to create an event →
403 (`AnnouncementsWrite`).

**Defect to record** Step 5 **succeeds**. `checkInEventTicket` looks the ticket up
by `code` with no campus or event scoping beyond the tenant, so any front-desk
user in a multi-campus institution can check in any code.

---

## Chains that could not be tested, because the endpoint does not exist

1. **The whole parent bus-tracking feature and the office live map — not mounted
   on the router.** `mountBusTracking` (`internal/api/bus_tracking_views.go:476`),
   `mountBusTrackerManage` (`internal/api/bus_tracker_admin.go:528`) and
   `mountTransportLiveMap` (`internal/api/transport_live_map.go:58`) are never
   called from `internal/api/api.go`, which invokes only `mountBusTrackerDevice`
   (`api.go:43`) and `mountBusTrackerAdmin` (`api.go:117`). Eleven endpoints —
   `/me/child-bus`, `/me/child-bus/prefs`, `/transport/live`,
   `/transport/safety-events`, `/transport/safety-events/{id}/review`,
   `/transport/trackers`, `/transport/trackers/{id}`,
   `/transport/trackers/{id}/revoke`, `/transport/tracking-policy`,
   `/transport/stop-events`, `/transport/map-stops` — return 404, and eight React
   screens hit them. The handlers are written, permission-gated and correctly
   narrowed; they are simply not wired. See OP-06. This is the single cheapest
   fix in this document.
2. **Defining a route, a stop, a fare slab or a vehicle.** Only
   `cmd/migrate/demo_ops.go:302-321` inserts into `routes`, `route_stops` or
   `vehicles`. Five catalogue keys are marked *built* and resolve to a read-only
   screen (`web/src/features/operations/Transport.tsx:78,82,86`). OP-01 records
   what is observable; the write half is absent.
3. **Assigning a driver or attendant to a vehicle.** A driver can be recorded
   (`POST /api/v1/ops/transport/staff`, `internal/api/transport_office.go:103`),
   but `vehicles.driver_employee_id` and `.attendant_employee_id` are read-only
   in every handler. Which person is on which bus cannot be set. See OP-01.
4. **Vehicle insurance, fitness, permit and PUC renewal.** The four columns exist
   (`migrations/00001_baseline.sql:1587-1590`) and are read only as a collapsed
   "soonest expiry" (`internal/api/role_backoffice.go:415-419,485-489`). No
   endpoint writes them, none names which document lapsed, and there is no alert.
   See OP-07.
5. **Billing a transport fare, or any other per-student charge.** No mechanism
   attaches an individual charge to an invoice; `raiseInvoices`
   (`internal/api/fees.go:600`) copies only `fee_structure_items`. See OP-03.
6. **Collecting a library fine.** `library_loans.fine_paise` reaches no invoice,
   fee head, payment or ledger row. See OP-16.
7. **Renewing a library loan.** No endpoint; a reader must return and re-issue.
8. **Telling a family that their child was seen in the infirmary.**
   `internal/api/infirmary.go` emits no message or notification of any kind.
   `parent_informed_at` records a telephone call somebody made. See OP-23.
9. **Telling a family that their child's bus broke down.**
   `transport_incidents.parents_informed` is a manual boolean
   (`internal/api/transport_office.go:738`), there is no message event, and
   `getChildBus` projects no incident field.
10. **A pupil or parent reaching the digital library.** The `student` and `parent`
   roles hold no `operations.library.read` (`internal/rbac/rbac.go:375-378`) and
   the whole subtree is mounted under `/ops`. There is no student- or
   parent-facing catalogue key. See OP-18.
11. **Joining the gate to the hostel outpass.** No gate scanner queries
   `hostel_outpasses`. A boarder can be released to a visitor with no pass
   (OP-12), and a boarder with an approved pass gets no gate record (OP-10).
12. **A gate entry/exit log for cardholders.** `verifyCampusPass`
    (`internal/api/portal_school_life.go:1628`) returns a verdict and writes no
    row. The only in/out timestamps in the system are `visitors.in_at/out_at`.
13. **A boarder reading the mess menu.** `listMessMenu` sits under `/ops`
    (`internal/api/api.go:566`) and there is no student-facing key.
14. **A hostel roll call as a distinct register.** The two keys
    `institution_admin.hostel.roll_call` and `.hostel_roll_call_attendance` both
    resolve to the occupancy screen (`web/src/features/registry.ts:281-282`); the
    nearest real register is night study (OP-13).
15. **Scheduling or expiring a circular.** `publishCircular` hard-codes
    `publish_at = now()` and never writes `expires_at`
    (`internal/api/mod_ops.go:92-98`), although the read side filters on both. See OP-29.
16. **A cash denomination breakdown at cash-up.** `grep -rn denomination` over the
    repository returns nothing; reconciliation is one counted total. See OP-26.
17. **A campus wallet or a card payment at the till.** Deliberately blocked for
    want of a payment gateway (`internal/api/collections.go:52`,
    refusal at `:1650`); the catalogue key
    `finance.collections.cashless_campus_wallet` is not in
    `internal/api/implemented_gen.go`.
18. **Every parent-facing step in this document, in a real tenant.**
    `guardians.user_id` is written only by `cmd/migrate/demo.go:257-261`. OP-06,
    OP-09, OP-10, OP-25 (step 8), OP-30, OP-31 and OP-34 are executable against a
    demo-seeded tenant and unreachable in a production one
    (`docs/gap_analysis/00_TIMELINE.md:73-81`).
