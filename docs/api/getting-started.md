# Getting started: take a register

One task, end to end: find a section, list the children in it, mark the
register, and read back what the server did with it. Every request below is a
real endpoint with its real parameters, and every response body is the shape
the handler actually emits, field for field. The identifiers and names are
invented - yours will differ - but nothing else is.

Set two variables. `HOST` is the school's deployment.

```bash
HOST=https://erp.example.com
```

## 0. Get a credential

Ask an administrator at the school for an API key. They issue it from
`POST /api-keys` (or the screen over it), naming the permissions your
integration needs - for this walkthrough, `academics.read`, `students.read`
and `academics.attendance.write.any`.

They will see the token exactly once:

```json
{
  "id": "b21f7d40-9a3e-4c62-8f15-0d7ea6c4b338",
  "name": "attendance sync",
  "token": "erpk.b21f7d40-9a3e-4c62-8f15-0d7ea6c4b338.k3Jq9xR7t2mVb8Ln4pZs6WgH1cDyF0aE",
  "permissions": ["academics.attendance.write.any", "academics.read", "students.read"],
  "rate_per_minute": 120,
  "note": "This is the only time this key is shown. Store it now; if it is lost, revoke it and issue another."
}
```

Put it somewhere your process can read it and nowhere a git repository can:

```bash
KEY=erpk.b21f7d40-9a3e-4c62-8f15-0d7ea6c4b338.k3Jq9xR7t2mVb8Ln4pZs6WgH1cDyF0aE
AUTH="Authorization: Bearer $KEY"
```

Every call below sends `-H "$AUTH"`. If you are stuck on the cookie path for
now, `POST /login` is a form post outside `/api/v1` taking `identifier` and
`password`, and you carry the `erp_session` cookie it sets instead. See
`README.md` for why the key is the better answer.

## 1. Check who you are

Always do this first. It is the cheapest way to find out that your credential
is not being sent, that the account still holds the password the office issued,
or that the school's subscription has lapsed - three failures that otherwise
show up as a confusing `403` on the third call.

```bash
curl -s -H "$AUTH" "$HOST/api/v1/session"
```

```json
{
  "authenticated": true,
  "user": {
    "id": "9c1f6b2e-58a4-4a71-9b0c-2f7d31a4e610",
    "full_name": "Priya Menon",
    "roles": ["class_teacher", "faculty"],
    "platform_admin": false
  },
  "institution": {
    "id": "a64a713c-83d7-4d7f-b956-2e0dc6270faa",
    "name": "Yajur Public School",
    "short_name": "YPS",
    "slug": "yajur",
    "primary_color": "#1f4e79",
    "timezone": "Asia/Kolkata",
    "locale": "en-IN"
  },
  "permissions": [
    "academics.attendance.write.any",
    "academics.read",
    "students.read"
  ],
  "subscription": {
    "active": true,
    "plan_code": "standard",
    "plan_name": "Standard",
    "status": "active",
    "modules": ["academics", "finance", "operations"]
  }
}
```

`user` here is the account the key was issued under: a key borrows its owner's
identity so that a write can be attributed to somebody. `roles` is therefore
that person's roles, and it is **not** what your key can do - a key holds a
named subset of permissions directly, not whatever its owner's roles grant.
Ignore `roles` and read `permissions`.

`permissions` is the set your key was issued with, intersected with what the
school still grants today - not what you asked for at issue time, and never a
superset. If the attendance write is missing here, step 5 will fail with a
`403` and no amount of retrying will change that.

Note what `platform_admin: false` means for a key: it is always false. A key
never reaches beyond its own school. If you are integrating for a group of
schools you need one key per school, which is the guarantee, not the
limitation.

If `authenticated` is `false`, stop here. Nothing else will work and every
error you get will be about the wrong thing.

## 2. Find the section

Leave `mine` off. It narrows the list to the sections the caller personally
teaches, which is right for a teacher's own screen and wrong for an office
integration: a key holding `academics.attendance.write.any` may mark any
section, and `mine=true` would hand it an empty list, since the account behind
the key teaches nothing.

```bash
curl -s -H "$AUTH" "$HOST/api/v1/academics/sections"
```

```json
{
  "items": [
    {
      "id": "3b7c2a90-6d41-4f2e-8a55-1c9e40b7d233",
      "class_id": "f0a1c8d2-7e35-4b19-9c6a-88d0e2f14b77",
      "class_name": "Grade 8",
      "academic_year_id": "5e2d9a11-3c47-4f80-b2a6-0d5f7c31e908",
      "name": "B",
      "capacity": 40,
      "room": "204",
      "class_teacher": "Priya Menon",
      "enrolled": 37
    }
  ]
}
```

