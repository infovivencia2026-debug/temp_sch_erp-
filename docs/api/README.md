# The API, for somebody outside this codebase

This is the JSON API at `/api/v1`. The React SPA is its first client, the
Android apps are its second, and everything below is what a third one needs to
know before it writes any code.

Three files:

- `openapi.yaml` - an OpenAPI 3.1 description of the endpoints an integration
  actually plugs into. Partial, and it says so at the top.
- `getting-started.md` - one real task end to end, with real curl and real
  response bodies.
- `routes.md` - a machine-generated inventory of all 1,228 routes and the
  permission each one requires. An inventory, not a contract.

Read this file first. It explains the parts that are the same everywhere and
that the spec would otherwise repeat three hundred times.

## Authenticating

There are two ways in for a general integration and two more for devices.

### `Authorization: Bearer erpk.<key-id>.<secret>` - what you should use

An API key is a credential minted for a system rather than for a person. It
does not expire when somebody goes on leave, it is not tied to a browser, and
it can be revoked without locking a human out of their own account.

Issue one from `POST /api-keys`, naming the permissions it needs. **The token
is shown once**; only the SHA-256 of its secret half is stored, so a lost key
is revoked and replaced, never recovered. The `erpk.` prefix is there so a
leaked-credential scanner can recognise one of ours in a git repository.

```
Authorization: Bearer erpk.7f1c8a02-....-9b31.Zm9vYmFyYmF6...
```

The design decision worth knowing: a key resolves into *exactly* the same
identity a session cookie produces - same institution, same permission map,
same context key. Nothing downstream knows a key exists. Every permission
gate, every tenant scope and every row-level security policy therefore applies
to a key with no change and, more to the point, with no opportunity for
somebody to forget to apply it to one. A parallel machine path with its own
authorisation checks is right for the bus tracker, which is not a member of
staff and reaches four endpoints. It would be badly wrong here, where a key
reaches the whole API.

What a key cannot be:

- **Never platform staff.** `platform_admin` is false unconditionally, so the
  "belongs to no institution, therefore reaches every tenant" branch cannot be
  entered by a key. No header, body field or column turns it on.
- **Never `platform.*`.** Those permissions are refused at issue time, even to
  somebody who holds them.
- **Never more than its school grants.** A key holds a frozen subset of its
  school's grants, intersected again on every request with what that school's
  roles grant today. Withdraw a permission from the school and its keys lose
  it in the same instant, without anybody having to remember the keys exist.

Asking for a permission the school grants to no role is refused at issue time
rather than silently trimmed, because a key that quietly did not get
`finance.invoices.read` fails later, in production, with a `403` nobody can
explain.

**A key may not manage keys.** `GET /api-keys`, `POST /api-keys` and the
revoke call all refuse a key-authenticated caller with `403`. A key holding
`access.users.write` could otherwise mint further keys and revoke the
administrator's own. That is not a widening of privilege - the child would be
bounded by the same school and the same subset - but it takes the human out of
the loop of who holds a credential, and it lets a leaked key entrench itself.
Sign in to manage keys.

An unusable key - unknown, wrong secret, revoked, expired, owner gone - gets
one `401` with code `unauthorized` and one message for all five reasons.
Distinguishing them would tell somebody holding a guessed id which half they
got right. Revocation takes effect on the next request: the resolver reads
`revoked_at` every time and holds no cache.

Keys work only under `/api/v1`. They are refused on the server-rendered pages,
which carry CSRF assumptions that belong to a cookie.

### `erp_session` cookie - what a browser uses

The session the SPA carries. `POST /login` (a form post, outside `/api/v1`)
sets it. An integration *can* use it, and before the key existed that was the
only option, but understand what you are taking on: it belongs to a named
human being, it expires on the server's schedule, and there is no supported
way to mint one without driving the login form. When that member of staff
leaves and their account is disabled, your integration stops.

A request carrying both a cookie and a key is answered as the key. The
explicit credential wins over the ambient one, which is the only reading that
does not let a stray browser cookie silently upgrade a machine call.

### `Authorization: Bearer <tracker-id>.<secret>` - a bus tracker handset

Issued once, by `POST /public/bus-tracker/enrol` or
`POST /public/bus-tracker/claim`, and never shown again; the server keeps only
a sealed copy. It authenticates a *phone*, not a person, and it is confined to
`/bus-tracker/*`. A revoked tracker, or one nobody has approved yet, is
refused there no matter what else it holds.

### `X-Staff-Session: <token>` - the driver behind the handset

