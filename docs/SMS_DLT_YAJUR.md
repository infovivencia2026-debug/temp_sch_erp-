# SMS on WISEN: the DLT identity and the MSG91 account

The DLT registration and the MSG91 account belong to WISEN and send for
every school on the platform (the `edu_cloud` route, paid in credits).
The identity was read from Yajur Public School's MyClassBoard instance on
26 Sep 2026. Seeded by `migrations/00344_yajur_dlt_sms.sql` (templates) and
`00345_dlt_sms_is_the_platforms.sql` (the platform channel).

## DLT identity

| Field | Value |
|---|---|
| Principal Entity (PE) | MEGHAA EDUCATIONAL SOCIETY |
| PE ID | 1701172544496584296 |
| Header (sender id) | YAJURS (transactional / service) |
| Aggregator (telemarketer) chosen | MSG91 |
| DLT operator portal | not recorded in MCB; find it (Jio / Airtel / Vi / BSNL / Tata) |

These are public identifiers. They live on the platform's SMS channel
(`integrations` row with no institution: `config.dlt_entity_id`,
`.dlt_entity_name`, `.sender_id`) and are shown on the seller console under
Edu Cloud channels → SMS. The MSG91 authkey is the only secret, typed on
that screen, never seeded. The channel stays disabled until it is.

## Where things are in the product

- Platform SMS channel: MSG91 preset, sender YAJURS, PE id, no key, disabled.
- Every school sends through it by default (route `edu_cloud`), metered by
  message credits. A school on the top pack may still link its own vendor.
- Yajur's templates: 14 of the 22 approved templates are stored as the
  school's own SMS wording with their DLT template ids. Triggers that
  already run (absence alert, fee overdue chase, admissions enquiry /
  received / accepted) use them automatically. The rest (holidays,
  closures, buses off, PTM notice, birthday, receipt, payment confirmation)
  are ready for the day a trigger or a compose screen picks them.
- Not seeded: templates 16, 18, 19 and 20 (MCB shows them truncated, and an
  approximate template is a rejected message), 10 (password over SMS), 21
  and 22 (one-off static notices).

## One entity, many schools: what a second school needs

A header is bound to the entity, and the approved text names the school.
So each school that sends on WISEN's account needs, under the same PE:

1. its own six-character header registered on the DLT portal and shared
   with MSG91;
2. its own templates approved with that header and its own name at the end;
3. those templates entered under Communication → Wording with their ids.

Today the platform channel carries one header (YAJURS). A per-school header
on the shared account is the next piece of work when the second school
comes on; until then the platform header is Yajur's.

## What the owner still has to do

1. Create the MSG91 account in WISEN's name (see the prompt below) and get
   the authkey.
2. Find the DLT portal login for Meghaa Educational Society. On it, add
   MSG91 as a telemarketer (chain / consent), and confirm header YAJURS and
   every template id are shared with MSG91.
3. Paste the authkey on Edu Cloud channels → SMS, save, send a test to a
   staff number.
4. Verify template 18's id on the portal: it starts 1777… while every other
   one starts 1707….
5. Re-copy the full text of templates 16, 18, 19, 20 from MCB or the portal
   and add them under Yajur's Wording.
6. Grant Yajur SMS credits on the seller console.
7. Stop MCB's SMS once WISEN is confirmed sending, so parents are not texted
   twice.

## Prompt for Claude (web) to set up the MSG91 account

Copy everything below the line into a new Claude chat.

---

I run WISEN, a school ERP platform in India. WISEN sends transactional SMS
to parents on behalf of the schools that use it, from one MSG91 account
that WISEN owns. The first school is Yajur Public School (Hyderabad,
Telangana), whose society already holds a DLT registration that WISEN will
send under. I need you to walk me through setting up the MSG91 account and
the DLT binding, one step at a time. Wait for me to confirm each step
before the next, and ask for anything you need that I have not given you.

Facts you have:

- Principal Entity registered on DLT: MEGHAA EDUCATIONAL SOCIETY
- Principal Entity ID: 1701172544496584296
- Approved sender header: YAJURS (6 characters, transactional / service)
- Brand that appears in the approved messages: YAJUR PUBLIC SCHOOL
- I do not yet know which operator's DLT portal the entity is registered on
  (Jio TrueConnect, Airtel, Vi, BSNL or Tata). Help me find out first.
- The MSG91 account will be in WISEN's name, not the school's. Tell me
  whether MSG91's KYC allows a platform (telemarketer-style) account that
  sends under a customer's entity, what documents WISEN needs, and whether
  WISEN itself must register on DLT as a telemarketer or can rely on MSG91's
  telemarketer id.
- The platform calls MSG91's legacy HTTP API (`api.msg91.com/api/sendhttp.php`,
  GET, with authkey, mobiles, message, sender, route=4, country=91 and
  DLT_TE_ID per message). Template ids are already stored in the platform.
  Tell me if MSG91 now requires the v5 Flow API and what changes if so.
- More schools will join later, each with its own header and templates
  under their own or this entity. Explain how one MSG91 account carries
  many headers and entities, and what to do per new school.
- Expected volume now: 300 to 400 parents, a few hundred messages on a
  normal day, a few thousand on a fee-reminder or holiday day.
- The 22 approved template ids all start with 1707 except one that starts
  with 1777 (1777178532445716719); I want to verify that on the portal.

What I need from you, in order:

1. Sign up for MSG91 in WISEN's name and complete KYC: which documents,
   where to upload them, and how long approval takes.
2. Find the DLT operator portal for the entity and log in, or recover the
   login. Explain the PE–TM (telemarketer) binding: how to add MSG91's
   telemarketer id under the entity, and how to share the header YAJURS
   and the approved templates with MSG91. Give me MSG91's TM id if you know
   it, or say exactly where in MSG91 to read it.
3. In MSG91: add the sender id YAJURS, add the DLT entity id, and import or
   map the approved templates so that DLT_TE_ID scrubbing passes. Say
   whether I paste each template text and id by hand or can sync from the
   portal.
4. Get the authkey and tell me which MSG91 permissions or IP allow-listing
   to set for a server that calls the API from Google Cloud Run (no fixed IP).
5. Buy credits: recommend a starting pack for the volume above and the
   current per-SMS price on transactional route 4.
6. Send one test message to a staff number using the sendhttp.php URL with
   my real values, and tell me how to read delivery reports and the error
   codes on the MSG91 dashboard when a message is rejected by DLT scrubbing.
7. List the templates to register next for every school (OTP login, fee
   payment link, results published, transport delay, generic "you have a
   message in the app"), with draft wording that follows DLT rules:
   variables as {#var#}, at most 30 characters each, static text fixed,
   school name at the end.

Keep every answer short and practical. When something differs by operator
portal, say so for each. Do not invent MSG91 menu names; if unsure, tell me
what to look for.
