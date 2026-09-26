-- 00344_yajur_dlt_sms (tenant D1, data only). Only touches the database whose
-- institution is named "Yajur Public School..."; a no-op everywhere else.
-- Steps 1 and 2 are undone by 00345; apply 00344, 00345, 00346 in order.

-- 1. the channel (Yajur's own row, MSG91 shape, no key, disabled)
INSERT INTO integrations (institution_id, provider, kind, config, credentials, enabled)
SELECT i.id, 'sms', 'messaging',
       json_object('endpoint', 'https://api.msg91.com/api/sendhttp.php', 'method', 'GET', 'encoding', 'form',
         'sender_id', 'YAJURS', 'dlt_entity_id', '1701172544496584296',
         'dlt_entity_name', 'MEGHAA EDUCATIONAL SOCIETY',
         'params', json_object('authkey', '{key}', 'mobiles', '{to}', 'message', '{text}',
            'sender', '{sender}', 'route', '4', 'country', '91', 'DLT_TE_ID', '{dlt}')),
       NULL, 0
  FROM institutions i
 WHERE i.name LIKE 'yajur public school%'
ON CONFLICT (institution_id, provider) DO UPDATE
   SET config = json_set(integrations.config,
                  '$.dlt_entity_id', '1701172544496584296',
                  '$.dlt_entity_name', 'MEGHAA EDUCATIONAL SOCIETY',
                  '$.sender_id', CASE WHEN COALESCE(json_extract(integrations.config, '$.sender_id'), '') = ''
                                      THEN 'YAJURS' ELSE json_extract(integrations.config, '$.sender_id') END);

-- 2. the route
INSERT INTO message_routing (institution_id, channel, route)
SELECT i.id, 'sms', 'own' FROM institutions i WHERE i.name LIKE 'yajur public school%'
ON CONFLICT (institution_id, channel) DO UPDATE SET route = 'own', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');

-- 3. the templates (approved DLT wording, byte for byte)
WITH t(code, dlt, body) AS (VALUES
  ('student.birthday', '1707172553275551435',
   'Dear Student,{{student_name}}, May your life filled with love, harmony, peace, energy and success throughout the year.Wish you a very Happy Birthday. Stay blessed! -YAJUR PUBLIC SCHOOL'),
  ('admissions.enquiry_link', '1707172553119743595',
   'Dear Parent,Thank you for your interest in our YAJUR PUBLIC SCHOOL. We look forward to work together creating a better future for {{student_name}} -YAJUR PUBLIC SCHOOL'),
  ('admissions.application_received', '1707172553123049305',
   'Dear Parent, Thank you for your interest in our school. One of our executives will be in touch with you shortly. Your Enquiry Code is {{application_no}} -YAJUR PUBLIC SCHOOL'),
  ('admissions.accepted', '1707172553116617511',
   'Dear Parent, Welcome to the YAJUR PUBLIC SCHOOL family. Congratulations! {{student_name}} is admitted in the class {{class_sought}}. Please note the Enrollment number as {{application_no}} Regards -YAJUR PUBLIC SCHOOL'),
  ('fees.overdue', '1707178299170210131',
   'Dear Parent, Kindly pay {{fee_name}} fee of Rs. {{amount_rs}} for your ward, {{student_name}} on or before {{due_on}}. Please ignore this message if the payment has already been made. - Yajur Public School'),
  ('fees.receipt', '1707176199105280510',
   'Dear Parent, the fee amount of {{amount_rs}} received against the fee of {{fee_name}}. – YAJUR PUBLIC SCHOOL'),
  ('fees.payment_confirmed', '1707176223932283263',
   'Dear Parent, Fee Amount of {{amount_rs}} Received against fee of {{fee_name}} - {{period}} by Mode of Payment {{mode}} via {{channel}} - YAJUR PUBLIC SCHOOL'),
  ('attendance.absent', '1707172553162869059',
   'Dear Parent,Your child {{student_name}} of {{class_name}} is absent on {{on_date}}.Please send {{student_name}} regularly. -YAJUR PUBLIC SCHOOL'),
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
  ('ptm.notice', '1707177157988042347',
   'Dear Parent, The PTM for {{exam_name}} will be conducted from {{from_time}} to {{to_time}} on {{on_date}} {{day}} for Grade 1 to Grade 8. For more details, kindly check the announcement section in MCB app. - YAJUR PUBLIC SCHOOL')
)
INSERT INTO message_templates (institution_id, code, channel, subject, body, dlt_template_id, is_active)
SELECT i.id, t.code, 'sms', NULL, t.body, t.dlt, 1
  FROM institutions i CROSS JOIN t
 WHERE i.name LIKE 'yajur public school%'
ON CONFLICT (institution_id, code, channel) DO UPDATE
   SET body = excluded.body, dlt_template_id = excluded.dlt_template_id, is_active = 1;
