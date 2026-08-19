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
   SCOPE TODAY. The extracted slice is three parent-facing screens under
   `web/src/features/portal/` — Documents, Reminders and ParentIDCard — plus
   the display-preference strings the language selector itself needs. The rest
   of the application still holds its strings inline and renders exactly as it
   did. Extending the extraction is mechanical work; inferring the convention
   is not, which is why this slice is deliberately small and complete rather
   than broad and half-done.
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

  // --- display preferences ----------------------------------------------
  // The language selector's own strings live here so that switching language
  // also translates the control that switched it.
  'preferences.language.label': 'Language',
  'preferences.language.hint': 'Applies wherever you sign in, not just on this device.',
  'preferences.language.name_en': 'English',
  'preferences.contrast.label': 'Contrast',
  'preferences.contrast.checkbox': 'Higher contrast',
  'preferences.contrast.hint': 'Stronger text and borders. Off unless you turn it on.',
} as const

/** Every key the product has extracted. A locale file is a `Partial` of this,
    so an unfinished translation falls back to English key by key rather than
    rendering blanks. */
export type Messages = Record<keyof typeof en, string>

export default en