`enrolled` is a live count of active enrolments, which is why the section list
can answer "is 8-B full?" without a second call.

## 3. List the children in it

```bash
SECTION=3b7c2a90-6d41-4f2e-8a55-1c9e40b7d233
curl -s -H "$AUTH" \
  "$HOST/api/v1/students?section_id=$SECTION&status=active&limit=200"
```

```json
{
  "items": [
    {
      "id": "c41e7f08-2b93-4d5a-8e17-6a0f9c2d3b44",
      "person_code": "YPS-000412",
      "admission_no": "2019/0412",
      "full_name": "Aarav Kumar Singh",
      "first_name": "Aarav",
      "middle_name": "Kumar",
      "last_name": "Singh",
      "gender": "male",
      "date_of_birth": "2012-04-18",
      "status": "active",
      "admission_date": "2019-06-03",
      "class_name": "Grade 8",
      "section_name": "B",
      "roll_no": 4,
      "primary_phone": "+919845012345"
    },
    {
      "id": "7d2b91a6-4c08-4e33-b7f1-9e5a0d6c821f",
      "person_code": "YPS-000487",
      "admission_no": "2020/0487",
      "full_name": "Meera Raghavan",
      "first_name": "Meera",
      "last_name": "Raghavan",
      "gender": "female",
      "date_of_birth": "2012-11-02",
      "status": "active",
      "admission_date": "2020-06-01",
      "class_name": "Grade 8",
      "section_name": "B",
      "roll_no": 11,
      "primary_phone": "+919845098765"
    }
  ],
  "total": 37,
  "limit": 200,
  "offset": 0,
  "has_more": false
}
```

Key on `id` - the UUID - for everything downstream. `admission_no` is whatever
the school writes on paper: a different format at every school, sometimes text,
occasionally reissued when a child leaves. `person_code` is this product's own
permanent identifier and is what an import can be re-run against without
creating a second copy of a child. Neither is the primary key.

`total` is 37 and `has_more` is false, so this is the whole section. Had it
been true, you would raise `offset` by `limit` and go again.

## 4. Read the register as it stands

Worth doing before you write. Marking is an upsert, so you are not going to
create duplicates, but knowing what is already there tells you whether somebody
else has taken this register in the last ten minutes.

```bash
curl -s -H "$AUTH" \
  "$HOST/api/v1/attendance?on_date=2026-09-03&section_id=$SECTION"
```

```json
{
  "items": []
}
```

Empty: nobody has marked 8-B today.

## 5. Mark it

One request for the whole section, always. It is written in a single
transaction, because a half-marked register is worse than an unmarked one -
nothing on the screen says where it stopped.

```bash
curl -s -H "$AUTH" -X POST "$HOST/api/v1/attendance" \
  -H 'Content-Type: application/json' \
  -H 'X-Request-Id: import-2026-09-03-8B' \
  -d '{
    "section_id": "3b7c2a90-6d41-4f2e-8a55-1c9e40b7d233",
    "on_date": "2026-09-03",
    "notify_channels": ["sms"],
    "entries": [
      { "student_id": "c41e7f08-2b93-4d5a-8e17-6a0f9c2d3b44", "status": "present" },
      { "student_id": "7d2b91a6-4c08-4e33-b7f1-9e5a0d6c821f", "status": "absent",
        "remarks": "no call from home" }
    ]
  }'
```

```json
{
  "section_id": "3b7c2a90-6d41-4f2e-8a55-1c9e40b7d233",
  "on_date": "2026-09-03",
  "submitted": 2,
  "written": 2,
  "newly_absent": 1,
  "parents_told": 1,
  "messages_queued": 2,
  "channels": ["sms"]
}
```

Read all six numbers; they are there so a screen can say what happened rather
than "Saved".

- `submitted` is what you sent. `written` is what actually changed.
- `newly_absent` counts the children whose status *became* absent in this
  request, not the ones you sent as absent. That distinction is the whole
  point: the upsert skips a row whose status has not changed, so re-sending an
  identical register writes nothing and notifies nobody.
- `parents_told` is guardians reached; `messages_queued` is messages, which is
  larger when a child has two guardians on file or when more than one channel
  is in play. The in-app alert always goes and is not counted against your
  `notify_channels` choice - it costs nothing and it is the record the parent
  can go back to. SMS, WhatsApp and email cost money per message, which is why
  they are opt-in per save.

**Send the same request again and you get this:**

```json
{
  "section_id": "3b7c2a90-6d41-4f2e-8a55-1c9e40b7d233",
  "on_date": "2026-09-03",
  "submitted": 2,
  "written": 0,
  "newly_absent": 0,
  "parents_told": 0,
  "messages_queued": 0,
  "channels": ["sms"]
}
```

