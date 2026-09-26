/* builtinTemplates of internal/api/messaging.go, word for word: the bodies
   used when a school has written none of its own. */

export interface BuiltinTemplate { subject: string; body: string }

export const BUILTIN_TEMPLATES: Record<string, BuiltinTemplate> = {
  'credits.low': {
    subject: '{{school_name}}: {{channel}} messages running low ({{balance}} left)',
    body: '{{school_name}} has {{balance}} {{channel}} messages left, below the warning point of {{low_water}}.\n\n' +
      'Ask for more from Communication → Message channels → {{channel}} before it stops.\n\n{{school_name}}',
  },
  'credits.empty': {
    subject: '{{school_name}}: {{channel}} messages have stopped',
    body: '{{school_name}} has no {{channel}} messages left. Everything queued is being held, not lost, ' +
      'and goes out the moment credits are added.\n\n' +
      'Ask for more from Communication → Message channels → {{channel}}.\n\n{{school_name}}',
  },
  'transport.trip_started': {
    subject: "{{student_name}}'s bus has started",
    body: "{{student_name}}'s {{direction}} bus on {{route_name}} has just started, heading to {{stop_name}}. You can follow it live now.\n\n{{school_name}}",
  },
  'transport.bus_approaching': {
    subject: "{{student_name}}'s bus is nearly at {{stop_name}}",
    body: "{{student_name}}'s bus is about {{distance_m}} m from {{stop_name}}.\n\n{{school_name}}",
  },
  'transport.bus_reached_school': {
    subject: "{{student_name}}'s bus has reached school",
    body: "{{student_name}}'s bus has reached {{school_name}}.",
  },
  'transport.bus_at_stop': {
    subject: "{{student_name}}'s bus is at {{stop_name}}",
    body: "{{student_name}}'s bus has arrived at {{stop_name}}.\n\n{{school_name}}",
  },
  'attendance.absent': {
    subject: '{{student_name}} was marked absent',
    body: 'Dear parent,\n\n{{student_name}} was marked absent on {{on_date}} at {{school_name}}.\n\nIf this is unexpected, please contact the school office.',
  },
  'admissions.enquiry_link': {
    subject: 'Applying to {{school_name}}',
    body: 'Namaste {{parent_name}}, thank you for your enquiry about {{student_name}} at {{school_name}}.\n\nYou can fill in the application here:\n{{apply_url}}\n\nCall us if you need any help.',
  },
  'admissions.portal_login': {
    subject: 'Your parent login for {{school_name}}',
    body: 'Namaste {{parent_name}}, welcome to {{school_name}}.\n\n' +
      'You can now see fees, attendance, homework and the bus here:\n{{portal_url}}\n\n' +
      'Sign in as: {{sign_in_as}}\nPassword: {{password}}\n\n' +
      'That is your own mobile number, so anyone could guess it - the app ' +
      'asks you to set your own password the first time you sign in.',
  },
  'admissions.applicant_login': {
    subject: 'Track your admission at {{school_name}}',
    body: 'Namaste {{parent_name}}, thank you for your enquiry about {{student_name}} ' +
      'at {{school_name}}.\n\nYou can follow the admission here - the form, the ' +
      'documents, the test and the decision:\n{{portal_url}}\n\n' +
      'Sign in as: {{sign_in_as}}\nPassword: {{password}}\n\n' +
      'That is your own mobile number - the app asks you to set your own ' +
      'password the first time you sign in.',
  },
  'admissions.applicant_ready': {
    subject: 'Track your admission at {{school_name}}',
    body: 'Namaste {{parent_name}}, thank you for your enquiry about {{student_name}} ' +
      'at {{school_name}}.\n\nYou can follow the admission here:\n{{portal_url}}\n\n' +
      'Sign in as: {{sign_in_as}}\nYour password has been sent to your email address. ' +
      'If you did not give one, the school office will hand it to you.',
  },
  'admissions.portal_ready': {
    subject: 'Your parent login for {{school_name}}',
    body: 'Namaste {{parent_name}}, welcome to {{school_name}}.\n\n' +
      'You can now see fees, attendance, homework and the bus here:\n{{portal_url}}\n\n' +
      'Sign in as: {{sign_in_as}}\nYour password has been sent to your email address. ' +
      'If you did not give one, the school office will hand it to you.',
  },
  'admissions.applicant_existing': {
    subject: '{{school_name}}: your enquiry is on your existing login',
    body: 'Namaste {{parent_name}}, your enquiry about {{student_name}} at ' +
      '{{school_name}} can be followed on the login you already use.\n\n' +
      'Sign in as: {{sign_in_as}}\n{{portal_url}}\n\nYour password is unchanged.',
  },
  'admissions.portal_existing': {
    subject: '{{school_name}}: your second child is now on your login',
    body: 'Namaste {{parent_name}}, your new admission at {{school_name}} is on the ' +
      'same login you already use.\n\nSign in as: {{sign_in_as}}\n{{portal_url}}\n\n' +
      'Your password is unchanged.',
  },
  'admissions.application_received': {
    subject: 'We have your application for {{student_name}}',
    body: 'Namaste {{parent_name}},\n\nWe have received your application for ' +
      '{{student_name}} for {{class_sought}} at {{school_name}}. Your ' +
      'application number is {{application_no}} - please quote it when you ' +
      'contact us.\n\nYou can follow it here at any time:\n{{portal_url}}\n\n' +
      'We will write to you as each stage is reached.',
  },
  'admissions.under_review': {
    subject: '{{school_name}}: application {{application_no}} is being reviewed',
    body: 'Namaste {{parent_name}},\n\nThe application for {{student_name}} ' +
      '({{application_no}}) is now with the admissions committee. There is ' +
      'nothing you need to do at this stage; we will write when there is ' +
      'news.\n\n{{portal_url}}\n\n{{school_name}}',
  },
  'admissions.documents_pending': {
    subject: 'Documents still needed for {{student_name}}',
    body: 'Namaste {{parent_name}},\n\nWe still need some papers before the ' +
      'application for {{student_name}} ({{application_no}}) can go ' +
      'forward.\n\nSign in to see exactly which ones are outstanding:\n' +
      '{{portal_url}}\n\n{{school_name}}',
  },
  'admissions.test_scheduled': {
    subject: 'Entrance test for {{student_name}}',
    body: 'Namaste {{parent_name}},\n\nAn entrance test has been scheduled for ' +
      '{{student_name}} ({{application_no}}). The date, the time and where ' +
      'to come are on your admission page:\n{{portal_url}}\n\n{{school_name}}',
  },
  'admissions.interviewed': {
    subject: 'Thank you for coming in - {{student_name}}',
    body: 'Namaste {{parent_name}},\n\nThank you for bringing {{student_name}} ' +
      'in. The interview for application {{application_no}} is done and the ' +
      'decision now rests with the school; we will write to you as soon as ' +
      'it is made.\n\n{{portal_url}}\n\n{{school_name}}',
  },
  'admissions.offered': {
    subject: 'A place has been offered to {{student_name}}',
    body: 'Namaste {{parent_name}},\n\nWe are glad to tell you that a place in ' +
      '{{class_sought}} has been offered to {{student_name}} at ' +
      '{{school_name}} against application {{application_no}}.\n\nPlease ' +
      'contact the admissions office to confirm the seat. The details are ' +
      'on your admission page:\n{{portal_url}}',
  },
  'admissions.accepted': {
    subject: 'Welcome to {{school_name}}, {{student_name}}',
    body: 'Namaste {{parent_name}},\n\nThe admission of {{student_name}} to ' +
      '{{class_sought}} at {{school_name}} is confirmed against application ' +
      '{{application_no}}.\n\nWhat happens next - the papers, the fees and ' +
      'the first day - is on your admission page:\n{{portal_url}}',
  },
  'admissions.rejected': {
    subject: '{{school_name}}: about your application for {{student_name}}',
    body: 'Namaste {{parent_name}},\n\nWe are sorry to tell you that we are ' +
      'unable to offer {{student_name}} a place in {{class_sought}} this ' +
      'session (application {{application_no}}).\n\nThank you for ' +
      'considering {{school_name}}, and we wish {{student_name}} ' +
      'well.\n\n{{school_name}}',
  },
  'admissions.waitlisted': {
    subject: '{{student_name}} is on the waiting list',
    body: 'Namaste {{parent_name}},\n\n{{student_name}} has been placed on the ' +
      'waiting list for {{class_sought}} at {{school_name}} against ' +
      'application {{application_no}}. We will write to you the moment a ' +
      'place becomes available.\n\n{{portal_url}}',
  },
  'admissions.office_message': {
    subject: "{{school_name}}: about {{student_name}}'s application",
    body: 'Namaste {{parent_name}},\n\n{{message}}\n\nThis is about the ' +
      'application for {{student_name}} ({{application_no}}).\n\n' +
      '{{portal_url}}\n\n{{school_name}}',
  },
  'fees.overdue': {
    subject: 'Fees overdue for {{student_name}}',
    body: 'Dear parent,\n\nInvoice {{invoice_no}} for {{student_name}} shows {{amount_due}} outstanding since {{due_on}}.\n\n{{school_name}}',
  },
  'payroll.payslip': {
    subject: 'Your payslip for {{month}} {{year}}',
    body: 'Dear {{staff_name}},\n\nYour payslip for {{month}} {{year}} is ready. Take-home pay: {{net_pay}}.\n\nSign in and open My pay to see the full breakup, what was deducted and your leave balance.\n\n{{school_name}}',
  },
  'ptm.reminder': {
    subject: 'Parent-teacher meeting on {{on_date}}',
    body: 'Dear parent,\n\nYour meeting about {{student_name}} is on {{on_date}} at {{starts_at}}.\n\n{{school_name}}',
  },
  'homework.set': {
    subject: 'New work for {{student_name}} - {{subject}}',
    body: 'Dear parent,\n\n{{title}}\n\nSubject: {{subject}}\nDue: {{due_on}}\n\n{{school_name}}',
  },
  'student.remark': {
    subject: '{{title}}',
    body: 'Dear parent,\n\n{{summary}}\n\nWritten by {{teacher}} on {{on_date}}.\n\n{{school_name}}',
  },
  'reportcard.published': {
    subject: '{{student_name}} - report card ready',
    body: 'Dear parent,\n\nThe {{exam_name}} report card for {{student_name}} has been published. Sign in to see the marks, the grade and the attendance.\n\n{{school_name}}',
  },
  'announcement.published': {
    subject: '{{title}}',
    body: '{{title}}\n\n{{body}}\n\n{{school_name}}',
  },
  'messaging.direct': { subject: '{{subject}}', body: '{{text}}' },
  'messaging.test': {
    subject: 'Test message from {{school_name}}',
    body: 'This is a test message sent from the messaging settings screen. If you are reading it, the provider works.',
  },
  'report_digest.daily': { subject: '{{subject}}', body: '{{body}}' },
  'report_digest.weekly': { subject: '{{subject}}', body: '{{body}}' },
}

