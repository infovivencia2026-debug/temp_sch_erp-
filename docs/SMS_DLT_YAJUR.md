# SMS on WISEN: DLT identity and MSG91 for Yajur Public School

Source: the school's MyClassBoard instance, read on 26 Sep 2026. Seeded into
the database by `migrations/00344_yajur_dlt_sms.sql`.

## DLT identity

| Field | Value |
|---|---|
| Principal Entity (PE) | MEGHAA EDUCATIONAL SOCIETY |
| PE ID | 1701172544496584296 |
| Header (sender id) | YAJURS (transactional / service) |
| Brand in messages | YAJUR PUBLIC SCHOOL |
| Aggregator (telemarketer) chosen | MSG91 |
| DLT operator portal | not recorded in MCB; find it (Jio / Airtel / Vi / BSNL / Tata) |

These are public identifiers. They live in the SMS channel's config
(`integrations.config.dlt_entity_id`, `.dlt_entity_name`, `.sender_id`) and
are shown on Communication → Message channels → SMS vendor. The MSG91
authkey is the only secret, and it is typed on that screen, never seeded.

## Where things are in the product

- The channel row for Yajur is pre-shaped as the MSG91 preset with sender
  YAJURS and the PE id, disabled until the authkey is saved.
- The route for SMS is `own`: the school sends on its own MSG91 account.
- Templates: 14 of the 22 approved templates are stored as the school's own
  SMS wording with their DLT template ids. Triggers that already run
  (absence alert, fee overdue chase, admissions enquiry / received / accepted)
  use them automatically. The rest (holidays, closures, buses off, PTM notice,
  birthday, receipt, payment confirmation) are ready for the day a trigger or
  a compose screen picks them.
- Not seeded: templates 16, 18, 19 and 20 (MCB shows them truncated, and an
  approximate template is a rejected message), 10 (password over SMS), 21 and
  22 (one-off static notices).

## What the owner still has to do

1. Create the MSG91 account (see the prompt below) and get the authkey.
2. Find the DLT portal login for Meghaa Educational Society. On it, add MSG91
   as a telemarketer (chain / consent), and confirm header YAJURS and every
   template id above are shared with MSG91.
3. Paste the authkey on SMS vendor, save, send a test to a staff number.
4. Verify template 18's id on the portal: it starts 1777… while every other
   one starts 1707….
5. Re-copy the full text of templates 16, 18, 19, 20 from MCB or the portal
   and add them under Wording.
6. Stop MCB's SMS once WISEN is confirmed sending, so parents are not texted
   twice.

## Prompt for Claude (web) to set up the MSG91 account

Copy everything below the line into a new Claude chat.

---

I run WISEN, a school ERP, and I need to set up an MSG91 account so that one
of my schools, Yajur Public School (Hyderabad, Telangana, India), can send
DLT-compliant transactional SMS to parents from the ERP. Walk me through it
step by step, one step at a time, and wait for me to confirm each step
before the next. Ask me for anything you need that I have not given you.

Facts you have:

- Principal Entity registered on DLT: MEGHAA EDUCATIONAL SOCIETY
- Principal Entity ID: 1701172544496584296
- Approved sender header: YAJURS (6 characters, transactional / service)
- Brand that appears in messages: YAJUR PUBLIC SCHOOL
- I do not yet know which operator's DLT portal the entity is registered on
  (Jio TrueConnect, Airtel, Vi, BSNL or Tata). Help me find out first.
- The ERP calls MSG91's legacy HTTP API (`api.msg91.com/api/sendhttp.php`,
  GET, with authkey, mobiles, message, sender, route=4, country=91 and
  DLT_TE_ID per message). Templates and their DLT template ids are already
  stored in the ERP. Tell me if MSG91 now requires the v5 Flow API instead
  and what changes for me if so.
- Expected volume: about 300 to 400 parents, a few hundred messages on a
  normal day, a few thousand on a fee-reminder or holiday day.
- The 22 approved template ids all start with 1707 except one that starts
  with 1777 (1777178532445716719); I want to verify that on the portal.

What I need from you, in order:

1. Sign up for MSG91 in the name of the school's society and complete KYC:
   which documents the society needs (registration certificate, PAN, GST if
   any, authorised signatory letter, address proof) and where to upload them.
2. Find the DLT operator portal and log in, or recover access if the login
   is lost. Explain the PE–TM (telemarketer) binding: how to add MSG91's
   telemarketer id to the entity, and how to share the header YAJURS and
   the approved templates with MSG91. Give me MSG91's TM id if you know it,
   or tell me exactly where in MSG91 to read it.
3. In MSG91: add the sender id YAJURS, add the DLT entity id, and import or
   map the approved templates so that DLT_TE_ID scrubbing passes. Tell me
   whether MSG91 needs me to paste each template text and id by hand or can
   sync from the portal.
4. Get the authkey and tell me which MSG91 permissions or IP allow-listing I
   should set for a server that calls the API from Google Cloud Run (no
   fixed IP).
5. Buy credits: recommend a starting pack for the volume above and the
   current per-SMS price for transactional route 4.
6. Send one test message to a staff number using the sendhttp.php URL with
   my real values, and tell me how to read the delivery report and the
   error codes on the MSG91 dashboard when a message is rejected by DLT
   scrubbing.
7. List the templates I should register next (OTP login, fee payment link,
   results published, transport delay, generic "you have a message in the
   app"), with draft wording that follows DLT rules: variables as {#var#},
   at most 30 characters each, static text fixed, brand at the end.

Keep every answer short and practical. When something differs by operator
portal, say so for each. Do not invent MSG91 menu names; if unsure, tell me
what to look for.