Nothing written, nobody texted twice. That property is what makes it safe to
retry a request whose response you never saw, which for anything crossing a
network you will eventually have to do.

If you are back-filling a register from a fortnight ago, add `"silent": true`
and no family is told anything. Texting every parent about an absence they
already know about is worse than useless.

## 6. Read it back

```bash
curl -s -H "$AUTH" \
  "$HOST/api/v1/attendance?on_date=2026-09-03&section_id=$SECTION"
```

```json
{
  "items": [
    {
      "id": "e8a4c1b7-3f26-4d90-a5c8-71b2e0f3d945",
      "student_id": "c41e7f08-2b93-4d5a-8e17-6a0f9c2d3b44",
      "student_name": "Aarav Kumar Singh",
      "admission_no": "2019/0412",
      "section_id": "3b7c2a90-6d41-4f2e-8a55-1c9e40b7d233",
      "on_date": "2026-09-03",
      "status": "present"
    },
    {
      "id": "1d6f0a52-9c37-4b81-8e40-3a7c5d92f6b1",
      "student_id": "7d2b91a6-4c08-4e33-b7f1-9e5a0d6c821f",
      "student_name": "Meera Raghavan",
      "admission_no": "2020/0487",
      "section_id": "3b7c2a90-6d41-4f2e-8a55-1c9e40b7d233",
      "on_date": "2026-09-03",
      "status": "absent",
      "remarks": "no call from home"
    }
  ]
}
```

## What goes wrong, and what it looks like

**Marking a section you do not teach**, with a key that holds only
`academics.attendance.write`. The permission check passes and the scope check
does not, so the message names the section rather than the permission:

```json
{
  "error": {
    "code": "forbidden",
    "message": "missing permission: academics.attendance.write for this section",
    "request_id": "import-2026-09-03-8B"
  }
}
```

`academics.attendance.write.any` lifts the section restriction, which is why
the key in step 0 was issued with it. Ask an administrator to reissue; do not
work around it by borrowing a teacher's login.

**A status the database will not accept.** Checked in the handler rather than
left to the constraint, so you get a `400` you can act on instead of a `500`
and a constraint name:

```json
{
  "error": {
    "code": "bad_request",
    "message": "invalid status: excused",
    "request_id": "import-2026-09-03-8B"
  }
}
```

The allowed set is `present`, `absent`, `late`, `half_day`, `leave`,
`holiday`.

**A field the endpoint does not know.** The JSON decoder rejects unknown
fields outright, so a typo in a key is caught rather than silently dropped:

```json
{
  "error": {
    "code": "bad_request",
    "message": "malformed JSON body",
    "request_id": "import-2026-09-03-8B"
  }
}
```

That message is the same for a genuinely malformed body and for `"remark"`
instead of `"remarks"`, which is not ideal. If a body you are sure about is
rejected, check your key spelling against the spec before anything else.

**An empty `entries` array** is a `400`, not a no-op. Do not send a register
with nothing in it.

Note that `request_id` on all three is the one sent in `X-Request-Id`. Send
your own on every request and a failure can be traced through the server logs
and any background job it queued without anybody having to grep by timestamp.

## The other worked example: a bus run

The transport flow is the other thing an integration commonly wants, and it
has its own written contract in `docs/BUS_TRACKER_CONTRACT.md` - the only part
of this API with a genuine two-sided wire contract. The short version:

1. `POST /public/bus-tracker/enrol` with the driver's phone, six-digit PIN and
   the registration painted on the bus. You get a `device_token`, shown once,
   and `approved: false`.
2. Somebody with `operations.transport.write` - in practice the principal -
   calls `POST /transport/trackers/{id}/approve`. Until then every
   device-authenticated call answers `403 awaiting_approval`. There is no
   self-approval on this path, because a tracker is a live map of where
   children are during the day.
3. `POST /bus-tracker/session` with the device token puts a named driver
   behind the handset and returns an `X-Staff-Session` token.
4. `POST /bus-tracker/trips` opens a run and returns the stop list, so the app
   can evaluate geofences offline - a bus in a dead zone still knows it has
   arrived somewhere.
5. `POST /bus-tracker/positions` pushes a batch of fixes. It returns the
   `recorded_at` values actually stored, not a count, so the phone knows
   exactly which fixes to stop retrying. Re-sending a batch is a no-op.
6. `POST /bus-tracker/trips/{id}/end` closes the run.

**Nothing reported outside an open trip is visible to a parent.** The phone
belongs to the driver and does not stop existing at 4pm.