Issued by `POST /bus-tracker/session`. It sits *alongside* the device token,
not instead of it, and it is required only on the calls that record who did
something: opening a run, closing one, marking a child on or off. Positions
and heartbeats deliberately need only the device, because a session that
lapses mid-route must never drop a moving bus off the parents' map.

The token is bound to the handset that was issued it. Lifting it onto another
phone does not work, which is most of the point of tying a session to a device.

## Permissions

Every gated route names a permission key in its own declaration -
`students.read`, `finance.payments.write`, `operations.transport.read` - and
`routes.md` lists all of them. `GET /session` returns the full set the caller
holds, so a client can decide what to show without guessing.

Missing one is a `403` with code `forbidden` and a message naming the key.
That is deliberate: an integration that gets `missing permission:
finance.invoices.read` can be fixed by an administrator in thirty seconds,
where a bare "forbidden" turns into a support ticket.

Two things about permissions that surprise people:

**A permission is not a scope.** Holding `academics.attendance.read` does not
mean you may read every register in the school. Row-level security bounds you
to one school; a second resolver bounds you again to the sections you teach or
are class teacher of. Most list endpoints are narrowed this way, and the
narrowing is invisible - you get a shorter list, not an error. If you are
integrating on behalf of the office, use an account that holds the `.all`
variants (`students.read.all`, `academics.attendance.read.all`).

**Some routes carry no permission at all and are still not open.** The fee
ledger is the clearest case: `GET /fees/students/{id}/ledger` is deliberately
outside the finance permissions, because a parent reads their own child's
account through exactly that endpoint. The handler narrows by who is asking
instead of by a second read-only copy of the query. Blank in `routes.md` means
"gated somewhere other than the router", not "ungated".

## Tenancy

**A credential belongs to one school, and there is no cross-school access.**

This is enforced in Postgres, not in Go. Every tenant table carries an
`institution_id` and a row-level security policy that compares it against a
session variable the connection sets before the handler runs. A query that
forgot its `WHERE institution_id = ...` returns nothing rather than returning
another school's children. There is no request parameter, header or body field
that widens it, and a handler cannot accidentally leak across tenants by
writing careless SQL, which is the reason it was built in the database rather
than in a helper somebody could forget to call.

The one exception is platform staff - the vendor's own operators, who belong
to no institution. They may name a school for a single request with
`X-Acting-Institution: <uuid>` (or `?institution_id=`). The header is *ignored
entirely* for everybody else: an ordinary user's institution comes from their
session and nothing in a request may widen it. That check is the first thing
the middleware does.

If you are integrating for a group of schools, you need one credential per
school. That is not a limitation to work around; it is the guarantee.

## The error envelope

Every JSON error has one shape:

```json
{
  "error": {
    "code": "forbidden",
    "message": "missing permission: students.read",
    "request_id": "5f2f1d02-0f0c-4f0f-9a6a-2b0f6f4f6a11"
  }
}
```

One envelope means a client never has to guess whether it got `{error}`,
`{message}`, or a bare string.

**Branch on `code`. Never on `message`.** The codes are stable; the messages
are written for the person reading the screen and get rewritten whenever
somebody finds a clearer sentence.

The generic codes:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Malformed body or parameter. Also what a body with an unknown field gets. |
| 401 | `unauthenticated` | No usable credential. |
| 403 | `forbidden` | Authenticated, but missing a permission or refused by a rule. |
| 404 | `not_found` | No such resource, or none you may see. |
| 500 | `internal` | Logged with the cause; you get the request id, not the cause. |

And the specific ones worth handling. This is not the full list - handlers add
their own, and `grep -r 'httpx.Error' internal/` is the honest source - but
these are the ones an integration will meet:

| Status | Code | Meaning |
| --- | --- | --- |
| 402 | `subscription_*` | The school has not paid. Everything but `/session`, `/catalog`, `/me`, `/profile` and `/ref-data` is refused. |
| 403 | `password_change_required` | The account still holds the password the office issued in bulk. Nothing works until a human sets a real one. |
| 403 | `awaiting_approval` | A bus tracker handset that is enrolled but not yet let in. |
| 409 | `provider_not_configured` | Nothing is broken; the school has not finished setting up a messaging provider. |
| 409 | `duplicate`, `roll_no_taken`, `apaar_already_used` | A school's own uniqueness rule, said in words the clerk can act on rather than as a constraint name in a 500. |
| 422 | `skewed_clock` | A tracker's clock is more than a day out. Carries an extra `server_time`. |
| 429 | `rate_limited`, `pin_locked` | See below. |

`request_id` is echoed from an `X-Request-Id` you send, or generated when you
do not. It appears on the response, in every log line for that request, and in
any background job the request enqueues. Send your own and you can trace a
failure end to end without asking anybody to grep by timestamp. It is the
single most useful thing to put in your own error logs.