/** templatePlaceholders: the {{names}} a body uses, in order, once each. */
export function templatePlaceholders(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/* applicant_messages.go init(): the four applicant notes are registered as
   built-ins admissions.offer / .documents / .test / .regret. */
export const APPLICANT_NOTES: Record<string, BuiltinTemplate> = {
  offer: { subject: 'A place has been offered',
    body: 'Dear {{parent}}, we are glad to offer {{child}} a place in {{class}} at {{school}}. Application {{application_no}}. Please confirm by paying the admission fee at the school office.' },
  documents: { subject: 'Documents still needed',
    body: 'Dear {{parent}}, application {{application_no}} for {{child}} is waiting on paperwork: {{detail}}. Please bring the originals to the school office.' },
  test: { subject: 'Entrance test',
    body: 'Dear {{parent}}, {{child}} is due to sit the entrance test for {{class}}. {{detail}} Please arrive fifteen minutes early with application {{application_no}}.' },
  regret: { subject: 'About your application',
    body: 'Dear {{parent}}, thank you for applying to {{school}} for {{child}}. We are not able to offer a place in {{class}} this session. {{detail}}' },
}
for (const [kind, note] of Object.entries(APPLICANT_NOTES)) BUILTIN_TEMPLATES['admissions.' + kind] = note
