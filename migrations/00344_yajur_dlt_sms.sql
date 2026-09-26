-- +goose Up
/* Yajur Public School's DLT identity and approved SMS templates.

   Pulled from the school's MyClassBoard instance on 26 Sep 2026, so that the
   day MSG91 is linked the messages already say what the operator has agreed
   they may say. Every row is scoped to the one institution and is skipped
   silently if that school is not in this database (a fresh dev copy, a test
   tenant), so the migration is safe everywhere.

   Three things:
     1. the SMS channel row on integrations, shaped as the MSG91 preset with
        the school's header (YAJURS) and Principal Entity, and no key: the
        authkey is typed on the screen, and the channel stays disabled until
        it is, so nothing here can send. On a school that already linked a
        vendor only the DLT fields are added.
     2. the route: the school sends on its own account, not ours.
     3. the templates. MCB writes a variable as '*'; here it is the
        {{placeholder}} the sender fills, chosen to match what each trigger
        supplies (see builtinTemplates and the finders in message_rules.go).
        Static text is byte-for-byte the approved wording, spacing and
        punctuation included, because the operator rejects any drift.
        The four templates MCB shows truncated (16, 18, 19, 20 in the brief)
        are not seeded: an approximate template is a rejected message.
        Template 10 sends a password over SMS and is left out on purpose. */
SET LOCAL app.is_platform_admin = 'on';

-- 1. the channel
INSERT INTO integrations (institution_id, provider, kind, config, credentials, enabled)
SELECT i.id, 'sms', 'messaging',
       jsonb_build_object(
         'endpoint', 'https://api.msg91.com/api/sendhttp.php',
         'method', 'GET',
         'encoding', 'form',
         'sender_id', 'YAJURS',
         'dlt_entity_id', '1701172544496584296',
         'dlt_entity_name', 'MEGHAA EDUCATIONAL SOCIETY',
         'params', jsonb_build_object(
            'authkey', '{key}', 'mobiles', '{to}', 'message', '{text}',
            'sender', '{sender}', 'route', '4', 'country', '91',
            'DLT_TE_ID', '{dlt}')),
       NULL, false
  FROM institutions i
 WHERE i.name ILIKE 'yajur public school%'
ON CONFLICT (institution_id, provider) DO UPDATE
   SET config = integrations.config
                || jsonb_build_object('dlt_entity_id', '1701172544496584296',
                                      'dlt_entity_name', 'MEGHAA EDUCATIONAL SOCIETY')
                || CASE WHEN COALESCE(integrations.config->>'sender_id', '') = ''
                        THEN jsonb_build_object('sender_id', 'YAJURS') ELSE '{}'::jsonb END;

-- 2. the route
INSERT INTO message_routing (institution_id, channel, route)
SELECT i.id, 'sms', 'own' FROM institutions i WHERE i.name ILIKE 'yajur public school%'
ON CONFLICT (institution_id, channel) DO UPDATE SET route = 'own', updated_at = now();

-- 3. the templates
INSERT INTO message_templates (institution_id, code, channel, subject, body, dlt_template_id, is_active)
SELECT i.id, t.code, 'sms', NULL, t.body, t.dlt, true
  FROM institutions i
  CROSS JOIN (VALUES
    -- 1 birthday (no trigger yet; usable the day one exists)
    ('student.birthday', '1707172553275551435',
     'Dear Student,{{student_name}}, May your life filled with love, harmony, peace, energy and success throughout the year.Wish you a very Happy Birthday. Stay blessed! -YAJUR PUBLIC SCHOOL'),
    -- 3 enquiry taken: the trigger supplies the child's name, not a code
    ('admissions.enquiry_link', '1707172553119743595',
     'Dear Parent,Thank you for your interest in our YAJUR PUBLIC SCHOOL. We look forward to work together creating a better future for {{student_name}} -YAJUR PUBLIC SCHOOL'),
    -- 2 application received: the application number is the enquiry code
    ('admissions.application_received', '1707172553123049305',
     'Dear Parent, Thank you for your interest in our school. One of our executives will be in touch with you shortly. Your Enquiry Code is {{application_no}} -YAJUR PUBLIC SCHOOL'),
    -- 4 admitted
    ('admissions.accepted', '1707172553116617511',
     'Dear Parent, Welcome to the YAJUR PUBLIC SCHOOL family. Congratulations! {{student_name}} is admitted in the class {{class_sought}}. Please note the Enrollment number as {{application_no}} Regards -YAJUR PUBLIC SCHOOL'),
    -- 6 fee due
    ('fees.overdue', '1707178299170210131',
     'Dear Parent, Kindly pay {{fee_name}} fee of Rs. {{amount_rs}} for your ward, {{student_name}} on or before {{due_on}}. Please ignore this message if the payment has already been made. - Yajur Public School'),
    -- 7 receipt, 8 payment confirmation (no trigger yet)
    ('fees.receipt', '1707176199105280510',
     'Dear Parent, the fee amount of {{amount_rs}} received against the fee of {{fee_name}}. – YAJUR PUBLIC SCHOOL'),
    ('fees.payment_confirmed', '1707176223932283263',
     'Dear Parent, Fee Amount of {{amount_rs}} Received against fee of {{fee_name}} - {{period}} by Mode of Payment {{mode}} via {{channel}} - YAJUR PUBLIC SCHOOL'),
    -- 9 absent
    ('attendance.absent', '1707172553162869059',
     'Dear Parent,Your child {{student_name}} of {{class_name}} is absent on {{on_date}}.Please send {{student_name}} regularly. -YAJUR PUBLIC SCHOOL'),
    -- 11, 12 holidays; 13, 14 closures; 15 buses off (sent by hand)
    ('holiday.range', '1707173528125241061',
     'Dear parent, This is to inform you that the school remains closed from {{from_date}} to {{to_date}} on the occasion of {{occasion}}. School reopens on {{reopen_on}} -YAJUR PUBLIC SCHOOL'),
    ('holiday.single', '1707173528002449774',
     'Dear parent, This is to inform you that school remains closed {{day}} i,e. on {{on_date}} on the occasion of {{occasion}}. School reopens on {{reopen_on}} - YAJUR PUBLIC SCHOOL'),
    ('school.closure', '1707176181237991703',
     'Dear Parent, due to {{reason}}, the school will remain closed on {{on_date}}. Regular classes will resume from {{resume_on}}. – Yajur Public School'),
    ('school.closure_reopen', '1707176181479586427',
     'Dear Parent, Due to {{reason}}, the school will remain closed {{day}} i.e., on {{on_date}}. School reopens on {{reopen_on}}. – Yajur Public School'),
    ('transport.buses_off', '1707176183716546865',
     'Dear Parent, due to {{reason}}, school buses will not operate on {{on_date}}. Please arrange own transport for your child. – Yajur Public School'),
    -- 17 PTM notice (grades 1 to 8)
    ('ptm.notice', '1707177157988042347',
     'Dear Parent, The PTM for {{exam_name}} will be conducted from {{from_time}} to {{to_time}} on {{on_date}} {{day}} for Grade 1 to Grade 8. For more details, kindly check the announcement section in MCB app. - YAJUR PUBLIC SCHOOL')
  ) AS t(code, dlt, body)
 WHERE i.name ILIKE 'yajur public school%'
ON CONFLICT (institution_id, code, channel) DO UPDATE
   SET body = EXCLUDED.body, dlt_template_id = EXCLUDED.dlt_template_id, is_active = true;

-- +goose Down
-- The school's own configuration is not undone by a rollback.
SELECT 1;
