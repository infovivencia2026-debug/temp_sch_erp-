# SMS on WISEN: the DLT identity and the Fast2SMS account

The DLT registration and the Fast2SMS account belong to WISEN and send for
every school on the platform (the `edu_cloud` route, paid in credits).
The identity was read from Yajur Public School's MyClassBoard instance on
26 Sep 2026. Seeded by `migrations/00344_yajur_dlt_sms.sql` (templates),
`00345_dlt_sms_is_the_platforms.sql` (the platform channel) and
`00346_platform_sms_is_fast2sms.sql` (the vendor).

## DLT identity

| Field | Value |
|---|---|
| Principal Entity (PE) | MEGHAA EDUCATIONAL SOCIETY |
| PE ID | 1701172544496584296 |
| Header (sender id) | YAJURS (transactional / service) |
| Aggregator (telemarketer) chosen | Fast2SMS (WISEN's account) |
| DLT operator portal | not recorded in MCB; find it (Jio / Airtel / Vi / BSNL / Tata) |

These are public identifiers. They live on the platform's SMS channel
(`integrations` row with no institution: `config.dlt_entity_id`,
`.dlt_entity_name`, `.sender_id`) and are shown on the seller console under
Edu Cloud channels → SMS. The Fast2SMS API key is the only secret, typed on
that screen, never seeded. The channel stays disabled until it is.

## How the send works

Fast2SMS's DLT manual route, `POST https://www.fast2sms.com/dev/bulkV2`, with
`authorization` (the key), `route=dlt_manual`, `sender_id`, `message` (the
rendered text), `template_id` (the DLT template id), `entity_id` (the PE id)
and `numbers`. Every one of those is substituted by the gateway from the
channel config and the template, so Fast2SMS needs nothing registered in
its panel beyond the header and the entity, and the operator scrubs the
text against the template exactly as it would for any vendor.

## Where things are in the product

- Platform SMS channel: Fast2SMS preset, sender YAJURS, PE id, no key,
  disabled.
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
So each school that sends on WISEN's account needs, under the same PE or
its own:

1. its own six-character header registered on the DLT portal and shared
   with Fast2SMS;
2. its own templates approved with that header and its own name at the end;
3. those templates entered under Communication → Wording with their ids.

Today the platform channel carries one header (YAJURS). A per-school header
on the shared account is the next piece of work when the second school
comes on.

## What the owner still has to do

1. On Fast2SMS (account: King), finish KYC and enable the DLT route; get the
   API key from Dev API (see the prompt below).
2. Find the DLT portal login for Meghaa Educational Society. On it, add
   Fast2SMS as a telemarketer (chain / consent), and confirm header YAJURS
   and every template id are shared with Fast2SMS.
3. Paste the API key on Edu Cloud channels → SMS, save, send a test to a
   staff number.
4. Verify template 18's id on the portal: it starts 1777… while every other
   one starts 1707….
5. Re-copy the full text of templates 16, 18, 19, 20 from MCB or the portal
   and add them under Yajur's Wording.
6. Grant Yajur SMS credits on the seller console.
7. Stop MCB's SMS once WISEN is confirmed sending, so parents are not texted
   twice.

## Prompt for Claude (web) to set up Fast2SMS

Copy everything below the line into a new Claude chat.

---

I run WISEN, a school ERP platform in India. WISEN sends transactional SMS
to parents on behalf of the schools that use it, from one Fast2SMS account
that WISEN owns. I am already logged in to Fast2SMS; the account's company
name is "King". The first school is Yajur Public School (Hyderabad,
Telangana), whose society already holds a DLT registration that WISEN will
send under. Walk me through the Fast2SMS side and the DLT binding, one step
at a time. Wait for me to confirm each step before the next, and ask for
anything you need that I have not given you.

Facts you have:

- Principal Entity registered on DLT: MEGHAA EDUCATIONAL SOCIETY
- Principal Entity ID: 1701172544496584296
- Approved sender header: YAJURS (6 characters, transactional / service)
- Brand that appears in the approved messages: YAJUR PUBLIC SCHOOL
- I do not yet know which operator's DLT portal the entity is registered on
  (Jio TrueConnect, Airtel, Vi, BSNL or Tata). Help me find out first.
- The Fast2SMS account is in WISEN's name (company "King"), not the
  school's. Tell me whether Fast2SMS lets a platform account send under a
  customer's entity id, what KYC it needs, and whether WISEN itself must
  register on DLT as a telemarketer or can rely on Fast2SMS's TM id.
- The platform calls Fast2SMS's Dev API: POST https://www.fast2sms.com/dev/bulkV2
  with authorization, route=dlt_manual, sender_id, message (full text),
  template_id (DLT template id), entity_id and numbers. Confirm that
  dlt_manual is still offered and what it needs enabled on the account; if
  it is not, tell me exactly how the "dlt" route with a Fast2SMS message id
  and variables_values works instead.
- More schools will join later, each with its own header and templates.
  Explain how one Fast2SMS account carries many headers and entities, and
  what to do per new school.
- Volume now: 300 to 400 parents, a few hundred messages on a normal day, a
  few thousand on a fee-reminder or holiday day.
- The 22 approved template ids all start with 1707 except one that starts
  with 1777 (1777178532445716719); I want to verify that on the portal.

What I need from you, in order:

1. In the Fast2SMS panel: finish KYC for company "King" (which documents,
   where), and enable the DLT / DLT manual route. Tell me what "wallet"
   balance is needed before the route works.
2. Find the DLT operator portal for the entity and log in, or recover the
   login. Explain the PE–TM (telemarketer) binding: how to add Fast2SMS's
   telemarketer id under the entity, and how to share header YAJURS and the
   approved templates with Fast2SMS. Give Fast2SMS's TM id if you know it,
   or say exactly where in the Fast2SMS panel to read it.
3. In Fast2SMS → DLT: add entity id 1701172544496584296 and sender id
   YAJURS. Say whether the approved templates must also be added there for
   the dlt_manual route, or only for the dlt route.
4. Get the API key from Dev API and tell me any IP allow-listing or
   permission settings for a server calling from Google Cloud Run (no fixed
   IP).
5. Add credit: recommend a starting amount for the volume above and the
   current per-SMS price on the DLT route.
6. Send one test with the bulkV2 endpoint using my real values (give me the
   exact curl command with placeholders for the key and my number), and
   tell me how to read the delivery report and the error codes in the
   Fast2SMS panel when the operator rejects a message on DLT scrubbing.
7. List the templates to register next for every school (OTP login, fee
   payment link, results published, transport delay, generic "you have a
   message in the app"), with draft wording that follows DLT rules:
   variables as {#var#}, at most 30 characters each, static text fixed,
   school name at the end.

Keep every answer short and practical. When something differs by operator
portal, say so for each. Do not invent Fast2SMS menu names; if unsure, tell
me what to look for.
