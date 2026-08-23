/* The English message catalogue — the source of truth for every string that
   has been extracted so far, and the file every other locale is translated
   from.

   ─────────────────────────────────────────────────────────────────────
   THE CONVENTION. Follow it; the next locale depends on it.
   ─────────────────────────────────────────────────────────────────────

   1. KEY SHAPE is `area.screen.slot`. Area is the folder under
      `web/src/features` (`portal`); screen is the file without its extension,
      lower snake (`ParentIDCard.tsx` → `parent_id_card`); slot names the place
      the words appear — `eyebrow`, `title`, `description`, `empty_title`,
      `empty_body`, `col_child`, `action_print`, `loading`. Words that belong
      to no single screen go under `common.`.

   2. ENGLISH IS THE KEY'S DEFINITION, not a hint. The value here is the exact
      string that used to be inline: same words, same casing, same punctuation,
      the same ellipsis character (…, never three dots) and the same em dash
      (—). Extraction is byte-identical or it is a bug. If a string reads badly,
      fix it in a separate change — never while extracting, because then nobody
      can tell a translation regression from an intended edit.

   3. ONE KEY PER MEANING, not per occurrence. Two screens showing "Save" for
      the same act share `common.save`. Two screens showing the same English
      word for different acts get two keys — a language that distinguishes them
      cannot if they share one.

   4. NO CONCATENATION. Never `t('a') + name + t('b')`. A sentence with a value
      in it is one key with a named placeholder:
          'portal.parent_id_card.guardian_of_many': 'Guardian of {count} children'
      called as t('portal.parent_id_card.guardian_of_many', { count }).
      Word order differs between languages; joining fragments hard-codes
      English order and cannot be translated out.

   5. WHAT IS NOT A STRING. Do not extract data the server returned (a child's
      name, a document type, a severity label), catalogue feature names, ids,
      or class names. Only words this repository chose to show a human.

   6. SINGULAR / PLURAL. This runtime has no plural engine, on purpose. Where
      English needs one, ship both forms as sibling keys (`..._one` /
      `..._many`) and choose in the component. Telugu's rules match English
      closely enough that a CLDR plural engine is not yet earning its weight;
      when a locale needs one it belongs in i18n.tsx, not in the callers.

   7. ADDING A LOCALE means copying these keys with translated values into
      `web/src/locales/<tag>.ts`, typed `Partial<Messages>`, and registering it
      in CATALOGUES in `web/src/lib/i18n.tsx`. Partial is deliberate: a missing
      key falls back to English, so a half-finished translation ships a mixed
      screen rather than a broken one. The fallback chain never yields a blank.

   ─────────────────────────────────────────────────────────────────────
   SCOPE TODAY. Every parent-facing screen under `web/src/features/portal/` is
   extracted — Portal, Fees, Receipts, Results, Attendance reporting, Calendar,
   Alerts, Gallery, PTM, Consent, Cafeteria, IEPGoals, both ID cards, Pickup,
   Requests, LeaveRequests, Concerns, EventPasses, TeacherMessages, Forum, and
   the three the convention was first written against — plus the
   display-preference strings the language selector itself needs.

   THE STAFF-FACING APP IS DELIBERATELY NOT EXTRACTED, and should not be until
   somebody intends to translate it. An admin console half in one language is
   worse than one wholly in English: a parent meets one screen at a time and a
   mixed portal still reads, whereas an operator moving between a Telugu list
   and an English form loses the vocabulary that makes the two the same tool.

   Extraction is byte-identical English or it is a bug — same words, casing,
   punctuation, ellipsis (…) and em dash (—). If a string reads badly, fix it
   in a separate change, so nobody has to tell a translation regression from
   an intended edit.
   ───────────────────────────────────────────────────────────────────── */

