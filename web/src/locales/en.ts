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
  'shell.layout.classic': 'Classic',
  'shell.layout.bento': 'Bento',

  // --- bento: my work -----------------------------------------------------
  // The smoke-test Bento screen. A later worker replaces it; these keys are
  // the ones the replacement should keep.
  'bento.my_work.title': 'My work',
  'bento.my_work.eyebrow': 'Bento',
  'bento.my_work.outstanding': 'Outstanding',
  'bento.my_work.overdue': 'Overdue',
  'bento.my_work.sections': 'Sections',
  'bento.my_work.nothing': 'Nothing outstanding.',
  'bento.my_work.loading': 'Checking what is outstanding…',
  'bento.my_work.failed': 'That did not load. Nothing here is a figure you can rely on until it does.',

  // --- bento: the head's dashboard ----------------------------------------
  // The Bento rendering of institution_admin.home.dashboard. Same endpoints as
  // the classic screen; these words describe the re-layout, not new data.
  'bento.principal.eyebrow': 'Bento',
  'bento.principal.title': 'Executive overview',
  'bento.principal.loading': 'Opening the school on one page…',
  'bento.principal.failed': 'That did not load. Nothing here is a figure you can rely on until it does.',
  'bento.principal.anchor_label': 'Attendance today, and fee collection',
  'bento.principal.attendance_marked': '{count} marked today',
  'bento.principal.trend_sr': 'Attendance, percentage present, last 30 days',
  'bento.principal.trend_caption': 'Last 30 days',
  'bento.principal.trend_failed': 'The 30-day trend did not load.',
  'bento.principal.collected_label': 'Collected this period',
  'bento.principal.collected_sr': 'Collected as a share of everything billed',
  'bento.principal.collected_of_billed': '{pct}% of {billed} billed',
  'bento.principal.outstanding': 'Outstanding',
  'bento.principal.outstanding_sr': 'Outstanding as a share of everything billed',
  'bento.principal.of_billed': 'of {billed} billed',
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

  // --- bento: the finance dashboard ---------------------------------------
  // The Bento rendering of finance.home.finance_kpis. The ageing bands are
  // summed in the browser from the overdue invoice list the classic screen
  // already fetches — no second endpoint, and no figure the classic screen
  // does not also show.
  'bento.finance.eyebrow': 'Bento',
  'bento.finance.title': 'Finance overview',
  'bento.finance.loading': 'Counting what has come in…',
  'bento.finance.failed': 'That did not load. Nothing here is a figure you can rely on until it does.',
  'bento.finance.anchor_label': 'Collected this period, against everything billed',
  'bento.finance.collected_sr': 'Collected as a share of everything billed',
  'bento.finance.collected_of_expected': '{pct}% of {expected} billed',
  'bento.finance.ageing': 'How old the rest is',
  'bento.finance.ageing_loading': 'Ageing the overdue invoices…',
  'bento.finance.ageing_failed': 'The overdue invoices did not load, so the ageing below is unknown — not zero.',
  'bento.finance.ageing_none': 'Nothing overdue.',
  'bento.finance.ageing_capped': 'The 300 most recent overdue invoices.',
  'bento.finance.age_fresh': 'Up to 30 days',
  'bento.finance.age_mid': '31–60 days',
  'bento.finance.age_old': 'Over 60 days',
  'bento.finance.today': 'Collected today',
  'bento.finance.today_note': 'Today, for the drawer',
  'bento.finance.outstanding': 'Outstanding',
  'bento.finance.overdue_sr': 'Overdue as a share of outstanding',
  'bento.finance.overdue_note': '{amount} of it overdue',
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
  'bento.escape.back': 'Leave Bento',
  'bento.launcher.title': 'All features',
  'bento.launcher.close': 'Close',
  'bento.launcher.recent': 'Recently opened',
  'bento.launcher.results': '{count} matches',
  'bento.launcher.empty': 'Nothing matches “{q}”',
  'bento.launcher.hint': 'Up and down to move, Enter to open, Esc to close',
  'bento.launcher.filter': 'Filter {count} features…',
  'bento.dock.all': 'All features',
  'bento.settings.label': 'Settings',
  'bento.settings.appearance': 'Appearance',
  'bento.settings.theme.system': 'Match system',
  'bento.settings.theme.light': 'Light',
  'bento.settings.theme.dark': 'Dark',
} as const

/** Every key the product has extracted. A locale file is a `Partial` of this,
    so an unfinished translation falls back to English key by key rather than
    rendering blanks. */
export type Messages = Record<keyof typeof en, string>

export default en