## Pagination and filtering

There is no single convention, and pretending otherwise would send you looking
for a `next` link that does not exist. There are three patterns:

**Offset pages with a total.** `GET /students` is the only one in this
document. It returns `{items, total, limit, offset, has_more}`; `limit` is
clamped to 1..200 and defaults to 50. It is offset rather than keyset on
purpose - the grid that drives it needs a total for its pager, and at a few
thousand rows per school the count is cheap. If a school ever outgrows that,
the fix is a cursor, not a bigger cap.

**A bare list with a server-side cap.** Most list endpoints: `{items: [...]}`
and nothing else. The cap is usually 300 (invoices, employees, the fleet) or
200 (the tracker roll, the message log). **There is no way to page past it.**
If you need the four-hundredth invoice, filter it down. This is worth knowing
before you build a sync job on top of one of these.

**A limit you may raise.** `GET /messaging/log` takes `limit` up to 500.

Filtering is per endpoint and always query parameters, never a body: `status`,
`section_id`, `on_date`, `q` for a substring search on the roll. There is no
generic filter language and no sort parameter. Ordering is fixed by the
handler and chosen for the screen - the roll by admission number, the tracker
roll by stop sequence rather than by name, because the driver is at a stop and
wants the two or three names that belong to it.

Dates in query parameters and bodies are `YYYY-MM-DD`. Timestamps in and out
of the bus tracker are RFC 3339 with an offset. Elsewhere timestamps are
rendered in the school's timezone by the SQL that produced them, which is not
a promise this document is prepared to make uniform - read the field
descriptions in the spec.

## Money

Every amount is an integer number of **paise** - one hundredth of a rupee -
and every field carrying one is named `*_paise`. There are no floats anywhere
in the money model, and there is nothing to round. `balance_paise: 4550000` is
forty-five thousand five hundred rupees.

## Rate limits

**An API key is limited to its own `rate_per_minute`**, chosen when the key is
issued: 120 by default, and settable between 1 and 6000. Exceed it and you get
`429` with code `rate_limited` and a `Retry-After` header in seconds. Honour
it.

The limiter is an in-process fixed-window counter, and the code says so
plainly: two app processes behind a load balancer means a key gets up to twice
its limit, and a restart forgets every window. It is there for the accident,
not the attacker - an integration stuck in a retry loop, a nightly job that
forgot its pagination, a script hammering the roll every 50ms. Those are what
actually take a school's server down, and a counter in a map stops all of
them. A determined attacker holding a valid key is not what this addresses;
revoking the key is.

A **cookie** session is not rate limited at all today. Do not read that as
permission to hammer the API.

A few public endpoints limit per source address, also in process:

- Public admission form submissions: 12 in 10 minutes.
- Bus tracker enrolment and SMS gateway claims: 6 in 10 minutes.
- PIN attempts are counted per account and lock out with `pin_locked`,
  independently of the address limits.

Practical guidance: keep concurrency low, back off on `429` and on `5xx`, and
if you are importing a roll use the bulk import endpoint rather than a
thousand `POST /students`.

## Versioning

The path says `v1` and it has always said `v1`. **There is not yet a policy
behind that number**, and it would be dishonest to describe one.

What is actually true:

- The API and its only clients ship together, from this repository, to a
  server the vendor operates. A breaking change has so far meant changing both
  halves in the same commit.
- Nothing is deprecated on a schedule, because nothing external has depended
  on it yet.
- `/api/v1` has never been renumbered and there is no `v2`.

So: if you are the first outside integration, say so, and get the endpoints
you depend on written into `openapi.yaml`. That document is the list of things
somebody will think twice before changing. Anything outside it - which is most
of `routes.md` - exists to drive a screen and moves when the screen moves.

The one exception is the bus tracker. `docs/BUS_TRACKER_CONTRACT.md` is a
genuine wire contract with two implementations built against it, written after
the SMS gateway taught the lesson the hard way: the contract failed to name a
field, two people building from it independently chose different names, and
neither side failed, logged, or noticed. Treat that protocol as stable and
that file as authoritative.

## What is not ready, plainly

- **Webhooks.** There are none. Nothing calls out to you when a fee is paid or
  a child is marked absent. Poll, or ask for one to be built.
- **Bulk read.** Most lists cap at 300 rows with no cursor. A full export of a
  large school is not something this API does well today.
- **A stable contract outside `openapi.yaml`.** The other roughly 1,180 routes
  are internal in everything but network reachability.
- **Consistent timestamp formats** across the whole surface. The bus tracker is
  RFC 3339 throughout; elsewhere it varies by handler.