export const en = {
  // --- portal / Documents.tsx -------------------------------------------
  'portal.documents.loading': 'Looking up the file…',
  'portal.documents.eyebrow': 'Requests',
  'portal.documents.title': 'Documents on file',
  'portal.documents.description':
    'What the school holds for your child, and whether the office has checked it.',
  'portal.documents.stat_on_file': 'On file',
  'portal.documents.stat_checked': 'Checked by the office',
  'portal.documents.stat_unchecked': 'Still to be checked',
  'portal.documents.card_title': 'Documents',
  'portal.documents.card_description':
    'Anything missing has to go to the office — the portal does not accept uploads yet.',
  'portal.documents.col_document': 'Document',
  'portal.documents.col_child': 'Child',
  'portal.documents.col_given_on': 'Given on',
  'portal.documents.col_size': 'Size',
  'portal.documents.col_checked': 'Checked',
  'portal.documents.empty': 'The school holds nothing on file for your child.',
  'portal.documents.badge_checked': 'checked',
  'portal.documents.badge_unchecked': 'not checked yet',
  'portal.documents.checked_by': 'by {name}',

  // --- portal / Reminders.tsx -------------------------------------------
  'portal.reminders.loading': 'Checking what needs doing…',
  'portal.reminders.eyebrow': 'Reminders',
  'portal.reminders.title': 'Waiting on you',
  'portal.reminders.description':
    'Homework not turned in, fees not paid, notices not acknowledged — only the things that still need an action.',
  'portal.reminders.empty_title': 'Nothing outstanding',
  'portal.reminders.empty_body':
    'Everything the school has asked of you is done. This list stays empty until something needs doing.',
  // Two keys rather than one with a conditional prefix: the urgent form counts
  // and the calm form does not, and a language may not build them alike.
  'portal.reminders.card_title_urgent': '{count} needing attention now',
  'portal.reminders.card_title': 'To do',
  'portal.reminders.card_description': 'Most pressing first.',
  'portal.reminders.footnote': 'Anything already done drops off this list on its own.',

  // --- portal / ParentIDCard.tsx ----------------------------------------
  'portal.parent_id_card.loading': 'Building your card…',
  'portal.parent_id_card.no_card': 'No card returned',
  'portal.parent_id_card.eyebrow': 'Profile',
  'portal.parent_id_card.title': 'Campus entry pass',
  'portal.parent_id_card.description':
    'Show this at the gate. The code refreshes itself every couple of minutes.',
  'portal.parent_id_card.action_print': 'Print pass',
  'portal.parent_id_card.card_kind': 'Guardian entry pass',
  'portal.parent_id_card.no_children': 'No children linked to this account',
  'portal.parent_id_card.guardian_of_one': 'Guardian of',
  'portal.parent_id_card.guardian_of_many': 'Guardian of {count} children',
  'portal.parent_id_card.pass_number': 'Pass number {serial}',
  'portal.parent_id_card.gate_note':
    'Read out the pass number and the code at the gate. A screenshot will not work for long — the code changes, which is what stops it being passed on.',

  // --- portal / Forum.tsx -----------------------------------------------
  // The parents' class board. Extracted because this screen is parent-facing
  // and the convention above says parent-facing screens carry no inline
  // English; every value here is the exact string the component used to hold.
  'portal.forum.loading': 'Opening your class board…',
  'portal.forum.loading_thread': 'Opening the thread…',
  'portal.forum.eyebrow': 'Messages',
  'portal.forum.title': 'Class parent forum',
  'portal.forum.description':
    'For coordinating between the parents of one class — the trip, the concert, who is driving.',
  'portal.forum.stat_threads': 'Threads',
  'portal.forum.stat_mine': 'Started by you',
  'portal.forum.stat_class': 'Class',
  'portal.forum.stat_class_all': 'All your classes',
  'portal.forum.picker_title': 'Which class',
  'portal.forum.picker_description':
    'One board per child. You can read the boards of the classes your own children are in, and no others.',
  'portal.forum.picker_label': 'Class board',
  'portal.forum.picker_all': 'All your classes',
  'portal.forum.no_board_title': 'No class board yet',
  'portal.forum.no_board_body':
    'A board appears once your child has an enrolment on record. If that looks wrong, the office can check the admission.',
  'portal.forum.threads_title': 'Threads',
  'portal.forum.threads_description': 'Pinned notices first, then whatever is being talked about.',
  'portal.forum.threads_empty': 'Nobody has started a thread on this board yet.',
  'portal.forum.col_thread': 'Thread',
  'portal.forum.col_started_by': 'Started by',
  'portal.forum.col_replies': 'Replies',
  'portal.forum.col_last': 'Last activity',
  'portal.forum.action_open': 'Open',
  'portal.forum.action_close': 'Close',
  'portal.forum.action_post': 'Post to the board',
  'portal.forum.action_reply': 'Reply',
  'portal.forum.action_report': 'Report this thread',
  'portal.forum.posted': 'Posted.',
  'portal.forum.badge_mine': 'you',
  'portal.forum.badge_staff': 'school',
  'portal.forum.badge_open': 'Open',
  'portal.forum.badge_locked': 'Locked',
  'portal.forum.compose_title': 'Start a thread',
  'portal.forum.compose_description':
    'Something the other parents in this class need to know or decide together.',
  'portal.forum.field_child': 'Which child',
  'portal.forum.field_child_hint': 'This decides which class board the thread goes to.',
  'portal.forum.field_child_placeholder': 'Choose a child',
  'portal.forum.field_category': 'What it is about',
  'portal.forum.field_title': 'In one line',
  'portal.forum.field_title_placeholder': 'Lifts to the museum on Friday',
  'portal.forum.field_body': 'What you want to say',
  'portal.forum.named_notice':
    'Your name and your relation to your child appear on everything you post here. There is no anonymous posting.',
  'portal.forum.grievance_notice':
    'If something has gone wrong, raise it under Concerns instead. That route is private, tracked and answered to a deadline; this board is not.',
  'portal.forum.thread_by': 'Started by {name} ({relation}) on {at}',
  'portal.forum.thread_missing': 'That thread could not be opened.',
  'portal.forum.no_replies': 'No replies yet.',
  'portal.forum.reply_placeholder': 'Write a reply…',
  'portal.forum.pick_child_first': 'Choose which child this is about before replying.',
  'portal.forum.locked_because': 'Closed to new replies: {reason}',
  'portal.forum.converted_notice':
    'The school moved this into the concerns queue, where it is tracked and answered. You can follow it under Concerns.',
  'portal.forum.taken_down': 'Taken down: {reason}',
  'portal.forum.report_explainer':
    'Report something a member of staff should read. Reporting does not hide it — a person decides.',
  'portal.forum.report_label': 'What is wrong with it',
  'portal.forum.report_placeholder': 'What is wrong with it',
  'portal.forum.report_confirm': 'Report',
  'portal.forum.report_question': 'A member of staff will read this thread and your reason.',
  'portal.forum.reported': 'Reported. A member of staff will read it.',
  'portal.forum.category_general': 'General',
  'portal.forum.category_event': 'An event',
  'portal.forum.category_trip': 'A trip',
  'portal.forum.category_volunteering': 'Volunteering',
  'portal.forum.category_logistics': 'Getting there and back',
  'portal.forum.category_lost_found': 'Lost and found',
  'portal.forum.category_question': 'A question',

  // --- portal / Portal.tsx ----------------------------------------------
  'portal.portal.eyebrow': 'Portal',
  'portal.portal.title': 'My day',
  'portal.portal.description': 'Attendance, homework due, fees and what is coming up.',
  'portal.portal.no_link_title': 'No student record linked',
  'portal.portal.no_link_body':
    'Your account is not linked to a student yet. Ask the school office to connect it.',
  'portal.portal.empty_title': 'Nothing recorded yet',
  'portal.portal.empty_body':
    'Attendance, homework and fees appear here once the school starts recording them for this student.',
  'portal.portal.stat_attendance': 'Overall attendance',
  'portal.portal.stat_attendance_delta': '{count} days marked',
  'portal.portal.stat_present': 'Present',
  'portal.portal.stat_absent': 'Absent',
  // One key: "N days" means the same thing under Present and under Absent.
  'portal.portal.stat_days': '{count} days',
  'portal.portal.stat_homework': 'Homework due',
  'portal.portal.stat_homework_value': '{count} pending',
  'portal.portal.homework_none': 'Nothing outstanding',
  'portal.portal.homework_soonest': 'Soonest {when}',
  // The four forms dueIn() picks between, each a whole phrase rather than a
  // fragment joined to the one above.
  'portal.portal.due_overdue': 'overdue',
  'portal.portal.due_today': 'today',
  'portal.portal.due_tomorrow': 'tomorrow',
  'portal.portal.due_in_days': 'in {days} days',
  'portal.portal.stat_fees': 'Fees outstanding',
  'portal.portal.fees_payable': 'Payable now',
  'portal.portal.fees_settled': 'All settled',
  'portal.portal.stat_next_exam': 'Next exam',
  'portal.portal.today_title': "Today's classes",
  'portal.portal.today_description': 'In order, with the teacher taking each one.',
  'portal.portal.today_none_description': 'Nothing timetabled today.',
  'portal.portal.today_empty_title': 'No classes today',
  'portal.portal.today_empty_body':
    'A holiday, a weekend, or the timetable has not been set for this section.',
  'portal.portal.children_title': 'Linked children',
  'portal.portal.children_description': 'Switch above to change the view',
  'portal.portal.not_enrolled': 'Not enrolled',
  'portal.portal.history_title': 'Attendance history',
  'portal.portal.history_description': 'Last 120 days, most recent first',
  'portal.portal.history_empty': 'No attendance recorded yet.',

  // --- portal / Fees.tsx -------------------------------------------------
  'portal.fees.eyebrow': 'Fees',
  'portal.fees.title': 'Fees',
  'portal.fees.title_due': '{amount} due',
  'portal.fees.title_nothing_due': 'Nothing due',
  'portal.fees.description_due':
    'For {name}. Pay at the school office and the receipt appears here.',
  'portal.fees.description_paid': "{name}'s fees are fully paid. Receipts are listed below.",
  'portal.fees.no_link_title': 'No student record linked',
  'portal.fees.no_link_body':
    'Your account is not linked to a student yet. Ask the school office to connect it.',
  'portal.fees.no_record_title': 'No fee record yet',
  'portal.fees.no_record_body':
    'The school has not raised a bill for this student. It appears here as soon as it does.',
  'portal.fees.action_print': 'Print statement',
  'portal.fees.stat_outstanding': 'Outstanding',
  'portal.fees.stat_overdue': 'Overdue instalments',
  'portal.fees.stat_overdue_delta': '{days} days late',
  'portal.fees.stat_overdue_none': 'Nothing late',
  'portal.fees.stat_paid': 'Paid so far',
  'portal.fees.instalments_title': 'Instalments',
  'portal.fees.instalments_description': 'What the school has billed, and when it falls due',
  'portal.fees.instalments_empty_title': 'No bill raised yet',
  'portal.fees.instalments_empty_body':
    'Instalments appear here as the school issues them for the year.',
  'portal.fees.col_instalment': 'Instalment',
  'portal.fees.col_due': 'Due',
  'portal.fees.col_amount': 'Amount',
  'portal.fees.col_paid': 'Paid',
  'portal.fees.col_still_due': 'Still due',
  'portal.fees.col_status': 'Status',
  'portal.fees.instalment_no': 'Instalment {number}',
  'portal.fees.days_late': '{days}d late',
  'portal.fees.incl_fine': 'incl. {amount} fine',
  'portal.fees.receipts_title': 'Receipts',
  'portal.fees.receipts_description': 'Every payment recorded against this student',
  'portal.fees.receipts_empty_title': 'No payments yet',
  'portal.fees.col_receipt': 'Receipt',
  'portal.fees.col_date': 'Date',
  'portal.fees.col_mode': 'Mode',
  'portal.fees.col_reference': 'Reference',
  'portal.fees.bounced_note':
    'A payment above was returned by the bank, so the amount is still owed. Please contact the office.',

  // --- portal / Receipts.tsx ---------------------------------------------
  'portal.receipts.loading': 'Looking up your payments…',
  'portal.receipts.eyebrow': 'Fees',
  'portal.receipts.title': 'Receipts',
  'portal.receipts.description':
    'Every payment the school has banked, with a receipt you can print or save.',
  'portal.receipts.stat_receipts': 'Receipts',
  'portal.receipts.stat_paid_total': 'Paid in total',
  'portal.receipts.stat_most_recent': 'Most recent',
  'portal.receipts.card_title': 'Payments',
  'portal.receipts.card_description': 'Only money the bank has cleared appears here.',
  'portal.receipts.col_receipt': 'Receipt',
  'portal.receipts.col_child': 'Child',
  'portal.receipts.col_paid_on': 'Paid on',
  'portal.receipts.col_how': 'How',
  'portal.receipts.col_amount': 'Amount',
  'portal.receipts.empty': 'No payments have cleared yet.',
  'portal.receipts.action_hide': 'Hide',
  'portal.receipts.action_open': 'Open',
  'portal.receipts.detail_loading': 'Rendering the receipt…',
  'portal.receipts.detail_title': 'Receipt {number}',
  'portal.receipts.detail_description': '{institution} · financial year {year}',
  'portal.receipts.action_download': 'Download PDF',
  'portal.receipts.detail_received_from': 'Received from',
  'portal.receipts.detail_admission_no': 'Admission number',
  'portal.receipts.detail_class': 'Class',
  'portal.receipts.detail_paid_on': 'Paid on',
  'portal.receipts.detail_method': 'Method',
  'portal.receipts.detail_status': 'Status',
  'portal.receipts.col_invoice': 'Invoice',
  'portal.receipts.col_particulars': 'Particulars',
  'portal.receipts.col_line_amount': 'Amount',
  'portal.receipts.total': 'Total',

  // --- portal / Consent.tsx ---------------------------------------------
  'portal.consent.loading': 'Checking what needs signing…',
  'portal.consent.eyebrow': 'Consent',
  'portal.consent.title': 'Waiting on you',
  'portal.consent.description':
    'Permissions the school has asked you to give, and the trips your child has asked to take.',
  'portal.consent.stat_trips': 'Trips to agree to',
  'portal.consent.stat_circulars': 'Circulars to sign',
  'portal.consent.stat_out_now': 'Out now',
  'portal.consent.trips_title': 'Leaving campus',
  'portal.consent.trips_description':
    'Your agreement is separate from the warden\'s, and the gate needs both before your child can leave.',
  'portal.consent.trips_empty_title': 'Nothing waiting',
  'portal.consent.trips_empty_body':
    'When your child asks to go out, the request appears here for you to agree to.',
  'portal.consent.pass_window': '{from} until {to}',
  'portal.consent.going_with': 'Going with {name}',
  'portal.consent.warden_permitted': 'The warden has permitted this ({name}).',
  'portal.consent.warden_not_permitted': 'The warden has not permitted this yet.',
  'portal.consent.action_agree': 'I agree',
  // The stat above counts them; this heads the list of them. Separate keys so a
  // language that shortens a stat label need not shorten the card title too.
  'portal.consent.circulars_title': 'Circulars to sign',
  'portal.consent.circulars_description': 'Notices the school has asked you to acknowledge.',
  'portal.consent.circulars_empty_title': 'All signed',
  'portal.consent.circulars_empty_body': 'Nothing from the school is waiting on you.',
  'portal.consent.action_ack': 'I have read this',
  'portal.consent.request_prompt':
    'Taking your child out for a wedding, a hospital visit or a weekend home?',
  // The button that opens the form and the form's own heading. Same English,
  // two keys: one is asked of the reader, the other names what they opened.
  'portal.consent.request_action': 'Ask for a pass',
  'portal.consent.request_title': 'Ask for a pass',
  'portal.consent.request_description':
    'The warden still has to permit it. Leaving the escort\'s number lets the hostel reach whoever the child is with.',
  'portal.consent.field_child': 'Child',
  'portal.consent.field_child_placeholder': 'Choose a child',
  'portal.consent.field_going_to': 'Going to',
  'portal.consent.field_going_to_placeholder': 'Karimnagar',
  'portal.consent.field_leaving': 'Leaving',
  'portal.consent.field_leaving_hint': 'Date and time the child goes out.',
  'portal.consent.field_back_by': 'Back by',
  'portal.consent.field_back_by_hint': 'The hour the hostel will start looking for them.',
  'portal.consent.field_escort': 'Who they are going with',
  'portal.consent.field_escort_placeholder': 'Suresh Menon',
  'portal.consent.field_escort_phone': 'That person\'s number',
  'portal.consent.field_escort_phone_placeholder': '98480 12345',
  'portal.consent.field_reason': 'Reason',
  'portal.consent.field_reason_placeholder': 'Cousin\'s wedding',
  'portal.consent.action_sending': 'Sending…',
  'portal.consent.action_send': 'Send to the warden',
  'portal.consent.history_title': 'Past passes',
  'portal.consent.history_description': 'Every trip asked for, and what came of it.',

  // --- portal / Results.tsx ---------------------------------------------
  'portal.results.eyebrow': 'Results',
  'portal.results.title': 'Results',
  'portal.results.no_child_title': 'No student record linked',
  'portal.results.no_child_body':
    'Your account is not linked to a student yet. Ask the school office to connect it.',
  'portal.results.none_title': 'No results published yet',
  'portal.results.none_body':
    'Your school has not released any results yet. They appear here as soon as it does — nothing provisional is shown.',
  'portal.results.published_title': 'Published results',
  'portal.results.published_description': 'Report cards the school has released for {name}.',
  'portal.results.stat_latest': 'Latest',
  'portal.results.stat_grade': 'Grade',
  'portal.results.stat_rank': 'Rank in section',
  'portal.results.gpa': 'GPA {value}',
  'portal.results.stat_attendance': 'Attendance',
  'portal.results.stat_attendance_hint': 'On the report card',
  'portal.results.cards_title': 'Report cards',
  'portal.results.cards_description': 'Only what the school has released',
  'portal.results.cards_empty_title': 'Nothing released yet',
  'portal.results.cards_empty_body':
    'Marks may already be entered; they appear here once the school publishes the card.',
  'portal.results.col_term': 'Term',
  'portal.results.col_total': 'Total',
  'portal.results.col_percentage': 'Percentage',
  'portal.results.col_grade': 'Grade',
  'portal.results.col_rank': 'Rank',
  'portal.results.col_published': 'Published',
  'portal.results.class_teacher': 'Class teacher',
  // One form only: the original renders "subjects" for every count, including
  // one, and extraction does not change what the screen says.
  'portal.results.subject_count': '{count} subjects',
  'portal.results.col_subject': 'Subject',
  'portal.results.col_marks': 'Marks',
  'portal.results.col_out_of': 'Out of',
  'portal.results.col_subject_grade': 'Grade',
  'portal.results.absent': 'Absent',

  // --- portal / Calendar.tsx --------------------------------------------
  'portal.calendar.loading': 'Looking up the calendar…',
  'portal.calendar.eyebrow': 'School life',
  'portal.calendar.title': 'Calendar',
  'portal.calendar.description':
    'Holidays, examinations, events and the meetings you have booked.',
  'portal.calendar.stat_coming_up': 'Coming up',
  'portal.calendar.stat_examinations': 'Examinations',
  'portal.calendar.stat_events': 'Events',
  'portal.calendar.stat_your_meetings': 'Your meetings',
  'portal.calendar.field_child': 'Child',
  'portal.calendar.field_child_hint': 'Events for a class are shown only for the child in it.',
  'portal.calendar.all_children': 'All my children',
  'portal.calendar.empty_title': 'Nothing scheduled',
  'portal.calendar.empty_body':
    'When the school publishes holidays, examinations or events they will appear here.',
  'portal.calendar.entry_count': '{count} entries',
  // The entry kinds this repository names itself. Any other kind is titled from
  // the server's own word, which is data and stays unextracted.
  'portal.calendar.kind_ptm_booking': 'Your meeting',
  'portal.calendar.kind_working_day': 'Working day',
  'portal.calendar.kind_annual_day': 'Annual day',
  'portal.calendar.kind_sports_day': 'Sports day',
  'portal.calendar.kind_field_trip': 'Field trip',

  // --- portal / Alerts.tsx ----------------------------------------------
  'portal.alerts.loading': 'Looking up your alerts…',
  'portal.alerts.eyebrow': 'Home',
  'portal.alerts.title': 'Alerts',
  'portal.alerts.description':
    'Circulars, absences, fees and homework — in the order they happened.',
  'portal.alerts.action_mark_all_read': 'Mark all read',
  'portal.alerts.stat_unread': 'Unread',
  'portal.alerts.stat_fee_alerts': 'Fee alerts',
  'portal.alerts.stat_absences_flagged': 'Absences flagged',
  'portal.alerts.field_child': 'Child',
  'portal.alerts.field_child_hint':
    'School-wide circulars are shown whichever child you choose.',
  'portal.alerts.all_children': 'All my children',
  'portal.alerts.card_title': 'Everything',
  'portal.alerts.card_description': '{count} alerts.',
  'portal.alerts.empty_title': 'Nothing yet',
  'portal.alerts.empty_body':
    'Circulars, absences and fee reminders will appear here as they happen.',
  'portal.alerts.action_dismiss': 'Dismiss',
  // As on the calendar: the kinds this repository names. An unknown kind falls
  // back to the server's own word.
  'portal.alerts.kind_fee_due': 'Fees',
  'portal.alerts.kind_attendance': 'Attendance',
  'portal.alerts.kind_homework': 'Homework',
  'portal.alerts.kind_circular': 'Circular',
  'portal.alerts.kind_ptm': 'Meeting',
  'portal.alerts.kind_event': 'Event',

  // --- portal / Pickup.tsx ----------------------------------------------
  'portal.pickup.loading': 'Checking your passes…',
  'portal.pickup.eyebrow': 'Consent',
  'portal.pickup.title': 'Someone else collecting',
  'portal.pickup.description':
    'Name a person the school may release your child to, once, on one day.',
  'portal.pickup.stat_in_force': 'Passes in force',
  'portal.pickup.stat_used': 'Used',
  'portal.pickup.stat_cancelled': 'Cancelled',
  'portal.pickup.code_title': 'Give them this number',
  'portal.pickup.code_description':
    'The gate will ask for it. Do not send it to anyone but the person collecting.',
  'portal.pickup.collecting': 'collecting {child} on {date}',
  'portal.pickup.cancel_confirm': 'Cancel it',
  'portal.pickup.cancel_question': 'The code stops working immediately.',
  'portal.pickup.action_cancel': 'Cancel',
  'portal.pickup.history_title': 'Everything you have authorised',
  'portal.pickup.history_description': 'Kept so the school can answer who collected whom.',
  'portal.pickup.col_person': 'Person',
  'portal.pickup.col_child': 'Child',
  'portal.pickup.col_day': 'Day',
  'portal.pickup.col_why': 'Why',
  'portal.pickup.col_what_happened': 'What happened',
  'portal.pickup.empty': 'You have not asked anyone else to collect your child.',
  // Shown only when the school recorded no kind of ID for the person.
  'portal.pickup.id_fallback': 'ID',
  'portal.pickup.collected_on': 'collected {date}',
  'portal.pickup.released_by': ' · released by {name}',
  'portal.pickup.form_title': 'Authorise somebody',
  'portal.pickup.form_description':
    'Good for one collection on one day. Leaving the last four digits of their ID lets the gate check the person in front of them is the person you meant.',
  'portal.pickup.field_child': 'Child',
  'portal.pickup.child_placeholder': 'Choose a child',
  'portal.pickup.field_name': 'Their name',
  'portal.pickup.name_placeholder': 'Suresh Menon',
  'portal.pickup.field_phone': 'Their number',
  'portal.pickup.field_relation': 'Who they are to the child',
  'portal.pickup.field_day': 'Which day',
  'portal.pickup.field_day_hint': 'Leave blank for today. A month ahead at most.',
  'portal.pickup.field_id': 'ID they will carry',
  'portal.pickup.id_placeholder': 'None',
  'portal.pickup.field_id_last4': 'Last four digits of it',
  'portal.pickup.field_reason': 'Why somebody else',
  'portal.pickup.reason_placeholder':
    'I am travelling and will not be back before school closes',
  'portal.pickup.action_creating': 'Creating…',
  'portal.pickup.action_create': 'Create the pass',
  'portal.pickup.created_ok': 'Give them the code {code}.',

  // --- portal / PTM.tsx --------------------------------------------------
  'portal.ptm.loading': 'Looking up meeting times…',
  'portal.ptm.eyebrow': 'School life',
  'portal.ptm.title': 'Parent-teacher meeting',
  'portal.ptm.description':
    "Take a time with your child's teacher instead of queueing on the morning.",
  'portal.ptm.stat_free': 'Times still free',
  'portal.ptm.stat_yours': 'Your meetings',
  'portal.ptm.stat_held': 'Meetings held',
  'portal.ptm.book_title': 'Book a time',
  'portal.ptm.book_description':
    'Choose a child, add anything you would like raised, then take a slot.',
  'portal.ptm.field_child': 'Child',
  'portal.ptm.child_placeholder': 'Which child…',
  'portal.ptm.field_note': 'What would you like to discuss?',
  'portal.ptm.field_note_hint': 'Optional. The teacher sees this before the meeting.',
  'portal.ptm.note_placeholder': 'Reading progress',
  'portal.ptm.booked_ok': 'Meeting booked.',
  'portal.ptm.col_date': 'Date',
  'portal.ptm.col_time': 'Time',
  'portal.ptm.col_teacher': 'Teacher',
  'portal.ptm.col_for': 'For',
  'portal.ptm.col_where': 'Where',
  'portal.ptm.empty_slots': 'The school has not opened any times yet.',
  'portal.ptm.slot_minutes': ' · {minutes} min',
  'portal.ptm.slot_class': 'Class {section}',
  'portal.ptm.slot_any_class': 'Any class',
  'portal.ptm.slot_yours': 'Yours · {name}',
  'portal.ptm.slot_taken': 'Taken',
  'portal.ptm.choose_child_first': 'Choose a child first',
  'portal.ptm.action_take': 'Take this time',
  'portal.ptm.mine_title': 'Your meetings',
  'portal.ptm.mine_description': 'Including what was agreed, where the school has shared it.',
  'portal.ptm.empty_title': 'No meetings yet',
  'portal.ptm.empty_body': 'Take a time above and it will appear here.',
  'portal.ptm.with_teacher': ' with {teacher}',
  'portal.ptm.meeting_when': '{date} · {time} · {minutes} min',
  'portal.ptm.cancel_confirm': 'Give up the slot',
  'portal.ptm.cancel_question': 'The time goes back to the school.',
  'portal.ptm.action_cancel': 'Cancel',
  'portal.ptm.label_raised': 'Raised: ',
  'portal.ptm.label_agreed': 'Agreed: ',

  // --- portal / Cafeteria.tsx --------------------------------------------
  'portal.cafeteria.loading': 'Looking up the canteen till…',
  'portal.cafeteria.eyebrow': 'Fees',
  'portal.cafeteria.title': 'Canteen',
  'portal.cafeteria.description':
    'Every item bought at the counter, with the time it was bought.',
  'portal.cafeteria.stat_spent': 'Spent',
  'portal.cafeteria.stat_purchases': 'Purchases',
  'portal.cafeteria.stat_calories': 'Calories',
  'portal.cafeteria.field_child': 'Child',
  'portal.cafeteria.option_all_children': 'All my children',
  'portal.cafeteria.empty_title': 'Nothing bought',
  'portal.cafeteria.empty_body':
    'When your child buys something at the canteen counter it will appear here within minutes.',
  'portal.cafeteria.day_summary_one': '{count} purchase · {kcal} kcal',
  'portal.cafeteria.day_summary_many': '{count} purchases · {kcal} kcal',
  'portal.cafeteria.item_kcal': '{kcal} kcal',
  'portal.cafeteria.badge_non_veg': 'Non-veg',
  'portal.cafeteria.badge_allergens': 'Contains {allergens}',

  // --- portal / StudentIDCard.tsx ----------------------------------------
  'portal.student_id_card.loading': 'Building the card…',
  'portal.student_id_card.no_card': 'No card returned',
  'portal.student_id_card.eyebrow': 'Profile',
  'portal.student_id_card.title': 'Student ID card',
  'portal.student_id_card.description':
    "Your child's identity card, with a code that refreshes itself.",
  'portal.student_id_card.action_print': 'Print card',
  'portal.student_id_card.field_child': 'Child',
  'portal.student_id_card.choose_title': 'Choose a child',
  'portal.student_id_card.choose_body':
    'A card and its gate code belong to one child, so this screen has to know whose.',
  'portal.student_id_card.photo': 'Photo',
  'portal.student_id_card.no_photo': 'No photo',
  'portal.student_id_card.not_enrolled': 'Not enrolled',
  'portal.student_id_card.roll': ' · Roll {roll}',
  'portal.student_id_card.admission_no': 'Admission no.',
  'portal.student_id_card.date_of_birth': 'Date of birth',
  'portal.student_id_card.blood_group': 'Blood group',
  'portal.student_id_card.house': 'House',
  'portal.student_id_card.emergency': 'In an emergency',
  'portal.student_id_card.allergies': 'Allergies',
  'portal.student_id_card.pass_number': 'Card number {serial}',
  'portal.student_id_card.gate_note':
    'Refreshes about every two minutes. Show this screen, not a photograph of it.',

  // --- portal / Requests.tsx ---------------------------------------------
  'portal.requests.loading': 'Looking up your requests…',
  'portal.requests.eyebrow': 'Requests',
  'portal.requests.title': 'Certificates',
  'portal.requests.description':
    'Ask the office for a document, and see how far it has got without ringing them.',
  'portal.requests.stat_with_office': 'With the office',
  'portal.requests.stat_issued': 'Issued',
  'portal.requests.stat_ready': 'Ready to collect',
  'portal.requests.form_title': 'Ask for a certificate',
  'portal.requests.form_description':
    'The office writes the purpose on the certificate itself, so say what it is for.',
  'portal.requests.field_child': 'Child',
  'portal.requests.choose_child': 'Choose a child',
  'portal.requests.field_which': 'Which certificate',
  'portal.requests.hint_needs_approval': 'This one needs the principal to approve it first.',
  'portal.requests.choose_one': 'Choose one',
  'portal.requests.no_types': 'The school has not set any up',
  'portal.requests.field_purpose': 'What it is for',
  'portal.requests.purpose_placeholder': 'Passport application',
  'portal.requests.sending': 'Sending…',
  'portal.requests.action_ask': 'Ask the office',
  'portal.requests.sent_ok': 'Asked. The office can see it now.',
  'portal.requests.list_title': 'Your requests',
  'portal.requests.list_description': 'The number is what to quote if you ring the office.',
  'portal.requests.col_number': 'Number',
  'portal.requests.col_certificate': 'Certificate',
  'portal.requests.col_child': 'Child',
  'portal.requests.col_for': 'For',
  'portal.requests.col_asked_on': 'Asked on',
  'portal.requests.col_where': 'Where it is',
  'portal.requests.empty': 'You have not asked for any certificates.',
  'portal.requests.signed_copy': 'signed copy on file',
  // The documents panel folded into this screen. Its own keys rather than
  // Documents.tsx's: the same English, but a different screen's wording to
  // translate, and the two are free to diverge.
  'portal.requests.docs_title': 'Documents the school holds',
  'portal.requests.docs_description':
    '{count} on file, {unchecked} still to be checked. Anything missing has to go to the office — the portal does not accept uploads yet.',
  'portal.requests.docs_description_empty':
    'Nothing on file yet. Documents given to the office appear here.',
  'portal.requests.docs_col_document': 'Document',
  'portal.requests.docs_col_child': 'Child',
  'portal.requests.docs_col_given_on': 'Given on',
  'portal.requests.docs_col_size': 'Size',
  'portal.requests.docs_col_checked': 'Checked',
  'portal.requests.docs_empty': 'The school holds nothing on file.',
  'portal.requests.docs_badge_checked': 'checked',
  'portal.requests.docs_badge_unchecked': 'not checked yet',
  'portal.requests.docs_checked_by': 'by {name}',

  // --- portal / LeaveRequests.tsx ----------------------------------------
  'portal.leave_requests.loading': 'Looking up your applications…',
  'portal.leave_requests.eyebrow': 'Leave & absence',
  'portal.leave_requests.title': 'Time off school',
  'portal.leave_requests.description':
    'Every day you have asked for, and what the school decided.',
  'portal.leave_requests.stat_waiting': 'Waiting on the school',
  'portal.leave_requests.stat_approved': 'Approved this year',
  'portal.leave_requests.stat_days': 'Days approved',
  'portal.leave_requests.list_title': 'Applications',
  'portal.leave_requests.list_description':
    'A pending application can be withdrawn; once the school has decided, it stands.',
  'portal.leave_requests.col_child': 'Child',
  'portal.leave_requests.col_days': 'Days',
  'portal.leave_requests.col_reason': 'Reason',
  'portal.leave_requests.col_decision': 'Decision',
  'portal.leave_requests.empty': 'You have not asked for any time off.',
  'portal.leave_requests.applied_on': 'applied {date}',
  'portal.leave_requests.half_day': 'half day',
  'portal.leave_requests.days_one': '{count} day',
  'portal.leave_requests.days_many': '{count} days',
  'portal.leave_requests.decided_by': 'by {name}',
  'portal.leave_requests.withdraw': 'Withdraw',
  'portal.leave_requests.withdraw_question': 'The school will no longer see this application.',
  'portal.leave_requests.form_title': 'Ask for time off',
  'portal.leave_requests.form_description':
    'The class teacher decides. Tell them why — an application with no reason usually comes back.',
  'portal.leave_requests.field_child': 'Child',
  'portal.leave_requests.choose_child': 'Choose a child',
  'portal.leave_requests.field_first_day': 'First day away',
  'portal.leave_requests.field_last_day': 'Last day away',
  'portal.leave_requests.field_last_day_hint': 'Leave blank for a single day.',
  'portal.leave_requests.field_half_day': 'Half day',
  'portal.leave_requests.half_day_label': 'Only half the day',
  'portal.leave_requests.half_day_hint': 'A half day is one day — the school counts it as 0.5.',
  'portal.leave_requests.field_reason': 'Reason',
  'portal.leave_requests.reason_placeholder': "Sister's wedding in Warangal",
  'portal.leave_requests.sending': 'Sending…',
  'portal.leave_requests.action_send': 'Send to the school',
  'portal.leave_requests.sent_ok': 'Sent. You will see it in the list below.',

  // --- portal / ReportAbsence.tsx ----------------------------------------
  'portal.report_absence.loading': 'Finding your children…',
  'portal.report_absence.eyebrow': 'Attendance',
  'portal.report_absence.title': 'Report an absence',
  'portal.report_absence.description':
    'Tell the school your child is not coming in. It reaches the class teacher straight away.',
  'portal.report_absence.form_title': 'Not coming in',
  'portal.report_absence.form_description':
    'For today, or a day in the last week you have not told us about yet. To book a day off ahead, apply for leave instead.',
  'portal.report_absence.field_child': 'Child',
  'portal.report_absence.choose_child': 'Choose a child',
  'portal.report_absence.field_why': 'Why',
  // The reason list this screen offers. The value posted to the server stays
  // the English string; only the label a parent reads is translated.
  'portal.report_absence.reason_fever': 'Fever',
  'portal.report_absence.reason_cold': 'Cold and cough',
  'portal.report_absence.reason_stomach': 'Stomach upset',
  'portal.report_absence.reason_doctor': 'Doctor’s appointment',
  'portal.report_absence.reason_family': 'Family emergency',
  'portal.report_absence.reason_other': 'Other',
  'portal.report_absence.field_day': 'Which day',
  'portal.report_absence.field_day_hint': 'Leave blank for today.',
  'portal.report_absence.field_detail': 'Anything else',
  'portal.report_absence.field_detail_other': 'Say what happened',
  'portal.report_absence.detail_placeholder': 'Running a temperature since last night',
  'portal.report_absence.sending': 'Telling the school…',
  'portal.report_absence.action_tell': 'Tell the school',
  'portal.report_absence.sent_ok': 'The class teacher has it.',
  'portal.report_absence.list_title': 'Already reported',
  'portal.report_absence.list_description': 'Days the school knows about.',
  'portal.report_absence.empty_title': 'Nothing outstanding',
  'portal.report_absence.empty_body':
    'You have not reported any absence the school is still holding.',

  // --- portal / Gallery.tsx ----------------------------------------------
  'portal.gallery.loading': 'Looking up the gallery…',
  'portal.gallery.eyebrow': 'School life',
  'portal.gallery.title': 'Photographs & video',
  'portal.gallery.description':
    'Sports day, annual day and everything else the school has shared.',
  'portal.gallery.album_fallback': 'Album',
  'portal.gallery.action_all_albums': 'All albums',
  'portal.gallery.album_loading': 'Opening the album…',
  'portal.gallery.album_empty_title': 'Nothing published yet',
  'portal.gallery.album_empty_body': 'The school has not released photographs from this event.',
  'portal.gallery.media_title': 'Media',
  'portal.gallery.media_description': '{count} items the school has published to families.',
  'portal.gallery.media_meta': '{name} · {size} · published {date}',
  'portal.gallery.stat_albums': 'Albums',
  'portal.gallery.stat_photographs': 'Photographs',
  'portal.gallery.stat_videos': 'Videos',
  'portal.gallery.field_child': 'Child',
  'portal.gallery.field_child_hint': 'An album for one class is shown only to that class.',
  'portal.gallery.all_children': 'All my children',
  'portal.gallery.empty_title': 'No albums yet',
  'portal.gallery.empty_body':
    'When the school publishes photographs from an event they will appear here.',
  'portal.gallery.class_label': 'Class {section}',
  'portal.gallery.counts': '{photos} photos · {videos} videos',
  'portal.gallery.action_open': 'Open',

  // --- portal / IEPGoals.tsx --------------------------------------------
  'portal.iep_goals.loading': 'Looking up the support plan…',
  'portal.iep_goals.eyebrow': 'Academics',
  'portal.iep_goals.title': 'Support plan & goals',
  'portal.iep_goals.description':
    'What the school agreed to do, and how far each goal has come.',
  'portal.iep_goals.field_child': 'Child',
  'portal.iep_goals.choose_child_title': 'Choose a child',
  'portal.iep_goals.choose_child_body':
    'A support plan is agreed for one child, so this screen has to know whose.',
  'portal.iep_goals.no_plan_title': 'No support plan',
  'portal.iep_goals.no_plan_body':
    'Your child does not have a support plan on file. If you believe they should, speak to the class teacher.',
  'portal.iep_goals.stat_goals': 'Goals',
  'portal.iep_goals.stat_met': 'Met',
  'portal.iep_goals.stat_average_progress': 'Average progress',
  'portal.iep_goals.stat_average_hint': 'Nothing measured yet',
  'portal.iep_goals.plan_title': 'The plan',
  'portal.iep_goals.plan_next_review': 'Next review {date}.',
  'portal.iep_goals.plan_no_review': 'No review date set.',
  'portal.iep_goals.plan_concern': 'What we are working on',
  'portal.iep_goals.plan_accommodations': 'In the classroom',
  'portal.iep_goals.plan_exam_concession': 'In examinations',
  'portal.iep_goals.plan_external_support': 'Outside the school',
  // The card heading over the goal list, kept apart from the stat tile that
  // counts them: a language may head a list differently from a count.
  'portal.iep_goals.goals_title': 'Goals',
  'portal.iep_goals.goals_description':
    'Each bar is the most recent measurement between where your child started and where the plan is aiming.',
  'portal.iep_goals.no_goals_title': 'No goals yet',
  'portal.iep_goals.no_goals_body':
    'The plan is in place but no measurable goals have been written against it.',
  'portal.iep_goals.aiming_for': ' · aiming for {date}',
  'portal.iep_goals.started_at': 'Started at {value}',
  'portal.iep_goals.now': 'Now {value}',
  'portal.iep_goals.target': 'Target {value}',
  'portal.iep_goals.progress_of_the_way': '{percent}% of the way',
  'portal.iep_goals.lower_is_better': ' — for this goal a lower number is better',
  'portal.iep_goals.recorded_in_words':
    'Recorded in words rather than numbers — see the notes below.',
  'portal.iep_goals.not_measured': 'Not measured yet.',
  'portal.iep_goals.footnote':
    'Some goals may be recorded but not shared here — a school may withhold a goal written from a clinical referral. Ask the class teacher if something you expected is missing.',

  // --- portal / EventPasses.tsx -----------------------------------------
  'portal.event_passes.loading': 'Looking up your passes…',
  'portal.event_passes.eyebrow': 'School life',
  'portal.event_passes.title': 'Event seating',
  'portal.event_passes.description':
    'Claim your seats for a school event and show the number at the door.',
  'portal.event_passes.action_print': 'Print passes',
  'portal.event_passes.stat_passes': 'Passes to use',
  'portal.event_passes.stat_seats': 'Seats held',
  'portal.event_passes.stat_attended': 'Events attended',
  'portal.event_passes.claim_title': 'Claim seats',
  'portal.event_passes.claim_description':
    'Seats are given out in the order families claim them.',
  'portal.event_passes.field_child': 'Child',
  'portal.event_passes.child_placeholder': 'Which child…',
  'portal.event_passes.field_event': 'Event',
  'portal.event_passes.event_placeholder': 'Choose an event…',
  'portal.event_passes.event_placeholder_none': 'No events open',
  'portal.event_passes.field_seats': 'Seats',
  'portal.event_passes.field_seats_hint': 'How many of you are coming.',
  'portal.event_passes.claim_ok': 'Seats confirmed.',
  // The button, kept apart from the card heading above it: one names the
  // section, the other is the act.
  'portal.event_passes.action_claim': 'Claim seats',
  'portal.event_passes.empty_title': 'No passes yet',
  'portal.event_passes.empty_body': 'Claim seats above and the pass will appear here.',
  'portal.event_passes.badge_withdrawn': 'Withdrawn',
  'portal.event_passes.badge_admitted': 'Admitted',
  'portal.event_passes.badge_valid': 'Valid',
  // No _one form: the original had none, and inventing one would change the
  // English. See the report — "1 seats" is reachable today.
  'portal.event_passes.seats_count': '{count} seats',
  'portal.event_passes.row_seat': 'Row {row}, seat {seat}',
  'portal.event_passes.row_seats': 'Row {row}, seats {from}–{to}',
  'portal.event_passes.show_code': 'Show this number at the door.',

  // --- portal / Concerns.tsx --------------------------------------------
  'portal.concerns.loading': 'Looking up your concerns…',
  'portal.concerns.eyebrow': 'Messages',
  'portal.concerns.title': 'Concerns',
  'portal.concerns.description':
    'Anything that has gone wrong, put in writing so the school can answer it.',
  'portal.concerns.stat_open': 'Open',
  'portal.concerns.stat_answered': 'Answered',
  'portal.concerns.stat_longest': 'Longest waiting',
  'portal.concerns.days': '{count} days',
  'portal.concerns.raise_title': 'Raise a concern',
  'portal.concerns.raise_description':
    'Say what happened and when. The office decides how urgent it is, so tell them the facts rather than marking it urgent.',
  'portal.concerns.field_category': 'What is it about',
  'portal.concerns.category_academic': 'Teaching and learning',
  'portal.concerns.category_fees': 'Fees and billing',
  'portal.concerns.category_transport': 'Bus and transport',
  'portal.concerns.category_hostel': 'Hostel',
  'portal.concerns.category_discipline': 'Behaviour and discipline',
  'portal.concerns.category_safety': 'Safety',
  'portal.concerns.category_staff': 'A member of staff',
  'portal.concerns.category_facilities': 'Building and facilities',
  'portal.concerns.category_other': 'Something else',
  'portal.concerns.field_child': 'Which child',
  'portal.concerns.field_child_hint': 'Leave blank if it is not about one child.',
  'portal.concerns.child_placeholder': 'Not about a particular child',
  'portal.concerns.field_priority': 'How pressing',
  'portal.concerns.priority_low': 'Whenever you can',
  'portal.concerns.priority_normal': 'Normal',
  'portal.concerns.priority_high': 'Needs attention soon',
  'portal.concerns.field_subject': 'In one line',
  'portal.concerns.subject_placeholder': 'Bus has been 30 minutes late all week',
  'portal.concerns.field_body': 'What happened',
  'portal.concerns.body_placeholder': 'Dates, times, and who you have already spoken to.',
  'portal.concerns.sending': 'Sending…',
  'portal.concerns.action_send': 'Send it',
  'portal.concerns.raise_ok': 'Raised. The office can see it now.',
  'portal.concerns.list_title': 'Your concerns',
  'portal.concerns.list_description':
    'Only yours — not those raised by anyone else in the family.',
  'portal.concerns.empty_title': 'Nothing raised',
  'portal.concerns.empty_body':
    "When you raise something, it stays here with the school's answer.",
  'portal.concerns.raised_on': ' · raised {date}',
  'portal.concerns.assigned_to': ' · with {name}',
  'portal.concerns.school_says': 'The school says: ',

  // --- portal / TeacherMessages.tsx --------------------------------------
  'portal.teacher_messages.loading': 'Finding your children…',
  'portal.teacher_messages.eyebrow': 'Messages',
  'portal.teacher_messages.title': "Your child's teachers",
  'portal.teacher_messages.description':
    'A direct line to the people who teach them. Anything the whole school needs to know belongs in a concern instead.',
  'portal.teacher_messages.picker_title': 'Who you are writing to',
  'portal.teacher_messages.field_child': 'Child',
  'portal.teacher_messages.child_placeholder': 'Choose a child',
  'portal.teacher_messages.field_teacher': 'Teacher',
  'portal.teacher_messages.teacher_placeholder': 'Choose a teacher',
  'portal.teacher_messages.teacher_placeholder_none': 'No teachers listed yet',
  'portal.teacher_messages.option_class_teacher': '{name} — class teacher',
  'portal.teacher_messages.option_unread': ' · {count} unread',
  // The empty state that asks the same question the picker's placeholder does,
  // kept separate: one is a prompt inside a control, the other a whole screen.
  'portal.teacher_messages.empty_child_title': 'Choose a child',
  'portal.teacher_messages.empty_child_body': 'Their teachers will appear here.',
  'portal.teacher_messages.empty_teachers_title': 'No teachers to write to yet',
  'portal.teacher_messages.empty_teachers_body':
    "Once the timetable is set for your child's class, their teachers appear here.",
  'portal.teacher_messages.thread_title': 'Conversation',
  'portal.teacher_messages.thread_class_teacher':
    'Class teacher — the person who knows the whole day.',
  'portal.teacher_messages.thread_teaches': 'Teaches {subject}.',
  'portal.teacher_messages.thread_loading': 'Opening the conversation…',
  'portal.teacher_messages.empty_thread_title': 'Nothing said yet',
  'portal.teacher_messages.empty_thread_body': 'Write the first message below.',
  'portal.teacher_messages.sender_you': 'You',
  'portal.teacher_messages.not_read': ' · not read yet',
  'portal.teacher_messages.draft_placeholder':
    'Ravi has been finding the algebra homework hard — could we talk about it?',
  'portal.teacher_messages.sending': 'Sending…',
  'portal.teacher_messages.action_send': 'Send',
  'portal.teacher_messages.badge_to': 'to {name}',

  // --- common (shared by more than one screen) ---------------------------
  // Only words that are the same act on every screen live here. Column
  // headings that merely coincide in English stay screen-local: a language
  // that renders "Amount" differently in a bill and in a receipt must be able
  // to.
  'common.cancel': 'Cancel',

  // --- display preferences ----------------------------------------------
  // The language selector's own strings live here so that switching language
  // also translates the control that switched it.
  'preferences.language.label': 'Language',
  'preferences.language.hint': 'Applies wherever you sign in, not just on this device.',
  'preferences.language.name_en': 'English',
  'preferences.contrast.label': 'Contrast',
  'preferences.contrast.checkbox': 'Higher contrast',
  'preferences.contrast.hint': 'Stronger text and borders. Off unless you turn it on.',

  // --- the layout switch --------------------------------------------------
  // Two buttons in the shell header. Classic is the product as it ships;
  // Bento is the opt-in experiment. See docs/BENTO_UI_CONTRACT.md.
  'shell.layout.group': 'Dashboard layout',
  'shell.layout.classic': 'Sidebar',
  'shell.layout.bento': 'Focus',

  // --- bento: my work -----------------------------------------------------
  // The smoke-test Bento screen. A later worker replaces it; these keys are
  // the ones the replacement should keep.
  'bento.my_work.title': 'My work',
  'bento.my_work.eyebrow': 'Home',
  'bento.my_work.fact_sections': 'Sections',
  'bento.my_work.fact_scoped': 'Section work',
  'bento.my_work.fact_own': 'My own',
  'bento.finance.fact_shown': 'Shown',
  'bento.finance.fact_total': 'Total',
  'bento.principal.fact_flagged': 'Flagged',
  'bento.principal.fact_roll': 'On the roll',
  'bento.principal.fact_clear': 'Clear',
  'bento.principal.fact_upcoming': 'Upcoming',
  'bento.my_work.outstanding': 'Outstanding',
  'bento.my_work.overdue': 'Overdue',
  'bento.my_work.sections': 'Sections',
  'bento.my_work.loading': 'Checking what is outstanding…',
  'bento.my_work.failed': 'That did not load. Nothing here is a figure you can rely on until it does.',
  'bento.my_work.kind_submissions': 'Submissions',
  'bento.my_work.kind_marks': 'Marks',
  'bento.my_work.kind_substitution': 'Cover',
  'bento.my_work.kind_leave': 'Leave',
  'bento.my_work.kind_announcement': 'Notices',
  // Outstanding — the queue and what it is made of.
  'bento.my_work.late_units': 'late',
  'bento.my_work.kinds_count': 'kinds',
  'bento.my_work.kinds_sr': 'Outstanding work by kind',
  'bento.my_work.kinds_note': 'The bar sums to the figure above it: each kind\'s own count, less leave already decided.',
  'bento.my_work.empty_queue': 'Nothing outstanding on this list.',
  'bento.my_work.late_head': 'Late',
  'bento.my_work.none_late': 'None of it is late.',
  'bento.my_work.due_head': 'Due',
  'bento.my_work.due_sr': 'Dated outstanding work, by when it falls due',
  'bento.my_work.due_late': 'Late',
  'bento.my_work.due_today': 'Today',
  'bento.my_work.due_week': '1-7d',
  'bento.my_work.due_later': '8d+',
  'bento.my_work.no_dates_at_all': 'Nothing outstanding carries a date.',
  'bento.my_work.largest_head': 'Largest marks queue',
  'bento.my_work.largest_none': 'No marks queue on this list.',
  'bento.my_work.largest_unit': '{count} missing',
  // Says out loud why there is no ranking across the kinds.
  'bento.my_work.units_note': 'Only marks papers are ranked against each other — marks, lessons and notices are different units.',
  'bento.my_work.dated_note': '{dated} of {count} outstanding items carry a date.',
  'bento.my_work.cap_note': 'Listed ten at a time ({kinds}), so these are at least the figures shown.',
  // Overdue — the ageing of the queue.
  'bento.my_work.oldest': 'oldest',
  'bento.my_work.days_late': '{days}d',
  'bento.my_work.of_listed': 'listed',
  'bento.my_work.of_items_note': 'Late rows out of the {count} on this list.',
  'bento.my_work.age_sr': 'Late work by how long it has been late',
  'bento.my_work.age_today': 'Today',
  'bento.my_work.age_week': '1-7d',
  'bento.my_work.age_month': '8-30d',
  'bento.my_work.age_old': '30d+',
  'bento.my_work.age_undated': 'No date',
  'bento.my_work.grid_sr': 'Late work by age and kind',
  'bento.my_work.oldest_head': 'Oldest late items',
  'bento.my_work.no_dated_late': 'Nothing late carries a date to age it by.',
  'bento.my_work.none_late_list': 'Nothing on this list is late.',
  // The handler has no priority column; the card says so rather than deriving one.
  'bento.my_work.no_priority': 'This endpoint carries no priority, so none is shown.',
  'bento.my_work.undated_note': '{n} late without a date.',
  // Sections — one figure, made dense by hierarchy.
  'bento.my_work.sections_caption': 'Your work list is scoped to them.',
  'bento.my_work.rows_head': 'Rows on this list',
  'bento.my_work.scope_section': 'from your sections',
  'bento.my_work.scope_own': 'from your account',
  'bento.my_work.rows_by_kind': 'Rows by kind',
  'bento.my_work.sections_note': 'Submissions, marks and cover are scoped by section; leave and notices by account.',
  // --- the card language ---------------------------------------------------
  'bento.my_work.on_you': 'Outstanding on you',
  'bento.my_work.by_kind_head': 'By kind',
  'bento.my_work.late_of': '{late} late, across {kinds} kinds.',
  'bento.my_work.marks_sr': 'Marks papers, by how many marks are still missing on each',
  'bento.my_work.late_rows_sub': 'Late rows',
  'bento.my_work.age_head': 'How late',
  'bento.my_work.late_rows_head': 'Late rows by kind',
  'bento.my_work.late_kind_sr': 'Late rows on this list, counted by kind',
  'bento.my_work.oldest_of': 'Oldest {days} days late, of {count} rows on this list.',
  'bento.my_work.oldest_sr': 'The oldest late items, in days past their due date',
  'bento.my_work.scoped_to': 'Your work is scoped to them',
  'bento.my_work.sections_sr': '{count} sections, one dot each',
  'bento.my_work.no_sections': 'No sections are assigned to you.',
  'bento.my_work.rows_kind_sr': 'Rows on this work list, counted by kind',
  'bento.my_work.scope_sr': 'Rows the handler scoped by section against rows it scoped by account',

  // --- bento: the head's dashboard ----------------------------------------
  // The Bento rendering of institution_admin.home.dashboard. Same endpoints as
  // the classic screen; these words describe the re-layout, not new data.
  'bento.principal.eyebrow': 'Home',
  'bento.principal.title': 'Executive overview',
  'bento.principal.loading': 'Opening the school on one page…',
  'bento.principal.failed': 'That did not load. Nothing here is a figure you can rely on until it does.',
  'bento.principal.anchor_label': 'Attendance today, and fee collection',
  'bento.principal.attendance_marked': '{count} marked today',
  'bento.principal.trend_sr': 'Attendance, percentage present, last 30 days',
  'bento.principal.above_median': 'Above the 30-day median',
  'bento.principal.below_median': 'Below the 30-day median',
  'bento.principal.trend_label': 'Attendance trend',
  'bento.principal.trend_caption': 'Last 30 days',
  'bento.principal.trend_failed': 'The 30-day trend did not load.',
  // --- the pulse cell, at four sizes -------------------------------------
  // Attendance drawn as an instrument. Every one of these names a figure the
  // two endpoints actually return: there is no attendance target in this
  // product, so every comparison below is the school against its own month.
  'bento.principal.pulse_label': 'Attendance today',
  'bento.principal.pulse_range': '{count} marked days',
  'bento.principal.pulse_marked_days': 'Marked on {marked} of the last {total} days',
  // Percentage POINTS, said in words, because a percentage of a percentage is
  // a different number and this is not it.
  'bento.principal.pulse_change': '{pts} points against the previous {count} days',
  'bento.principal.pulse_change_flat': 'Level with the previous {count} days',
  'bento.principal.pulse_median': 'Median {pct}%',
  'bento.principal.pulse_high': 'High {pct}% · {date}',
  'bento.principal.pulse_low': 'Low {pct}% · {date}',
  'bento.principal.pulse_iqr': 'Band: middle half of the period',
  // The handler COALESCEs an unmarked morning to 0%. A zero here would read as
  // "nobody came in", so the cell says what is actually true instead.
  'bento.principal.pulse_today_none': 'Nothing marked yet today',
  'bento.principal.pulse_no_series': 'No attendance has been marked in the last 30 days.',
  'bento.principal.pulse_trend_sr':
    'Attendance across {count} marked days: lowest {low}% on {lowDate}, highest {high}% on {highDate}, median {median}%, most recent {last}%.',
  'bento.principal.pulse_weekday_title': 'Median by weekday',
  'bento.principal.pulse_weekday_sr': 'Median attendance for each of the {count} weekdays the school marked',
  'bento.principal.pulse_weekday_row': '{day}: median {pct}% across {count} marked days',
  'bento.principal.pulse_comp_title': 'Present · absent, by day',
  'bento.principal.pulse_comp_sr':
    'Composition of the last {count} marked days: {present} present and {absent} absent in total. Each column is one day, its height the size of that day’s register.',
  'bento.principal.pulse_day_title': '{date}: {present} present, {absent} absent of {total} marked',
  // Sliced out of the ISO date rather than formatted through the browser's
  // locale, so a school day cannot move across a timezone.
  'bento.principal.pulse_months_short': 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec',
  // Sunday first: the index is getUTCDay(), not a reading order.
  'bento.principal.pulse_dow_short': 'Sun Mon Tue Wed Thu Fri Sat',
  'bento.principal.collected_label': "Collected against this year's bills",
  'bento.principal.collected_plain': 'Collected',
  'bento.principal.outstanding_plain': 'Outstanding',
  'bento.principal.collected_sr': "Collected as a share of this year's bills",
  'bento.principal.collected_of_billed': '{pct}% of {billed} billed this year',
  'bento.principal.outstanding': 'Outstanding this year',
  'bento.principal.outstanding_sr': "Outstanding as a share of this year's bills",
  'bento.principal.of_billed': 'of {billed} billed this year',
  'bento.principal.plus_arrears': 'Plus {amount} owed from earlier years',
  'bento.principal.defaulters': 'Fee defaulters',
  'bento.principal.defaulters_sr': 'Defaulters as a share of students on roll',
  'bento.principal.of_students': 'of {count} students',
  'bento.principal.students': 'Students',
  'bento.principal.sections': 'Across {count} sections',
  'bento.principal.staff': 'Staff',
  'bento.principal.as_of_today': 'As of today',
  'bento.principal.approvals': 'Pending approvals',
  'bento.principal.approvals_note': 'Leave requests waiting on a decision',
  'bento.principal.applications': 'Open applications',
  'bento.principal.applications_note': 'Not yet decided',
  // The tinted badges beside a figure. Each states the share in words, so the
  // hue behind it is never the only thing carrying the meaning.
  'bento.principal.pct_of_billed': '{pct}% of billed',
  'bento.principal.pct_of_students': '{pct}% of the roll',
  'bento.principal.needs_attention': 'Needs a teacher',
  // The bar chart. `bars_sr` is the whole series in one sentence, because the
  // bars themselves are a picture and a screen reader gets no shape from them.
  'bento.principal.bars_label': 'Attendance, last 10 school days',
  'bento.principal.bars_sr':
    'Attendance across the last {count} school days, ranging from {low}% to {high}% present. The most recent day is highlighted.',
  'bento.principal.bar_title': '{date} — {pct}% present',
  'bento.principal.bars_none': 'No attendance has been marked yet.',
  'bento.principal.unassigned': 'Unassigned subjects',
  'bento.principal.unassigned_note': 'No teacher timetabled',
  'bento.principal.cue_attendance': 'Attendance overview',
  'bento.principal.cue_fees': 'Fee collection',
  'bento.principal.cue_defaulters': 'Fee defaulters',
  'bento.principal.cue_students': 'Enrolment',
  'bento.principal.cue_staff': 'Faculty directory',
  'bento.principal.cue_approvals': 'Approvals',
  'bento.principal.cue_applications': 'Admissions pipeline',
  'bento.principal.cue_unassigned': 'Teacher assignment',

  /* THE FLAT CELLS.

     Eight widgets whose endpoint returns one number each. What follows is the
     vocabulary that makes them dense without making anything up: the name for
     a supporting figure, the word for a state, and the line that says which
     period the figure is true for.

     A FACT LABEL IS A NOUN, NOT A SENTENCE. It sits at 9.5px beside a bold
     figure and has to survive a 264px card, so every one of these is short
     enough to read at a glance and specific enough to say what was counted.
     "of the roll" rather than "%", because a bare percent sign beside a
     number is the shape of a claim with its subject missing. */
  'bento.principal.prov_as_of_now': 'As of now',
  'bento.principal.prov_this_year': 'This academic year',
  'bento.principal.fact_sections': 'sections',
  'bento.principal.fact_per_section': 'per section',
  'bento.principal.fact_staff': 'staff',
  'bento.principal.fact_per_teacher': 'per teacher',
  'bento.principal.fact_students_each': 'students each',
  'bento.principal.fact_on_roll': 'on roll',
  'bento.principal.fact_of_roll': 'of the roll',
  'bento.principal.fact_billed': 'billed',
  'bento.principal.fact_of_billed': 'of billed',
  'bento.principal.fact_defaulters': 'defaulters',
  'bento.principal.fact_earlier_years': 'from earlier years',
  /* The state beside the figure. Colour is never the only channel, and on
     these cells there is often no colour at all — so the word is the channel. */
  'bento.principal.tag_waiting': 'Waiting',
  'bento.principal.tag_clear': 'Clear',
  'bento.principal.tag_undecided': 'Undecided',
  'bento.principal.tag_all_covered': 'All covered',
  /* The tally is one mark per thing counted and no base at all, so its reading
     is simply the count and what was counted. */
  'bento.principal.approvals_tally_sr': '{count} leave requests waiting, one mark each',
  'bento.principal.applications_tally_sr': '{count} undecided applications, one mark each',
  'bento.principal.unassigned_tally_sr': '{count} subjects without a teacher, one mark each',
  /* The sentences. Each says what the number IS — which population, counted
     when — because that is the half of a figure a dashboard usually drops. */
  'bento.principal.students_note': 'Active students on roll, with the sections and staff counted at the same instant.',
  'bento.principal.staff_note': 'Active employees. The load is the roll divided by them, not a target.',
  'bento.principal.defaulters_note': 'Students with at least one invoice past its due date.',
  'bento.principal.outstanding_note_plain': 'Every unpaid invoice, of every year. No bills are tagged to an academic year, so there is nothing to show it against.',
  'bento.principal.collected_note_plain': "Receipts banked in this period, whatever year's bill they settle.",

  /* THE CARD VOCABULARY — the eight KPI cells rebuilt on `CardShell`.

     Two rules run through all of these. Every line under a figure names the
     POPULATION and the INSTANT, because a number without those is the half of
     a fact that gets quoted in a meeting. And every unit-grid label says what
     one dot is worth: a dot grid whose unit is unstated is decoration, and at
     a roll of four hundred one dot is never one child. */
  'bento.principal.card_pulse_title': 'Attendance today',
  'bento.principal.card_pulse_sub': 'Against the last 30 days',
  'bento.principal.card_pulse_month_sr': 'Attendance for each of the last 28 days, {days} of them marked',
  'bento.principal.card_pulse_short_sr': 'Attendance over the last ten marked days',
  /* Short enough to survive a 1x1 row label at 8px. The full words are in the
     card title and the screen-reader line. */
  'bento.principal.card_billed': 'Billed',
  'bento.principal.card_in': 'Collected',
  'bento.principal.card_due': 'Due',
  'bento.principal.card_this_year': 'This year',
  'bento.principal.card_earlier': 'Earlier',
  'bento.principal.card_roll_label': 'On roll',
  'bento.principal.card_arrears_label': 'In arrears',
  'bento.principal.card_of_billed': '{pct}% of {billed} billed',
  'bento.principal.card_of_billed_due': '{pct}% of billed, owed by {count} students',
  'bento.principal.card_due_plain': 'Unpaid invoices of every year, owed by {count} students',
  'bento.principal.card_range_receipts': "Receipts banked in this period, whatever year's bill they settle",
  'bento.principal.card_money_three_sr': 'Billed this year, collected against it and the balance still due, on one scale',
  'bento.principal.card_owed_by_sr': 'Arrears spread across {count} students, one dot per {unit}',
  'bento.principal.card_money_pair_sr': 'Receipts in this period and arrears of every year, drawn on one scale — neither is a share of the other',
  'bento.principal.card_arrears_split_sr': "Billed this year, the total owed, this year's share of it and the debt carried in from earlier years",
  'bento.principal.card_roll': '{sections} sections · {staff} staff',
  'bento.principal.card_roll_wide': '{sections} sections, {per} each · {staff} staff, {load} each',
  'bento.principal.card_roll_sr': '{count} students on roll, one dot per {unit}',
  'bento.principal.card_of_roll': '{pct}% of {roll} on roll',
  'bento.principal.card_defaulters_grid_sr': '{flagged} of {roll} students in arrears, one dot per {unit}',
  'bento.principal.card_unit': '{note} · one dot per {unit}',
  'bento.principal.card_queue_clear': 'Nothing waiting',
  'bento.principal.card_all_covered': 'Every subject has a teacher',
  'bento.principal.card_approvals_sr': '{count} leave requests waiting, one dot per {unit}',
  'bento.principal.card_applications_sr': '{count} undecided applications, one dot per {unit}',
  'bento.principal.card_unassigned_sr': '{count} subjects with no teacher timetabled, one dot per {unit}',

  /* The attention widgets. The label is this repository's words; the sentence
     under the figure is the server's headline and is not extracted, because a
     count already rendered into a sentence by the engine is data, not a
     string this screen chose. `attention_clear` is what a probe with nothing
     to report says — a calm zero is an answer, not an empty state. */
  /* NOT "all clear", because the client cannot know that. The engine drops a
     probe whose count is zero AND a probe the caller has no permission for,
     and both arrive as the same absent key — so the only defensible reading is
     that nothing was REPORTED, with the reason it might not have been said
     next to it. */
  'bento.principal.attention_clear': 'Nothing reported for this check',
  'bento.principal.attention_clear_note':
    'Only what your permissions cover is counted, so this is “nothing reported”, not a certified all-clear.',
  'bento.principal.attention_no_level': 'No level',
  'bento.principal.attention_failed': "Couldn't load what needs attention",
  'bento.principal.attention_loading': 'Checking…',
  'bento.principal.attention_pending': '—',
  /* Severity in words. The attention cards carry severity as a tint — pink
     for critical, orange for warning — and colour is never allowed to be the
     only channel, so the word is printed beside the figure at every size. */
  'bento.principal.sev_critical': 'Critical',
  'bento.principal.sev_warning': 'Warning',
  'bento.principal.sev_info': 'For information',
  /* The other half of a money card. Where the figure is the rupee amount, the
     count it was summed from is named beneath it — the payload carries both
     and the full card has room for both. */
  'bento.principal.attention_count': '{count} flagged',
  /* The count and the amount said about each other. A sum divided by the count
     the same query returned is arithmetic, not an invented denominator. */
  'bento.principal.attention_each': '{amount} each on average',
  'bento.principal.attention_stat_flagged': 'Flagged',
  'bento.principal.attention_stat_each': 'Average each',
  /* The severity ladder. Three rungs because the engine has exactly three
     levels — a closed vocabulary is a denominator nobody had to invent. The
     rung words are short so the scale reads as a scale; the definitions are
     the engine's own, transcribed from the Severity constants in
     internal/api/attention.go. */
  'bento.principal.attention_scale': 'How serious',
  'bento.principal.sev_rung_critical': 'Critical',
  'bento.principal.sev_rung_warning': 'Warning',
  'bento.principal.sev_rung_info': 'Info',
  'bento.principal.sev_def_critical': 'Money, safety or a deadline already missed',
  'bento.principal.sev_def_warning': 'Late, but recoverable today',
  'bento.principal.sev_def_info': 'Worth knowing; nothing is on fire',
  /* The verb the probe declared. It is the fourth question the card answers —
     what should I do — and it is the server's word, not this screen's. */
  /* THE COUNT, DRAWN. A scalar supports exactly two pictures: the count as
     itself, one mark per thing, and the count placed against the biggest
     count the same response carried. The second caption NAMES that peak,
     because a dot on a line with an unnamed end is a percentage in disguise. */
  'bento.principal.attention_dots': 'One mark for each of the {count} flagged',
  'bento.principal.attention_peak': 'Against {count}, the largest queue flagged now',
  'bento.principal.attention_peak_start': 'None',
  'bento.principal.attention_peak_end': '{count} largest now',
  'bento.principal.attention_next_label': 'Next',
  'bento.principal.attention_next': 'Next step: {action}',
  'bento.principal.attn_fees_overdue': 'Fees overdue',
  'bento.principal.attn_payments_failed': 'Failed payments',
  'bento.principal.attn_payments_bounced': 'Bounced cheques',
  'bento.principal.attn_fees_concessions': 'Concessions to approve',
  'bento.principal.attn_attendance_unmarked': 'Registers unmarked',
  'bento.principal.attn_attendance_absent': 'Absent today',
  'bento.principal.attn_attendance_corrections': 'Attendance corrections',
  'bento.principal.attn_staff_absent': 'Teachers absent',
  'bento.principal.attn_admissions_applications': 'Applications waiting',
  'bento.principal.attn_admissions_documents': 'Documents missing',
  'bento.principal.attn_admissions_followups': 'Follow-ups overdue',
  'bento.principal.attn_leave_pending': 'Leave to approve',
  'bento.principal.attn_marks_pending': 'Papers without marks',
  'bento.principal.attn_reportcards_unpublished': 'Report cards to publish',
  'bento.principal.attn_certificates_requested': 'Certificates to issue',
  'bento.principal.attn_cue_attendance': 'Attendance',
  'bento.principal.attn_cue_approvals': 'Approvals',
  'bento.principal.attn_cue_staff': 'Leave and substitutions',
  'bento.principal.attn_cue_fees': 'Fee collection',
  'bento.principal.attn_cue_payments': 'Fee dashboard',
  'bento.principal.attn_cue_admissions': 'Admissions',
  'bento.principal.attn_cue_marks': 'Results',
  'bento.principal.attn_cue_students': 'Students',

  /* The feature widgets. One per principal screen that has a real figure
     behind it; the note under each figure names the population it was counted
     out of, because a count with an unstated denominator is the fastest way to
     put a wrong number in a management meeting. */
  'bento.principal.source_failed': "Couldn't load this",
  'bento.principal.source_loading': 'Reading…',
  'bento.principal.source_pending': '—',
  'bento.principal.setup': 'Setup checklist',
  'bento.principal.cover_all_covered': 'Every period is covered.',
  'bento.principal.cover_away': '{count} away',
  'bento.principal.cover_axis_sr': 'The teaching day from {from} to {to}, with each period marked by its coverage.',
  'bento.principal.cover_day': '{count} periods today',
  'bento.principal.cover_day_one': '1 period today',
  'bento.principal.cover_for': '{subject}, {section}',
  'bento.principal.cover_h_class': 'Class',
  'bento.principal.cover_h_cover': 'Cover',
  'bento.principal.cover_h_period': 'Period',
  'bento.principal.cover_h_state': 'State',
  'bento.principal.cover_h_time': 'Time',
  'bento.principal.cover_more': 'and {count} more',
  'bento.principal.cover_more_classes': 'and {count} more classes',
  'bento.principal.cover_no_cover': 'Nobody free',
  'bento.principal.cover_none_needed': 'No cover needed today.',
  'bento.principal.cover_not_today': 'Showing {date}, not today.',
  'bento.principal.cover_nothing': 'Nothing scheduled today.',
  'bento.principal.cover_now': 'Now',
  'bento.principal.cover_of_periods': 'of {total} periods',
  'bento.principal.cover_open_count': '{count} still open',
  'bento.principal.cover_stuck_count': '{count} with nobody free',
  'bento.principal.setup_blocking_count': '{count} still blocking',
  'bento.principal.setup_dom_academic': 'Academic',
  'bento.principal.setup_dom_admin': 'Administration',
  'bento.principal.setup_dom_finance': 'Finance',
  'bento.principal.setup_dom_staff': 'Staff',
  'bento.principal.setup_dom_system': 'System',
  'bento.principal.setup_field_sr2': '{done} of {total} steps done; {blocking} still blocking.',
  'bento.principal.setup_group_sr': '{group}: {done} of {total} done.',
  'bento.principal.setup_next': 'Next: {label}',
  'bento.principal.setup_next_none': 'Nothing blocking.',
  'bento.principal.setup_optional_left': '{count} optional steps left',
  'bento.principal.setup_pct': '{pct}% set up',
  'bento.principal.setup_ready': 'Ready to run.',
  'bento.principal.setup_state_active': 'In progress',
  'bento.principal.setup_state_blocked': 'Blocked',
  'bento.principal.setup_state_done': 'Done',
  'bento.principal.setup_state_pending': 'Not started',
  'bento.principal.setup_note': '{count} still blocking',
  'bento.principal.setup_sr': 'Setup steps completed',
  'bento.principal.cue_setup': 'School setup',
  'bento.principal.shortage': 'Below 75% attendance',
  'bento.principal.shortage_note': 'Short of the board eligibility line',
  'bento.principal.cue_shortage': 'Attendance audit',
  'bento.principal.unallocated': 'Teachers with no periods',
  'bento.principal.unallocated_note': 'Of {count} on the staff roll',
  'bento.principal.unallocated_sr': 'Teachers with no timetabled periods, of all active staff',
  'bento.principal.cover': 'Periods uncovered today',
  'bento.principal.cover_note': '{covered} of {periods} covered',
  'bento.principal.cover_sr': 'Periods covered today, of the periods left by absent teachers',
  'bento.principal.cue_cover': 'Substitutions',
  'bento.principal.tt_sections': 'Sections without a timetable',
  'bento.principal.tt_sections_note': 'Of {count} sections',
  'bento.principal.tt_sections_sr': 'Sections with no timetable, of all sections',
  'bento.principal.tt_unstaffed': 'Periods with no teacher',
  'bento.principal.tt_unstaffed_note': 'Of {count} live periods a week',
  'bento.principal.tt_unstaffed_sr': 'Live periods with no teacher, of all live periods',
  'bento.principal.cue_timetable': 'Master timetable',
  'bento.principal.syllabus': 'Syllabus behind',
  'bento.principal.syllabus_note': 'Of {count} class subjects',
  'bento.principal.syllabus_sr': 'Class subjects behind on syllabus, of all class subjects',
  'bento.principal.cue_syllabus': 'Syllabus progress',
  'bento.principal.plans': 'Lesson plans to review',
  'bento.principal.plans_note': 'Submitted and waiting on a decision',
  'bento.principal.cue_plans': 'Lesson plans',
  'bento.principal.papers': 'Question papers to approve',
  'bento.principal.papers_note': 'Of {count} papers set',
  'bento.principal.cue_papers': 'Question paper approval',
  'bento.principal.moderation': 'Papers not yet moderated',
  'bento.principal.moderation_note': 'Of {count} marked papers',
  'bento.principal.moderation_sr': 'Papers moderated, of all marked papers',
  'bento.principal.cue_moderation': 'Mark moderation',
  'bento.principal.grievances': 'Grievances open',
  'bento.principal.grievances_note': 'Of {count} in the queue',
  'bento.principal.grievances_late': 'Grievances past their deadline',
  'bento.principal.grievances_late_note': 'Of {count} still open',
  'bento.principal.grievances_late_sr': 'Open grievances past their resolution deadline',
  'bento.principal.cue_grievances': 'Grievances',
  'bento.principal.calendar': 'Still to come this year',
  'bento.principal.calendar_next': 'Next: {name}, {date}',
  'bento.principal.calendar_none': 'Nothing left on the calendar',
  'bento.principal.cue_calendar': 'School calendar',
  'bento.principal.exams': 'Exams still to sit',
  'bento.principal.exams_note': 'Of {count} exams this year',
  'bento.principal.cue_exams': 'Exams',
  'bento.principal.pass_rate': 'Pass rate',
  'bento.principal.pass_rate_note': 'Across {count} results entered',
  'bento.principal.pass_rate_sr': 'Candidates passed, of candidates with marks',
  'bento.principal.cue_performance': 'Performance overview',
  'bento.principal.at_risk': 'Students at risk',
  'bento.principal.at_risk_note': 'Of {count} results entered',
  'bento.principal.cue_at_risk': 'Academic performance',
  'bento.principal.messages': 'Unread staff messages',
  'bento.principal.messages_note': 'Across {count} conversations',
  'bento.principal.cue_messages': 'Messages',
  'bento.principal.my_pay': 'My last payslip',
  'bento.principal.my_pay_note': 'Net, for month {month} of {year}',
  'bento.principal.my_pay_none': 'No payslip has been issued yet',
  'bento.principal.cue_my_pay': 'My pay',
  'bento.principal.my_leave': 'My leave left',
  'bento.principal.my_leave_note': 'Days remaining across {count} leave types',
  'bento.principal.cue_my_leave': 'Leave and self service',
  'bento.principal.classes': 'Classes',
  'bento.principal.classes_note': '{count} sections between them',

  /* THE PER-ROW DRAWINGS ON THE FLAT CELLS.

     Ten of these cells fetched a list and printed its length. Where the rows
     carried a quantity — days waited, a percent, a status, a date, an unread
     count — it is bucketed and drawn, and every label below names a bucket of
     rows that really arrived. Band labels are held short: they sit in a 38px
     column beside their own bar at one column of width. */
  'bento.principal.band_lt50': 'Under 50',
  'bento.principal.band_50': '50–59',
  'bento.principal.band_60': '60–64',
  'bento.principal.band_65': '65–69',
  'bento.principal.band_70': '70–75',
  'bento.principal.shortage_bands_sr': 'Students short of the line, counted by how far below it they are',
  'bento.principal.fact_lowest': 'Lowest',
  'bento.principal.fact_under_60': 'Under 60%',
  'bento.principal.band_none': 'None',
  'bento.principal.band_1_10': '1–10',
  'bento.principal.band_11_20': '11–20',
  'bento.principal.band_21_30': '21–30',
  'bento.principal.band_31_up': '31+',
  'bento.principal.workload_bands_sr': 'Teaching staff counted by periods timetabled a week',
  'bento.principal.tt_sections_grid_sr':
    'One mark per section: {count} of {total} have no timetable',
  'bento.principal.band_no_teacher': 'No one',
  'bento.principal.band_staffed': 'Staffed',
  'bento.principal.tt_unstaffed_split_sr': 'Live periods a week, with a teacher and without',
  'bento.principal.band_today': 'Today',
  'bento.principal.band_1_2d': '1–2d',
  'bento.principal.band_3_7d': '3–7d',
  'bento.principal.band_8_14d': '8–14d',
  'bento.principal.band_15d_up': '15d+',
  'bento.principal.plans_bands_sr': 'Lesson plans waiting, counted by how long they have waited',
  'bento.principal.days_short': '{count}d',
  'bento.principal.fact_longest_wait': 'Longest wait',
  'bento.principal.fact_over_a_week': 'Over a week',
  'bento.principal.band_submitted': 'Waiting',
  'bento.principal.band_changes': 'Changes',
  'bento.principal.band_draft': 'Draft',
  'bento.principal.band_approved': 'Approved',
  'bento.principal.papers_status_sr': 'Question papers counted by the status each one is in',
  'bento.principal.fact_changes_needed': 'Changes asked',
  'bento.principal.fact_approved': 'Approved',
  'bento.principal.calendar_density_sr':
    'The next thirty days; {count} of them have something on the calendar',
  'bento.principal.fact_days_away': 'Days away',
  'bento.principal.fact_in_30_days': 'In 30 days',
  'bento.principal.band_ahead': 'Ahead',
  'bento.principal.band_sat': 'Sat',
  'bento.principal.band_undated': 'No date',
  'bento.principal.exams_split_sr': 'Exams still to sit, already sat, and with no date set',
  'bento.principal.fact_published': 'Published',
  'bento.principal.fact_undated': 'No date',
  'bento.principal.messages_spread_sr':
    'Unread messages in each of the {count} conversations with something waiting, busiest first',
  'bento.principal.fact_busiest': 'Busiest',
  'bento.principal.fact_with_unread': 'Conversations',
  'bento.principal.fact_sections_each': 'Sections each',
  'bento.principal.cue_classes': 'Class setup',

  /* THE TEN CARD CELLS. Header, figure and drawing — the subs are the eyebrow
     under the title, the changes are the line under the figure, and every
     `_sr` is what a screen reader is told the drawing shows. A sentence that
     states a share names the total it was taken from, because on this board
     there is no proportion without one. */
  'bento.principal.syllabus_sub': 'Delivered against the calendar',
  'bento.principal.syllabus_change':
    'Of {total} class subjects · {lag} points behind · {short} of {units} units to teach',
  'bento.principal.syllabus_level': 'Level with the calendar · {delivered} of {units} units taught',
  'bento.principal.syllabus_dist_sr':
    'How delivered coverage is spread across {count} class subjects, 0 to 100 percent of each one’s own units',
  'bento.principal.syllabus_lag_sr':
    'The {count} class subjects with the least delivered, each as a percent of its own units',
  'bento.principal.moderation_sub': 'Paper averages',
  'bento.principal.moderation_change':
    '{reviewed} of {total} papers moderated · {papers} carry an average',
  'bento.principal.moderation_dist_sr':
    'How the averages of {count} papers are spread, 0 to 100 percent',
  'bento.principal.moderation_low_sr': 'The {count} papers with the lowest average, in percent',
  'bento.principal.pass_rate_sub': 'Candidates passed',
  'bento.principal.pass_rate_change': '{passed} of {total} candidates with marks',
  'bento.principal.pass_rate_none': 'No results entered yet',
  'bento.principal.pass_rate_gauge_sr': 'Candidates passed, of {total} candidates with marks',
  'bento.principal.pass_rate_dist_sr': 'How pass rates are spread across {count} papers',
  'bento.principal.pass_rate_low_sr': 'The {count} papers with the lowest pass rate',
  'bento.principal.at_risk_sub': 'Below pass, paper by paper',
  'bento.principal.at_risk_change': 'Of {total} candidates, counted by the summary and not the list',
  'bento.principal.at_risk_gauge_sr': 'Students at risk, of {total} candidates with marks',
  'bento.principal.at_risk_dist_sr': 'Candidates below the pass mark in each of {count} papers',
  'bento.principal.at_risk_low_sr': 'The {count} papers with the most candidates below pass',
  'bento.principal.setup_sub': 'Fifteen steps',
  'bento.principal.setup_density_sr':
    '{total} setup steps: {done} done, {left} still to do, brightest where a step is complete',
  'bento.principal.setup_gauge_sr': 'Setup steps done, of {total}',
  'bento.principal.setup_rows_left_sr': 'Steps still to do, by area of the school',
  'bento.principal.setup_rows_done_sr': 'Steps done, by area of the school',
  'bento.principal.cover_sub': 'Periods left by absences',
  'bento.principal.cover_change': '{covered} of {periods} covered · {away} away today',
  'bento.principal.cover_states_sr':
    '{covered} periods covered, {open} still open, {stuck} with nobody free',
  'bento.principal.cover_day_sr': 'Periods across the day, {from} to {to}, on {date}',
  'bento.principal.cover_class_sr': 'Uncovered periods by class',
  'bento.principal.grievances_sub': 'Age of the queue',
  'bento.principal.grievances_change': 'Of {count} tickets fetched · oldest {oldest} days',
  'bento.principal.grievances_capped':
    'The queue is cut at {count} tickets — what is drawn is the oldest {count}, not the whole of it',
  'bento.principal.grievances_none': 'Nothing open',
  'bento.principal.grievances_days_sr':
    'How long {count} open tickets have been open, none to {oldest} days',
  'bento.principal.grievances_cat_rows_sr': 'Open tickets by category',
  'bento.principal.grievances_dept_rows_sr': 'Open tickets by department',
  'bento.principal.grv_late_sub': 'Past the resolution deadline',
  'bento.principal.grv_late_change': 'Of {count} tickets still open',
  'bento.principal.grv_late_capped':
    'Of {open} open in the oldest {count} fetched — the queue is cut there',
  'bento.principal.grv_late_compare_sr': '{late} tickets past deadline, of {open} open',
  'bento.principal.grv_late_hours_sr':
    'How far past deadline {count} tickets are, none to {worst} hours',
  'bento.principal.grv_late_dept_rows_sr': 'Tickets past deadline, by department',
  'bento.principal.my_leave_sub': 'Days left of what was granted',
  'bento.principal.my_leave_change': 'Of {entitled} days granted across {types} types',
  'bento.principal.my_leave_none': 'No leave entitlement on record',
  'bento.principal.my_leave_left': 'Left',
  'bento.principal.my_leave_taken': 'Taken',
  'bento.principal.my_leave_compare_sr': 'Days left against days taken, of {entitled} granted',
  'bento.principal.my_leave_rows_sr': 'Days left in each of {count} leave types',
  'bento.principal.my_pay_sub': 'Net pay',
  'bento.principal.my_pay_change': '{month}/{year} · gross {gross}',
  'bento.principal.my_pay_gross': 'Gross',
  'bento.principal.my_pay_line_sr': 'Net pay across the last {count} months',
  'bento.principal.my_pay_stack_sr':
    'Gross pay across {count} months, each month split into what was paid and what was withheld',

  /* THE SIZE-AWARE FEATURE CELLS.

     Every string below is a screen-reader label for a drawing, a bucket label
     on an axis, or a sentence that says what a drawing was cut to. The bucket
     labels are held to six characters because they are printed under the bars
     and a longer one collides with its neighbour at one column. */
  'bento.principal.strip_capped': 'First {shown} of {total} shown',
  'bento.principal.other_slice': 'Other',
  'bento.principal.no_department': 'No department',
  'bento.principal.syllabus_strip_sr':
    'Syllabus completion for {count} class subjects, each drawn as one cell, darker where less has been delivered',
  'bento.principal.syllabus_bands_sr':
    'Class subjects by how much of the syllabus has been delivered, in quarters',
  'bento.principal.moderation_bands_sr': 'Marked papers by average mark, in quarters',
  'bento.principal.moderation_quadrant_sr':
    'Each marked paper placed by its average mark and how many candidates failed it',
  'bento.principal.moderation_x': 'average mark',
  'bento.principal.moderation_y': 'failures',

  /* SYLLABUS — the distance cell.

     "Expected" is how far through the June-April academic year today is, which
     is the same measure `internal/api/syllabus.go` decides `behind` by. It is
     named in every sentence that uses it, because a marker on a rail that
     nobody explained is a marker nobody trusts. */
  'bento.principal.syllabus_behind_of': 'behind, of {total}',
  'bento.principal.syllabus_on_track': 'none behind',
  'bento.principal.syllabus_points_behind': 'points behind the calendar',
  'bento.principal.syllabus_legend': 'Expected {expected}% by today · delivered {actual}%',
  'bento.principal.syllabus_units_short': '{units} of {total} units short of the calendar',
  'bento.principal.syllabus_contributors': '{subjects} subjects across {classes} classes',
  'bento.principal.syllabus_last_taught': 'Days since last taught',
  'bento.principal.syllabus_never': '{count} never taught',
  'bento.principal.syllabus_ranking': 'Furthest behind',
  'bento.principal.syllabus_ranked': 'The {shown} furthest behind, of {total}',
  'bento.principal.syllabus_matrix': 'Subject × class, filled by how far short',
  'bento.principal.syllabus_matrix_note':
    '{subjects} of {allSubjects} subjects × {classes} of {allClasses} classes, worst first',
  'bento.principal.syllabus_worst_subject': 'Largest lag: {subject}, {points} points',
  'bento.principal.syllabus_no_history': 'No coverage history on the wire, so no trend is drawn',
  'bento.principal.syllabus_empty': 'No class subject has a syllabus loaded yet',
  'bento.principal.syllabus_gap_sr':
    'Syllabus delivered {actual} percent against {expected} percent expected by today',
  'bento.principal.syllabus_row_sr':
    '{label}: {actual} percent delivered against {expected} percent expected by today',
  'bento.principal.syllabus_stale_sr':
    'Class subjects by how many days since a unit was last delivered',
  'bento.principal.syllabus_matrix_sr':
    '{subjects} subjects by {classes} classes, each square filled by how far short of {expected} percent that pairing is',

  /* MODERATION — the distribution cell.

     One dot is one PAPER, at its average. `/exams/moderation` counts in the
     database and returns per-paper aggregates, so there are no per-student
     marks to draw and none are implied: every sentence below says paper. */
  'bento.principal.moderation_reviewed': '{pct}% reviewed',
  'bento.principal.moderation_stats': 'Mean {mean}% · median {median}% · pass {pass}',
  'bento.principal.moderation_legend': 'Filled: still to moderate · hollow: moderated · one dot, one paper',
  'bento.principal.moderation_below_pass': '{pct}% of {entered} candidates below pass',
  'bento.principal.moderation_outliers':
    '{count} of {total} papers outside the 1.5 IQR fence · furthest {worst} at {value}%',
  'bento.principal.moderation_no_outliers': 'No paper outside the 1.5 IQR fence',
  'bento.principal.moderation_spread': 'Spread within a paper: {median} points typical, {narrowest} narrowest ({paper})',
  'bento.principal.moderation_deviation': 'Furthest from the median: {paper}, {points} points',
  'bento.principal.moderation_subjects': 'By subject: lowest to highest, mean marked',
  'bento.principal.moderation_subjects_capped': 'Top {shown} of {total} subjects',
  'bento.principal.moderation_no_average': '{count} papers carry no average yet and are not plotted',
  'bento.principal.moderation_no_marks': 'No paper carries an average yet',
  'bento.principal.moderation_per_paper': 'Per paper, not per student: the endpoint aggregates',
  'bento.principal.moderation_empty': 'No paper has been marked yet',
  'bento.principal.moderation_shape_normal': 'Spread looks normal',
  'bento.principal.moderation_shape_compressed': 'Marks look compressed',
  'bento.principal.moderation_shape_inflated': 'Marks look inflated',
  'bento.principal.moderation_shape_anomalous': 'A paper is out of line',
  'bento.principal.moderation_field_sr':
    '{count} papers placed by their average mark out of 100, mean {mean} percent, median {median} percent',
  'bento.principal.moderation_subject_sr':
    '{subject}: {papers} papers, marks from {lo} to {hi} percent, mean {mean} percent',
  'bento.principal.pass_rate_strip_sr':
    'Pass rate for {count} papers, each drawn as one cell, darker where fewer passed',
  'bento.principal.pass_rate_bands_sr': 'Papers by pass rate, in quarters',
  'bento.principal.at_risk_sr': 'Candidates carrying a backlog, of all candidates',
  'bento.principal.at_risk_strip_sr':
    'Candidates below the pass mark in each of {count} papers, one cell per paper',
  'bento.principal.at_risk_bands_sr': 'Papers by average mark, in quarters',
  'bento.principal.grievances_cat_sr': 'Open grievances by what they are about',
  'bento.principal.grievances_age_sr': 'Open grievances by how many days they have been open',
  'bento.principal.grievances_dept_sr': 'Open grievances by department and category: {pairs}',
  'bento.principal.grievances_late_age_sr':
    'Overdue grievances by how many days they have been open',
  'bento.principal.grievances_late_dept_sr': 'Overdue grievances by the department holding them',

  /* THE TWO GRIEVANCE CELLS. One queue read two ways — how old the open
     cases are, and how far past their promised date the late ones are — so
     the wording is shared where the reading is shared. Every band label is
     held to six characters: `AgeBands` prints them in an 11px gutter at one
     column, and a seventh character collides with the rail beside it. */
  'bento.principal.grv_new_today': '{count} new today',
  'bento.principal.grv_days': '{count}d',
  'bento.principal.grv_all': 'all',
  'bento.principal.grv_none_open': 'Nothing open in the queue',
  'bento.principal.grv_none_late': 'Nothing past its deadline',
  'bento.principal.grv_median_oldest': 'Median {median}d open, oldest {oldest}d',
  'bento.principal.grv_median_mark': 'median {count}d',
  'bento.principal.grv_due_soon_line': '{count} due within 2 days',
  'bento.principal.grv_stat_median': 'median age',
  'bento.principal.grv_stat_oldest': 'oldest',
  'bento.principal.grv_stat_due_soon': 'due in 2d',
  'bento.principal.grv_stat_escalated': 'escalated',
  'bento.principal.grv_stat_median_late': 'median late',
  'bento.principal.grv_stat_oldest_late': 'oldest late',
  'bento.principal.grv_stat_severe': 'over 14d',
  'bento.principal.grv_state_open': 'Untouched',
  'bento.principal.grv_state_active': 'In progress',
  'bento.principal.grv_state_waiting': 'Waiting',
  'bento.principal.grv_state_sr': 'Open grievances by what state they are in',
  'bento.principal.grv_age_field_sr':
    '{count} open grievances by age, none to {oldest} days; median {median} days',
  'bento.principal.grv_dept_age_sr': 'Open grievances by department and days open',
  'bento.principal.grv_late_dept_age_sr': 'Overdue grievances by department and days past deadline',
  'bento.principal.grv_late_bands_sr': 'Overdue grievances by days past their deadline',
  'bento.principal.grv_late_cat_sr': 'Overdue grievances by what they are about',
  'bento.principal.grv_late_summary': 'Oldest {oldest}d past deadline, {severe} beyond 14d',
  'bento.principal.grv_rail_sr':
    '{late} of {total} open grievances with a stamped deadline are past it',
  'bento.principal.grv_of_stamped': '{late} of {total} with a deadline',
  'bento.principal.grv_no_deadline': '{count} open with no deadline stamped',
  'bento.principal.grv_no_deadline_any': 'No open case carries a stamped deadline',
  'bento.principal.grv_boundary_sr':
    'Open grievances against their deadline: {late} of {total} past it',
  'bento.principal.grv_in_time': 'In time',
  'bento.principal.grv_past_due': 'Past due',
  'bento.principal.grv_deadline': 'due',
  'bento.principal.grv_sev_clear': 'All in time',
  'bento.principal.grv_sev_watch': 'Watch',
  'bento.principal.grv_sev_serious': 'Serious',
  'bento.principal.grv_sev_critical': 'Critical',
  /* The server's LIMIT 300. Said on the card rather than in a comment: a
     count drawn from a capped page is not the size of the queue, and a
     dashboard that prints it as though it were is wrong on the one number
     the cell exists to give. */
  'bento.principal.grv_capped': 'First {count} of the queue — there may be more',
  'bento.principal.grv_capped_short': 'First {count} only',
  'bento.principal.my_leave_sr': 'Leave days remaining, of the days entitled',
  'bento.principal.my_leave_type_sr': 'Days of {type} remaining, of the days entitled',
  'bento.principal.my_pay_trend_sr': 'Net pay over the last {count} payslips',
  'bento.principal.my_pay_split_sr': 'Gross pay of {gross}, of which {deduction} was deducted',
  'bento.principal.my_pay_net': 'Paid',
  'bento.principal.my_pay_deducted': 'Deducted',
  'bento.principal.my_pay_gross_note': '{gross} gross for month {month} of {year}',
  'bento.principal.setup_blocking': 'blocking',
  'bento.principal.setup_field_sr': 'Done: {done}. Still to do: {todo}.',
  'bento.principal.cover_covered': 'Covered',
  'bento.principal.cover_open': 'Not covered',
  'bento.principal.cover_stuck': 'Nobody free',
  'bento.principal.cover_split_sr':
    'Periods left by absent teachers, split into covered, not yet covered, and those with nobody free to take them',
  'bento.principal.cover_field_sr':
    "Today's {count} uncovered periods in order, each marked covered or not",
  'bento.principal.cover_timeline_sr': 'When in the day the {count} uncovered periods fall',

  // --- bento: the finance dashboard ---------------------------------------
  // The Bento rendering of finance.home.finance_kpis. The ageing bands are
  // summed in the browser from the overdue invoice list the classic screen
  // already fetches — no second endpoint, and no figure the classic screen
  // does not also show.
  'bento.finance.eyebrow': 'Home',
  'bento.finance.title': 'Finance overview',
  'bento.finance.loading': 'Counting what has come in…',
  'bento.finance.failed': 'That did not load. Nothing here is a figure you can rely on until it does.',

  // The anchor. The label is the widget's name in the board's own chrome, so
  // it is short; the range is named on the card itself, where there is room
  // to say which period the figure belongs to.
  'bento.finance.anchor_label': 'Collected',
  'bento.finance.collected_in': 'Collected in {label}',

  // The one decomposition on this page that cannot be argued with:
  // outstanding is exactly its not-yet-due part plus its overdue part, both
  // the same sum over the same rows at the same instant.
  'bento.finance.decomp_sr': 'Everything still owed, split into what is not yet due and what is overdue',
  'bento.finance.not_yet_due': 'Not yet due',
  'bento.finance.overdue': 'Overdue',
  'bento.finance.outstanding_split': '{outstanding} still owed · {pct}% of it overdue',
  'bento.finance.overdue_sr': 'Share of outstanding that is overdue',

  // THERE IS NO TARGET. Said on the card rather than left as an absence a
  // future reader fills in with an invented denominator — which is exactly
  // what happened here once already.
  'bento.finance.no_target': 'No billed total and no collection target is recorded anywhere in this data, so no progress against one is shown.',
  'bento.finance.no_daily_series': 'No day-by-day series is recorded for the period, so no daily distribution is drawn.',

  // Ageing, from the due date on each overdue invoice.
  'bento.finance.ageing': 'Overdue, by age',
  'bento.finance.ageing_sr': 'Overdue money and invoice counts, by how far past the due date each invoice is',
  'bento.finance.ageing_loading': 'Ageing the overdue invoices…',
  'bento.finance.ageing_failed': 'The overdue invoices did not load, so the ageing is unknown — not zero.',
  'bento.finance.ageing_none': 'Nothing overdue.',
  'bento.finance.ageing_count': 'Across {count} overdue invoices, with their counts at the right.',
  'bento.finance.ageing_capped': 'The server returns the 300 most recent overdue invoices, so these cover {covered} of the {total} overdue.',
  'bento.finance.age_1': '1–30d',
  'bento.finance.age_2': '31–60d',
  'bento.finance.age_3': '61–90d',
  'bento.finance.age_4': '90d+',
  'bento.finance.oldest_overdue': 'Oldest is {days} days past due.',
  'bento.finance.worst_two': 'Oldest {days} days past due; largest single invoice {amount} ({who}).',

  // Collected today.
  'bento.finance.today': 'Collected today',
  'bento.finance.today_part': 'Today',
  'bento.finance.period_part': 'Earlier in the period',
  'bento.finance.today_sr': 'Collected today as a share of {label}',
  'bento.finance.today_of_period': 'Of {amount} collected in {label}.',
  'bento.finance.today_day_of': 'Day {day} of {span} in the selected period.',
  'bento.finance.today_position': 'Day {day} of {span} in {label}',
  'bento.finance.today_outside': '{label} does not include today, so today is not part of that total and no comparison with it is drawn.',
  'bento.finance.per_day': '{amount} a day on average across {label} so far',
  'bento.finance.period_track_sr': 'Where today sits in {label}, which runs from {from} to {to}',

  // Outstanding.
  'bento.finance.outstanding': 'Outstanding',
  'bento.finance.overdue_note': '{amount} of it overdue.',
  'bento.finance.overdue_note_loading': '{amount} of it overdue. Ageing the invoices…',
  'bento.finance.overdue_ageing_failed': '{amount} of it overdue. The invoice list did not load, so the ageing is unknown — not zero.',
  'bento.finance.concentration': 'The largest {n} carry {pct}% of the {listed} listed.',
  'bento.finance.ranked_title': 'Largest {n} of {total} listed',
  'bento.finance.ranked_sr': 'The {n} largest overdue invoices, largest first, each with what is still due on it and how far past due it is',
  'bento.finance.ranked_of': 'The field is the largest {shown} of {total}.',

  'bento.finance.defaulters': 'Defaulters',
  'bento.finance.defaulters_note': 'Students past a due date',
  'bento.finance.unreconciled': 'Unreconciled',
  'bento.finance.unreconciled_note': 'Gateway payments not yet tied to a settlement',
  'bento.finance.refunds': 'Refunds pending',
  'bento.finance.refunds_note': 'Waiting to be paid out',
  'bento.finance.invoices': 'Invoices',
  'bento.finance.invoices_note': 'Raised, all time',
  'bento.finance.cue_overdue': 'Defaulters and reminders',
  'bento.finance.cue_collect': 'Collect a payment',
  'bento.finance.cue_ledger': 'Student ledger',
  'bento.finance.cue_defaulters': 'Defaulters and reminders',
  'bento.finance.cue_reconcile': 'Reconciliation',
  'bento.finance.cue_refunds': 'Refunds',
  'bento.finance.cue_invoices': 'Invoices',
  // --- the card language ---------------------------------------------------
  // Headers, captions and the sentences that say where a figure came from.
  // Every one of these is printed on a card whose drawing is one of the twelve
  // in bento-cards.tsx; none of them describes a share the handler cannot
  // support.
  'bento.finance.as_of_today': 'As of today',
  'bento.finance.all_time': 'All time',
  'bento.finance.no_target_sub': 'No billed total is recorded',
  'bento.finance.per_day_short': 'Per day',
  'bento.finance.today_rows_sr':
    'Collected today, the mean per elapsed day, and the total for {label} — all three in rupees.',
  'bento.finance.today_day_none': '{label} does not include today.',
  // The four open-item counts. One dot per item, and the caption says so —
  // there is no population on this response to put any of them over.
  'bento.finance.count_none': 'Nothing open.',
  'bento.finance.dots_each': 'One dot each',
  'bento.finance.dots_capped': 'One dot each, first {shown} of {total}',
  'bento.finance.dots_sr': '{shown} of {total} {thing}, one dot each.',
  'bento.finance.no_share': 'No total is recorded for this count, so it is drawn as a count and not as a share.',

  // --- bento: the three daily personas ------------------------------------
  // The student, parent and faculty landing screens in the Bento layout.
  // `bento.common.*` is shared by all three; the rest is per screen, keyed
  // area.screen.slot with the screen named after the file.
  'bento.common.roll': 'Roll {roll}',

  // The student's own day. Their scope is one record, so nothing here has to
  // say whose day it is — it can only be theirs.
  'bento.student_day.eyebrow': 'Home',
  'bento.student_day.loading': 'Reading your day…',
  'bento.student_day.failed':
    'That did not load. Nothing here is a figure you can rely on until it does.',
  'bento.student_day.now_label': 'On now',
  'bento.student_day.next_label': 'Next lesson',
  'bento.student_day.now_cue': 'Your whole timetable',
  'bento.student_day.until': '{period} · until {ends}',
  'bento.student_day.starts': '{period} · starts {at}',
  'bento.student_day.then': 'Then {subject} at {at}',
  'bento.student_day.last_lesson': 'Last lesson of the day.',
  'bento.student_day.not_started': 'The day has not started yet.',
  'bento.student_day.finished': 'Day over',
  'bento.student_day.finished_note': 'All {count} lessons are done.',
  'bento.student_day.no_lessons': 'No lessons',
  'bento.student_day.no_lessons_note': 'Nothing is timetabled for you today.',
  'bento.student_day.strip_sr': 'Your {count} lessons today, in order.',
  'bento.student_day.dot_now': 'on now',
  'bento.student_day.dot_done': 'finished',
  'bento.student_day.dot_later': 'still to come',
  'bento.student_day.attendance': 'Attendance',
  'bento.student_day.attendance_cue': 'Your register',
  'bento.student_day.attendance_note': '{present} of {total} days',
  'bento.student_day.homework': 'Homework due',
  'bento.student_day.homework_cue': 'What has been set',
  'bento.student_day.homework_none': 'Nothing owed.',
  'bento.student_day.homework_today': 'The soonest is due today.',
  'bento.student_day.homework_days': 'The soonest is due in {days} days.',
  'bento.student_day.homework_overdue': 'The soonest is {days} days overdue.',
  'bento.student_day.fees': 'Fees outstanding',
  'bento.student_day.fees_cue': 'Fees and receipts',
  'bento.student_day.fees_owed': 'Still payable.',
  'bento.student_day.fees_settled': 'Nothing owed.',
  'bento.student_day.absent': 'Days absent',
  'bento.student_day.absent_cue': 'Your register',
  'bento.student_day.absent_note': 'Out of {total} marked days',
  'bento.student_day.absent_sr': 'Present on {present} of {total} marked days',

  // The parent's dashboard. EVERY string that describes a figure names the
  // child, because a guardian of two must never read one child's figures as
  // the family's. Translators: keep the name in the sentence.
  'bento.parent_week.eyebrow': 'Home',
  'bento.parent_week.title': 'Your children',
  'bento.parent_week.loading': 'Finding your children…',
  'bento.parent_week.loading_child': 'Reading {name}’s week…',
  'bento.parent_week.failed_children':
    'We could not read who your children are, so nothing below could be said to be about any of them.',
  'bento.parent_week.failed_child':
    '{name}’s week did not load. Nothing here is a figure you can rely on until it does.',
  'bento.parent_week.no_link': 'No student record is linked to this account yet.',
  'bento.parent_week.switcher_sr': 'Which child this dashboard is about',
  'bento.parent_week.one_of_many': '{name} · {form} — one of your {count} children',
  'bento.parent_week.week_label': 'Attendance this year',
  'bento.parent_week.week_cue': 'The full register',
  'bento.parent_week.week_note': '{name} was present {present} of {total} marked days',
  'bento.parent_week.strip_sr': '{name}’s last {count} marked days',
  'bento.parent_week.no_register': 'No days have been marked for {name} yet.',
  'bento.parent_week.fees_label': 'Fees outstanding',
  'bento.parent_week.fees_cue': 'Fees and payments',
  'bento.parent_week.fees_owed': 'Payable on {name}’s account.',
  'bento.parent_week.fees_settled': 'Nothing owed on {name}’s account.',
  'bento.parent_week.homework_label': 'Homework due',
  'bento.parent_week.homework_cue': 'What has been set',
  'bento.parent_week.homework_none': 'Nothing owed by {name}.',
  'bento.parent_week.homework_today': 'The soonest is due today.',
  'bento.parent_week.homework_days': 'The soonest is due in {days} days.',
  'bento.parent_week.homework_overdue': 'The soonest is {days} days overdue.',
  'bento.parent_week.absent_label': 'Days absent',
  'bento.parent_week.absent_cue': 'The full register',
  'bento.parent_week.absent_note': '{name}, out of {total} marked days',
  'bento.parent_week.absent_sr': '{name} was present on {present} of {total} marked days',
  'bento.parent_week.present_label': 'Days present',
  'bento.parent_week.present_note': 'Days {name} was in school',

  // The teacher's day. Scoped by the server to the sections they teach.
  'bento.faculty_today.eyebrow': 'Home',
  'bento.faculty_today.title': 'Today’s classes',
  'bento.faculty_today.description': '{count} lessons on your timetable today.',
  'bento.faculty_today.loading': 'Reading your day…',
  'bento.faculty_today.failed':
    'That did not load. Nothing here is a figure you can rely on until it does.',
  'bento.faculty_today.now_label': 'Teaching now',
  'bento.faculty_today.next_label': 'Next lesson',
  'bento.faculty_today.now_cue': 'Take the register',
  'bento.faculty_today.until': '{period} · until {ends}',
  'bento.faculty_today.starts': '{period} · starts {at}',
  'bento.faculty_today.register_in': 'The register for this lesson is in.',
  'bento.faculty_today.register_out': 'The register for this lesson is not in yet.',
  'bento.faculty_today.finished': 'Day over',
  'bento.faculty_today.finished_note': '{marked} of {count} registers are in.',
  'bento.faculty_today.no_lessons': 'No lessons',
  'bento.faculty_today.no_lessons_note': 'Nothing is timetabled for you today.',
  'bento.faculty_today.strip_sr': 'Your lessons today: {marked} of {count} registers are in.',
  'bento.faculty_today.dot_marked': 'register in',
  'bento.faculty_today.dot_unmarked': 'register not in',
  'bento.faculty_today.marked_label': 'Registers in',
  'bento.faculty_today.marked_cue': 'Take the register',
  'bento.faculty_today.marked_all': 'Every register today is in.',
  'bento.faculty_today.marked_left': '{count} still to mark.',
  'bento.faculty_today.marked_sr': '{marked} of {count} registers are in',
  'bento.faculty_today.work_label': 'Outstanding on you',
  'bento.faculty_today.work_cue': 'My work',
  'bento.faculty_today.work_none': 'Nothing is waiting on you.',
  'bento.faculty_today.work_some': 'Nothing late yet.',
  'bento.faculty_today.work_overdue': '{count} of it overdue.',
  'bento.faculty_today.sections_label': 'Sections you teach',
  'bento.faculty_today.sections_cue': 'My classes',
  'bento.faculty_today.sections_note': '{count} pupils between them',
  'bento.faculty_today.lessons_label': 'Lessons today',
  'bento.faculty_today.lessons_cue': 'My timetable',
  'bento.faculty_today.lessons_none': 'Nothing timetabled.',
  'bento.faculty_today.lessons_note': '{first} to {last}',
  'bento.escape.back': 'Sidebar layout',
  'bento.launcher.title': 'All features',
  'bento.launcher.close': 'Close',
  'bento.launcher.recent': 'Recently opened',
  'bento.launcher.show_all': 'Show all',
  'bento.launcher.results': '{count} matches',
  'bento.launcher.empty': 'Nothing matches “{q}”',
  'bento.launcher.hint': 'Up and down to move, Enter to open, Esc to close',
  'bento.launcher.filter': 'Filter {count} features…',
  'bento.dock.all': 'All features',
  'bento.dock.work': 'Work',
  'bento.dock.apps': 'Apps',
  'bento.settings.label': 'Settings',
  'bento.settings.appearance': 'Appearance',
  'bento.settings.signout': 'Sign out',
  'bento.settings.frame': 'Frame',
  'bento.settings.density': 'Density',
  'bento.settings.density.compact': 'Compact',
  'bento.settings.density.comfortable': 'Comfortable',
  'bento.settings.density.relaxed': 'Relaxed',
  'bento.settings.corners': 'Corners',
  'bento.settings.corners.sharp': 'Sharp',
  'bento.settings.corners.default': 'Default',
  'bento.settings.corners.round': 'Round',
  'bento.settings.text': 'Text size',
  'bento.settings.text.default': 'Default',
  'bento.settings.text.small': 'Small',
  'bento.settings.typeface': 'Typeface',
  'bento.appearance.title': 'Appearance',
  'bento.widgets.edit': 'Arrange',
  'bento.widgets.done': 'Done',
  'bento.widgets.add': 'Add:',
  'bento.widgets.full': 'The board is full — remove a card to make room.',
  'bento.widgets.reset': 'Reset layout',
  'bento.widgets.remove': 'Remove',
  'bento.widgets.hint': 'Drag to reorder · set width and height on each card',
  'bento.widgets.colour': 'C',
  'bento.widgets.colour_clear': 'Default',
  'bento.widgets.colour_hex': 'Hex colour code',
  'bento.widgets.colour_lightness': 'Lightness',
  'bento.widgets.colour_default': 'Default colour',
  'bento.widgets.wont_fit': 'Any bigger and the cards get too small to read',
  'bento.widgets.preset.default': 'As designed',
  'bento.widgets.preset.compact': 'Compact',
  'bento.widgets.preset.spotlight': 'Spotlight',
  'bento.widgets.preset.even': 'Even',
  'bento.widgets.undo': 'Undo',
  'bento.widgets.tidy': 'Tidy up',
  'bento.widgets.order': 'O',
  'bento.widgets.move_back': 'Move earlier',
  'bento.widgets.move_on': 'Move later',
  'bento.widgets.width': 'W',
  'bento.widgets.height': 'H',
  'bento.widgets.size.small': 'S',
  'bento.widgets.size.tall': 'Tall',
  'bento.widgets.size.medium': 'M',
  'bento.widgets.size.large': 'L',
  'bento.widgets.size.full': 'Full',
  'bento.colour.title': 'Colour settings',
  'bento.colour.channel.bg': 'Background',
  'bento.colour.channel.text': 'Text',
  'bento.colour.channel.accent': 'Accent',
  'bento.colour.accent_note': 'One colour for buttons, links and selected states, across every surface.',
  'bento.colour.wheel_hint': 'Click the wheel to choose a colour',
  'bento.colour.lightness': 'Lightness',
  'bento.colour.preview': 'Preview',
  'bento.colour.select_element': 'Select element',
  'bento.colour.pick_on_page': 'Pick on page',
  'bento.colour.region.workarea': 'Work area',
  'bento.colour.region.topbar': 'Top bar',
  'bento.colour.region.sidebar': 'Side bar',
  'bento.colour.region.bottombar': 'Bottom bar',
  'bento.colour.region.dock': 'Dock',
  'bento.colour.region.cards': 'Cards',
  'bento.colour.region.students': 'Students',
  'bento.colour.region.academics': 'Academics',
  'bento.colour.region.finance': 'Finance',
  'bento.colour.region.operations': 'Operations',
  'bento.colour.region.reports': 'Reports',
  'bento.colour.mode.light': 'For light mode',
  'bento.colour.mode.dark': 'For dark mode',
  'bento.colour.saved': 'Saved palettes',
  'bento.colour.name_placeholder': 'Name this scheme',
  'bento.colour.save': 'Save',
  'bento.colour.forget': 'Forget',
  'bento.colour.reset': 'Reset',
  'bento.colour.done': 'Done',
  'bento.appearance.subtitle': 'Applies everywhere, and is remembered on this device.',
  'bento.appearance.font_note': 'Using {name}. Faces other than Inter are fetched when first chosen, and fall back to the system font if the device is offline.',
  'bento.settings.appearance_dialog': 'Typeface & density',
  'bento.settings.colour_dialog': 'Colour settings',
  'bento.settings.typeface.inter': 'Inter',
  'bento.settings.typeface.system': 'System',
  'bento.settings.typeface.grotesk': 'Grotesk',
  'bento.settings.typeface.serif': 'Serif',
  'bento.settings.borders': 'Borders',
  'bento.settings.borders.none': 'None',
  'bento.settings.borders.hairline': 'Hairline',
  'bento.settings.borders.strong': 'Strong',
  'bento.settings.shadow': 'Shadow',
  'bento.settings.shadow.flat': 'Flat',
  'bento.settings.shadow.default': 'Default',
  'bento.settings.shadow.lifted': 'Lifted',
  'bento.settings.shadow.deep': 'Deep',
  'bento.settings.pattern': 'Background',
  'bento.settings.pattern.none': 'Plain',
  'bento.settings.pattern.dots': 'Dots',
  'bento.settings.pattern.grid': 'Grid',
  'bento.settings.pattern.lines': 'Lines',
  'bento.settings.pattern.noise': 'Noise',
  'bento.settings.contrast': 'Contrast',
  'bento.settings.contrast.normal': 'Normal',
  'bento.settings.contrast.medium': 'Medium',
  'bento.settings.contrast.high': 'High',
  'bento.settings.accent': 'Accent',
  'bento.settings.accent.blue': 'Blue',
  'bento.settings.accent.mint': 'Mint',
  'bento.settings.accent.violet': 'Violet',
  'bento.settings.accent.amber': 'Amber',
  'bento.settings.accent.rose': 'Rose',
  'bento.settings.fullscreen': 'Full screen',
  'bento.settings.fullscreen.exit': 'Leave full screen',
  'bento.settings.reset': 'Reset appearance',
  'bento.settings.text.large': 'Large',
  'bento.settings.text.larger': 'Larger',
  'bento.settings.layout': 'Layout',
  'bento.settings.layout.classic': 'Sidebar',
  'bento.settings.layout.bento': 'Focus',
  'bento.dock.home': 'Home',
  'bento.settings.skin.premium': 'Soft',
  'bento.settings.skin.focus': 'Focus',
  'bento.settings.theme.system': 'Match system',
  'bento.settings.theme.light': 'Light',
  'bento.settings.theme.dark': 'Dark',
} as const

/** Every key the product has extracted. A locale file is a `Partial` of this,
    so an unfinished translation falls back to English key by key rather than
    rendering blanks. */
export type Messages = Record<keyof typeof en, string>

export default en
