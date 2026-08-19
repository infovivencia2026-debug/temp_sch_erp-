import type { Messages } from './en'

/* Telugu (తెలుగు) — the interface language for the families this product is
   actually built for.

   ─────────────────────────────────────────────────────────────────────
   READ en.ts FIRST. Its seven-point comment defines the keys; this file only
   supplies values for them. Nothing here invents a key, renames one, or
   changes what one means.
   ─────────────────────────────────────────────────────────────────────

   WHY THIS IS `Partial<Messages>` AND NOT `Messages`. A key this file does not
   carry falls back to English, per the chain in lib/i18n.tsx. That is the
   designed behaviour and it is why an unfinished translation is shippable: a
   parent gets a screen that is mostly Telugu with an English line in it, which
   is legible, rather than a screen with a blank where a heading was. It also
   means the honest move for a string nobody is sure about is to leave it out.
   A wrong translation on a fee notice is worse than an English one, because
   the English one is obviously English and the wrong one is not obviously
   wrong.

   THE REGISTER. This is the Telugu of a school notice board, not of a literary
   translation. Where Telugu-medium schools in Telangana and Andhra have a
   settled word, that word is used — హాజరు for attendance, ఫీజు for fees,
   సెలవు for a holiday or leave, పరీక్ష for an examination, ఇంటిపని for
   homework, తరగతి for a class, సంరక్షకుడు for a guardian. Where the word
   parents actually say and read is an English loan, it is written in Telugu
   script rather than replaced by a coinage nobody uses: ఫీజు, రసీదు, పోర్టల్,
   క్యాంటీన్. Reaching for a purer Telugu that a parent has to decode is not a
   better translation, it is a worse one.

   WHAT IS DELIBERATELY LEFT IN ENGLISH OR IN DIGITS:
     - proper nouns, including the school's own name;
     - statutory identifiers — APAAR, UDISE, NSP, PAN, Aadhaar as a scheme name;
     - class and section labels like "Class 8-B", which are a record format and
       not prose;
     - numbers, dates and money. These are never written into a string here.
       Money is bigint paise rendered by inr() with Indian digit grouping, and
       every `{count}` placeholder is routed through Intl.NumberFormat by the
       runtime's `fill`. Hand-writing a numeral into a Telugu sentence would
       take it out of both, so placeholders stay placeholders.

   PLACEHOLDER ORDER. `{name}`, `{count}` and friends are preserved exactly,
   but not necessarily in the English position. Telugu is verb-final and its
   modifiers precede what they modify, so several of these sentences put the
   placeholder earlier than English does. That is the point of naming them. */

export const te: Partial<Messages> = {
  // --- portal / Documents.tsx -------------------------------------------
  'portal.documents.loading': 'ఫైల్ చూస్తున్నాం…',
  'portal.documents.eyebrow': 'అభ్యర్థనలు',
  'portal.documents.title': 'ఫైల్‌లో ఉన్న పత్రాలు',
  'portal.documents.description':
    'మీ పిల్లల గురించి స్కూల్ దగ్గర ఉన్న పత్రాలు, వాటిని ఆఫీసు పరిశీలించిందా లేదా.',
  'portal.documents.stat_on_file': 'ఫైల్‌లో ఉన్నవి',
  'portal.documents.stat_checked': 'ఆఫీసు పరిశీలించినవి',
  'portal.documents.stat_unchecked': 'ఇంకా పరిశీలించవలసినవి',
  'portal.documents.card_title': 'పత్రాలు',
  // "the portal does not accept uploads yet" is a statement about this
  // software, so it stays one: పోర్టల్ is what the school's own circulars
  // call it.
  'portal.documents.card_description':
    'లేని పత్రాలు ఏవైనా ఉంటే ఆఫీసుకు ఇవ్వాలి — పోర్టల్ ద్వారా ఇంకా అప్‌లోడ్ చేయలేరు.',
  'portal.documents.col_document': 'పత్రం',
  'portal.documents.col_child': 'పిల్లలు',
  'portal.documents.col_given_on': 'ఇచ్చిన తేదీ',
  'portal.documents.col_size': 'పరిమాణం',
  'portal.documents.col_checked': 'పరిశీలించారా',
  'portal.documents.empty': 'మీ పిల్లల గురించి స్కూల్ దగ్గర ఏ పత్రమూ లేదు.',
  'portal.documents.badge_checked': 'పరిశీలించారు',
  'portal.documents.badge_unchecked': 'ఇంకా పరిశీలించలేదు',
  // The name is a person's name and arrives from the server untranslated; the
  // postposition follows it, which is the opposite of English's "by {name}".
  'portal.documents.checked_by': '{name} గారు పరిశీలించారు',

  // --- portal / Reminders.tsx -------------------------------------------
  'portal.reminders.loading': 'ఏం చేయాలో చూస్తున్నాం…',
  'portal.reminders.eyebrow': 'గుర్తుచేతలు',
  'portal.reminders.title': 'మీరు చేయవలసినవి',
  'portal.reminders.description':
    'ఇవ్వని ఇంటిపని, కట్టని ఫీజు, చూశామని చెప్పని నోటీసులు — ఇంకా ఏదో ఒకటి చేయవలసిన వాటిని మాత్రమే ఇక్కడ చూపుతాం.',
  'portal.reminders.empty_title': 'పెండింగ్‌లో ఏమీ లేదు',
  'portal.reminders.empty_body':
    'స్కూల్ మిమ్మల్ని అడిగినవన్నీ పూర్తయ్యాయి. ఏదైనా చేయవలసి వచ్చే వరకు ఈ జాబితా ఖాళీగానే ఉంటుంది.',
  // The urgent form counts and the calm form does not, exactly as in English.
  // Telugu leads with the count here too, so the placeholder stays first.
  'portal.reminders.card_title_urgent': '{count} వాటికి ఇప్పుడే శ్రద్ధ కావాలి',
  'portal.reminders.card_title': 'చేయవలసినవి',
  'portal.reminders.card_description': 'ముఖ్యమైనవి ముందుగా.',
  'portal.reminders.footnote': 'పూర్తయినవి వాటంతట అవే ఈ జాబితా నుంచి తొలగిపోతాయి.',

  // --- portal / ParentIDCard.tsx ----------------------------------------
  'portal.parent_id_card.loading': 'మీ కార్డు సిద్ధం చేస్తున్నాం…',
  'portal.parent_id_card.no_card': 'కార్డు ఏదీ రాలేదు',
  'portal.parent_id_card.eyebrow': 'ప్రొఫైల్',
  'portal.parent_id_card.title': 'క్యాంపస్ ప్రవేశ పాస్',
  'portal.parent_id_card.description':
    'గేటు దగ్గర ఇది చూపండి. కోడ్ ప్రతి రెండు నిమిషాలకు దానంతట అదే మారుతుంది.',
  'portal.parent_id_card.action_print': 'పాస్ ప్రింట్ చేయండి',
  'portal.parent_id_card.card_kind': 'సంరక్షకుల ప్రవేశ పాస్',
  'portal.parent_id_card.no_children': 'ఈ ఖాతాకు ఏ పిల్లలూ జతచేయబడలేదు',
  // The English pair is "Guardian of" followed by a name, and "Guardian of
  // {count} children". Telugu's postposition means the one-child form cannot
  // be a fragment awaiting a preposition, so it is written as a label the
  // name follows.
  'portal.parent_id_card.guardian_of_one': 'వీరి సంరక్షకులు',
  'portal.parent_id_card.guardian_of_many': '{count} మంది పిల్లల సంరక్షకులు',
  'portal.parent_id_card.pass_number': 'పాస్ నంబర్ {serial}',
  'portal.parent_id_card.gate_note':
    'గేటు దగ్గర పాస్ నంబర్, కోడ్ చదివి చెప్పండి. స్క్రీన్‌షాట్ ఎక్కువసేపు పనిచేయదు — కోడ్ మారుతూ ఉంటుంది, అందుకే దాన్ని ఇతరులకు పంపడం కుదరదు.',

  // --- portal / Portal.tsx ----------------------------------------------
  // The screen a parent lands on, so it carries the most weight.
  'portal.portal.eyebrow': 'పోర్టల్',
  'portal.portal.title': 'నా రోజు',
  'portal.portal.description': 'హాజరు, ఇవ్వవలసిన ఇంటిపని, ఫీజు, రాబోయేవి.',
  'portal.portal.no_link_title': 'విద్యార్థి రికార్డు జతచేయలేదు',
  'portal.portal.no_link_body':
    'మీ ఖాతా ఇంకా ఏ విద్యార్థికీ జతచేయలేదు. జతచేయమని స్కూల్ ఆఫీసును అడగండి.',
  'portal.portal.empty_title': 'ఇంకా ఏమీ నమోదు కాలేదు',
  'portal.portal.empty_body':
    'ఈ విద్యార్థికి స్కూల్ హాజరు, ఇంటిపని, ఫీజు నమోదు చేయడం మొదలుపెట్టాక ఇక్కడ కనిపిస్తాయి.',
  'portal.portal.stat_attendance': 'మొత్తం హాజరు',
  'portal.portal.stat_attendance_delta': '{count} రోజులు నమోదయ్యాయి',
  // హాజరు / గైర్హాజరు is the pair every Telugu-medium attendance register uses.
  'portal.portal.stat_present': 'హాజరు',
  'portal.portal.stat_absent': 'గైర్హాజరు',
  'portal.portal.stat_days': '{count} రోజులు',
  'portal.portal.stat_homework': 'ఇవ్వవలసిన ఇంటిపని',
  'portal.portal.stat_homework_value': '{count} పెండింగ్‌లో',
  'portal.portal.homework_none': 'ఏమీ పెండింగ్ లేదు',
  'portal.portal.homework_soonest': 'ముందుగా ఉన్నది {when}',
  // The four whole phrases {when} is filled with. Each stands alone, so the
  // sentence above reads correctly whichever one arrives.
  'portal.portal.due_overdue': 'గడువు దాటింది',
  'portal.portal.due_today': 'ఈ రోజు',
  'portal.portal.due_tomorrow': 'రేపు',
  'portal.portal.due_in_days': '{days} రోజుల్లో',
  'portal.portal.stat_fees': 'బాకీ ఉన్న ఫీజు',
  'portal.portal.fees_payable': 'ఇప్పుడు కట్టవలసినది',
  'portal.portal.fees_settled': 'అంతా చెల్లించారు',
  'portal.portal.stat_next_exam': 'తదుపరి పరీక్ష',
  'portal.portal.today_title': 'ఈ రోజు తరగతులు',
  'portal.portal.today_description': 'ప్రతి తరగతిని తీసుకునే ఉపాధ్యాయులతో సహా, వరుస క్రమంలో.',
  'portal.portal.today_none_description': 'ఈ రోజు టైమ్‌టేబుల్‌లో ఏమీ లేదు.',
  'portal.portal.today_empty_title': 'ఈ రోజు తరగతులు లేవు',
  'portal.portal.today_empty_body':
    'సెలవు, వారాంతం, లేదా ఈ సెక్షన్‌కు టైమ్‌టేబుల్ ఇంకా పెట్టలేదు.',
  'portal.portal.children_title': 'జతచేసిన పిల్లలు',
  'portal.portal.children_description': 'చూపు మార్చడానికి పైన మార్చండి',
  'portal.portal.not_enrolled': 'చేరలేదు',
  'portal.portal.history_title': 'హాజరు వివరాలు',
  'portal.portal.history_description': 'గత 120 రోజులు, ఇటీవలివి ముందుగా',
  'portal.portal.history_empty': 'ఇంకా హాజరు నమోదు కాలేదు.',

  // --- portal / Fees.tsx -------------------------------------------------
  // ఫీజు, not a coinage: it is the word on every fee notice in the region.
  // Every {amount} here arrives already formatted by inr() as bigint paise
  // with Indian digit grouping, so nothing in this block writes a numeral.
  'portal.fees.eyebrow': 'ఫీజు',
  'portal.fees.title': 'ఫీజు',
  'portal.fees.title_due': '{amount} కట్టవలసి ఉంది',
  'portal.fees.title_nothing_due': 'కట్టవలసినది ఏమీ లేదు',
  'portal.fees.description_due':
    '{name} కోసం. స్కూల్ ఆఫీసులో చెల్లించండి, రసీదు ఇక్కడ కనిపిస్తుంది.',
  'portal.fees.description_paid': '{name} ఫీజు పూర్తిగా చెల్లించారు. రసీదులు కింద ఉన్నాయి.',
  'portal.fees.no_link_title': 'విద్యార్థి రికార్డు జతచేయలేదు',
  'portal.fees.no_link_body':
    'మీ ఖాతా ఇంకా ఏ విద్యార్థికీ జతచేయలేదు. జతచేయమని స్కూల్ ఆఫీసును అడగండి.',
  'portal.fees.no_record_title': 'ఇంకా ఫీజు రికార్డు లేదు',
  'portal.fees.no_record_body':
    'ఈ విద్యార్థికి స్కూల్ ఇంకా బిల్లు వేయలేదు. వేసిన వెంటనే ఇక్కడ కనిపిస్తుంది.',
  'portal.fees.action_print': 'స్టేట్‌మెంట్ ప్రింట్ చేయండి',
  'portal.fees.stat_outstanding': 'బాకీ',
  'portal.fees.stat_overdue': 'గడువు దాటిన వాయిదాలు',
  'portal.fees.stat_overdue_delta': '{days} రోజులు ఆలస్యం',
  'portal.fees.stat_overdue_none': 'ఆలస్యం ఏమీ లేదు',
  'portal.fees.stat_paid': 'ఇప్పటివరకు చెల్లించినది',
  'portal.fees.instalments_title': 'వాయిదాలు',
  'portal.fees.instalments_description': 'స్కూల్ వేసిన బిల్లు, దాని గడువు తేదీ',
  'portal.fees.instalments_empty_title': 'ఇంకా బిల్లు వేయలేదు',
  'portal.fees.instalments_empty_body':
    'ఈ సంవత్సరానికి స్కూల్ వాయిదాలు జారీ చేసినకొద్దీ ఇక్కడ కనిపిస్తాయి.',
  'portal.fees.col_instalment': 'వాయిదా',
  'portal.fees.col_due': 'గడువు',
  'portal.fees.col_amount': 'మొత్తం',
  'portal.fees.col_paid': 'చెల్లించినది',
  'portal.fees.col_still_due': 'ఇంకా బాకీ',
  'portal.fees.col_status': 'స్థితి',
  // Telugu puts the ordinal before the noun, so the number leads here where
  // English trails it.
  'portal.fees.instalment_no': '{number}వ వాయిదా',
  'portal.fees.days_late': '{days} రో. ఆలస్యం',
  'portal.fees.incl_fine': '{amount} జరిమానాతో కలిపి',
  'portal.fees.receipts_title': 'రసీదులు',
  'portal.fees.receipts_description': 'ఈ విద్యార్థి పేరున నమోదైన ప్రతి చెల్లింపు',
  'portal.fees.receipts_empty_title': 'ఇంకా చెల్లింపులు లేవు',
  'portal.fees.col_receipt': 'రసీదు',
  'portal.fees.col_date': 'తేదీ',
  'portal.fees.col_mode': 'విధానం',
  'portal.fees.col_reference': 'రిఫరెన్స్',
  'portal.fees.bounced_note':
    'పైన ఉన్న ఒక చెల్లింపును బ్యాంకు తిరస్కరించింది, కాబట్టి ఆ మొత్తం ఇంకా బాకీ ఉంది. ఆఫీసును సంప్రదించండి.',

  // --- portal / Receipts.tsx ---------------------------------------------
  'portal.receipts.loading': 'మీ చెల్లింపులు చూస్తున్నాం…',
  'portal.receipts.eyebrow': 'ఫీజు',
  'portal.receipts.title': 'రసీదులు',
  'portal.receipts.description':
    'స్కూల్ బ్యాంకులో జమ చేసిన ప్రతి చెల్లింపు, ప్రింట్ చేసుకోగల లేదా భద్రపరచుకోగల రసీదుతో.',
  'portal.receipts.stat_receipts': 'రసీదులు',
  'portal.receipts.stat_paid_total': 'మొత్తం చెల్లించినది',
  'portal.receipts.stat_most_recent': 'చివరిది',
  'portal.receipts.card_title': 'చెల్లింపులు',
  'portal.receipts.card_description': 'బ్యాంకు క్లియర్ చేసిన డబ్బు మాత్రమే ఇక్కడ కనిపిస్తుంది.',
  'portal.receipts.col_receipt': 'రసీదు',
  'portal.receipts.col_child': 'పిల్లలు',
  'portal.receipts.col_paid_on': 'చెల్లించిన తేదీ',
  'portal.receipts.col_how': 'ఎలా',
  'portal.receipts.col_amount': 'మొత్తం',
  'portal.receipts.empty': 'ఇంకా ఏ చెల్లింపూ క్లియర్ కాలేదు.',
  'portal.receipts.action_hide': 'దాచండి',
  'portal.receipts.action_open': 'తెరవండి',
  'portal.receipts.detail_loading': 'రసీదు సిద్ధం చేస్తున్నాం…',
  'portal.receipts.detail_title': 'రసీదు {number}',
  'portal.receipts.detail_description': '{institution} · ఆర్థిక సంవత్సరం {year}',
  // PDF is the file format's name, not a word to translate.
  'portal.receipts.action_download': 'PDF డౌన్‌లోడ్ చేయండి',
  'portal.receipts.detail_received_from': 'ఎవరి నుంచి',
  'portal.receipts.detail_admission_no': 'అడ్మిషన్ నంబర్',
  'portal.receipts.detail_class': 'తరగతి',
  'portal.receipts.detail_paid_on': 'చెల్లించిన తేదీ',
  'portal.receipts.detail_method': 'విధానం',
  'portal.receipts.detail_status': 'స్థితి',
  'portal.receipts.col_invoice': 'ఇన్‌వాయిస్',
  'portal.receipts.col_particulars': 'వివరాలు',
  'portal.receipts.col_line_amount': 'మొత్తం',
  // Distinguished from col_line_amount above on purpose. Both are "amount"
  // words in Telugu, and a receipt that heads its line column and its sum row
  // with the same word is unreadable, so the sum says it is a sum.
  'portal.receipts.total': 'మొత్తం కలిపి',

  // --- portal / Consent.tsx ---------------------------------------------
  'portal.consent.loading': 'సంతకం కావలసినవి చూస్తున్నాం…',
  'portal.consent.eyebrow': 'అనుమతి',
  'portal.consent.title': 'మీరు చేయవలసినవి',
  'portal.consent.description':
    'స్కూల్ మిమ్మల్ని అడిగిన అనుమతులు, మీ పిల్లలు వెళ్లాలని అడిగిన ప్రయాణాలు.',
  'portal.consent.stat_trips': 'అనుమతించవలసిన ప్రయాణాలు',
  'portal.consent.stat_circulars': 'సంతకం చేయవలసిన సర్క్యులర్లు',
  'portal.consent.stat_out_now': 'ఇప్పుడు బయట ఉన్నవారు',
  'portal.consent.trips_title': 'క్యాంపస్ నుంచి బయటికి',
  'portal.consent.trips_description':
    'మీ అనుమతి వార్డెన్ అనుమతికి వేరు; మీ పిల్లలు బయటికి వెళ్లాలంటే గేటుకు రెండూ కావాలి.',
  'portal.consent.trips_empty_title': 'ఎదురుచూస్తున్నది ఏమీ లేదు',
  'portal.consent.trips_empty_body':
    'మీ పిల్లలు బయటికి వెళ్లాలని అడిగినప్పుడు, ఆ అభ్యర్థన మీ అనుమతి కోసం ఇక్కడ కనిపిస్తుంది.',
  'portal.consent.pass_window': '{from} నుంచి {to} వరకు',
  'portal.consent.going_with': '{name} గారితో వెళ్తున్నారు',
  'portal.consent.warden_permitted': 'వార్డెన్ దీనికి అనుమతి ఇచ్చారు ({name}).',
  'portal.consent.warden_not_permitted': 'వార్డెన్ ఇంకా అనుమతి ఇవ్వలేదు.',
  'portal.consent.action_agree': 'నేను అంగీకరిస్తున్నాను',
  'portal.consent.circulars_title': 'సంతకం చేయవలసిన సర్క్యులర్లు',
  'portal.consent.circulars_description': 'మీరు చూశామని తెలపమని స్కూల్ అడిగిన నోటీసులు.',
  'portal.consent.circulars_empty_title': 'అన్నీ సంతకం అయ్యాయి',
  'portal.consent.circulars_empty_body': 'స్కూల్ నుంచి మీ దగ్గర పెండింగ్‌లో ఏమీ లేదు.',
  'portal.consent.action_ack': 'నేను దీన్ని చదివాను',
  'portal.consent.request_prompt':
    'పెళ్లికి, ఆసుపత్రికి, లేదా వారాంతానికి ఇంటికి పిల్లలను తీసుకెళ్తున్నారా?',
  'portal.consent.request_action': 'పాస్ కోసం అడగండి',
  'portal.consent.request_title': 'పాస్ కోసం అడగండి',
  'portal.consent.request_description':
    'వార్డెన్ అనుమతి ఇంకా కావాలి. తోడు వచ్చేవారి నంబర్ ఇస్తే, పిల్లలు ఎవరితో ఉన్నారో వారిని హాస్టల్ సంప్రదించగలదు.',
  'portal.consent.field_child': 'పిల్లలు',
  'portal.consent.field_child_placeholder': 'పిల్లలను ఎంచుకోండి',
  'portal.consent.field_going_to': 'ఎక్కడికి',
  // field_going_to_placeholder is the town Karimnagar and is left to fall back
  // to English: a place name is not translated, and transliterating one in a
  // placeholder is a guess about how the school writes it.
  'portal.consent.field_leaving': 'ఎప్పుడు వెళ్తున్నారు',
  'portal.consent.field_leaving_hint': 'పిల్లలు బయటికి వెళ్లే తేదీ, సమయం.',
  'portal.consent.field_back_by': 'ఎప్పటికి తిరిగి',
  'portal.consent.field_back_by_hint': 'ఈ సమయానికి రాకపోతే హాస్టల్ వెతకడం మొదలుపెడుతుంది.',
  'portal.consent.field_escort': 'ఎవరితో వెళ్తున్నారు',
  'portal.consent.field_escort_phone': 'వారి ఫోన్ నంబర్',
  'portal.consent.field_reason': 'కారణం',
  'portal.consent.field_reason_placeholder': 'బంధువుల పెళ్లి',
  'portal.consent.action_sending': 'పంపుతున్నాం…',
  'portal.consent.action_send': 'వార్డెన్‌కు పంపండి',
  'portal.consent.history_title': 'గత పాస్‌లు',
  'portal.consent.history_description': 'అడిగిన ప్రతి ప్రయాణం, దానికి ఏమైందో.',

  // --- portal / Results.tsx ---------------------------------------------
  // ప్రోగ్రెస్ కార్డు is what a report card is called on the ground; the
  // Sanskritised alternative is not what a parent asks the office for.
  'portal.results.eyebrow': 'ఫలితాలు',
  'portal.results.title': 'ఫలితాలు',
  'portal.results.no_child_title': 'విద్యార్థి రికార్డు జతచేయలేదు',
  'portal.results.no_child_body':
    'మీ ఖాతా ఇంకా ఏ విద్యార్థికీ జతచేయలేదు. జతచేయమని స్కూల్ ఆఫీసును అడగండి.',
  'portal.results.none_title': 'ఇంకా ఫలితాలు విడుదల కాలేదు',
  'portal.results.none_body':
    'మీ స్కూల్ ఇంకా ఏ ఫలితాలూ విడుదల చేయలేదు. చేసిన వెంటనే ఇక్కడ కనిపిస్తాయి — తాత్కాలికమైనవి ఏవీ చూపము.',
  'portal.results.published_title': 'విడుదలైన ఫలితాలు',
  'portal.results.published_description': '{name} కోసం స్కూల్ విడుదల చేసిన ప్రోగ్రెస్ కార్డులు.',
  'portal.results.stat_latest': 'చివరిది',
  'portal.results.stat_grade': 'గ్రేడ్',
  'portal.results.stat_rank': 'సెక్షన్‌లో ర్యాంక్',
  // GPA is a statutory-style abbreviation printed on the card itself; it stays.
  'portal.results.gpa': 'GPA {value}',
  'portal.results.stat_attendance': 'హాజరు',
  'portal.results.stat_attendance_hint': 'ప్రోగ్రెస్ కార్డులో ఉన్నది',
  'portal.results.cards_title': 'ప్రోగ్రెస్ కార్డులు',
  'portal.results.cards_description': 'స్కూల్ విడుదల చేసినవి మాత్రమే',
  'portal.results.cards_empty_title': 'ఇంకా ఏమీ విడుదల కాలేదు',
  'portal.results.cards_empty_body':
    'మార్కులు అప్పటికే నమోదై ఉండవచ్చు; స్కూల్ కార్డును విడుదల చేశాక ఇక్కడ కనిపిస్తాయి.',
  'portal.results.col_term': 'టర్మ్',
  'portal.results.col_total': 'మొత్తం',
  'portal.results.col_percentage': 'శాతం',
  'portal.results.col_grade': 'గ్రేడ్',
  'portal.results.col_rank': 'ర్యాంక్',
  'portal.results.col_published': 'విడుదలైన తేదీ',
  'portal.results.class_teacher': 'క్లాస్ టీచర్',
  'portal.results.subject_count': '{count} సబ్జెక్టులు',
  'portal.results.col_subject': 'సబ్జెక్ట్',
  'portal.results.col_marks': 'మార్కులు',
  'portal.results.col_out_of': 'మొత్తం మార్కులు',
  'portal.results.col_subject_grade': 'గ్రేడ్',
  'portal.results.absent': 'గైర్హాజరు',

  // --- portal / Calendar.tsx --------------------------------------------
  'portal.calendar.loading': 'క్యాలెండర్ చూస్తున్నాం…',
  'portal.calendar.eyebrow': 'స్కూల్ జీవితం',
  'portal.calendar.title': 'క్యాలెండర్',
  'portal.calendar.description': 'సెలవులు, పరీక్షలు, కార్యక్రమాలు, మీరు బుక్ చేసుకున్న సమావేశాలు.',
  'portal.calendar.stat_coming_up': 'రాబోయేవి',
  'portal.calendar.stat_examinations': 'పరీక్షలు',
  'portal.calendar.stat_events': 'కార్యక్రమాలు',
  'portal.calendar.stat_your_meetings': 'మీ సమావేశాలు',
  'portal.calendar.field_child': 'పిల్లలు',
  'portal.calendar.field_child_hint':
    'ఒక తరగతికి సంబంధించిన కార్యక్రమాలు ఆ తరగతిలో ఉన్న పిల్లలకు మాత్రమే కనిపిస్తాయి.',
  'portal.calendar.all_children': 'నా పిల్లలందరూ',
  'portal.calendar.empty_title': 'షెడ్యూల్ చేసినవి ఏమీ లేవు',
  'portal.calendar.empty_body':
    'స్కూల్ సెలవులు, పరీక్షలు, కార్యక్రమాలు ప్రకటించినప్పుడు ఇక్కడ కనిపిస్తాయి.',
  'portal.calendar.entry_count': '{count} అంశాలు',
  'portal.calendar.kind_ptm_booking': 'మీ సమావేశం',
  'portal.calendar.kind_working_day': 'పని దినం',
  'portal.calendar.kind_annual_day': 'వార్షికోత్సవం',
  'portal.calendar.kind_sports_day': 'క్రీడా దినోత్సవం',
  'portal.calendar.kind_field_trip': 'విద్యా యాత్ర',

  // --- portal / Alerts.tsx ----------------------------------------------
  'portal.alerts.loading': 'మీ అలర్ట్‌లు చూస్తున్నాం…',
  'portal.alerts.eyebrow': 'హోమ్',
  'portal.alerts.title': 'అలర్ట్‌లు',
  'portal.alerts.description': 'సర్క్యులర్లు, గైర్హాజరులు, ఫీజు, ఇంటిపని — జరిగిన వరుసలో.',
  'portal.alerts.action_mark_all_read': 'అన్నీ చదివినట్టు గుర్తించు',
  'portal.alerts.stat_unread': 'చదవనివి',
  'portal.alerts.stat_fee_alerts': 'ఫీజు అలర్ట్‌లు',
  'portal.alerts.stat_absences_flagged': 'గుర్తించిన గైర్హాజరులు',
  'portal.alerts.field_child': 'పిల్లలు',
  'portal.alerts.field_child_hint':
    'స్కూల్ మొత్తానికి సంబంధించిన సర్క్యులర్లు ఏ పిల్లలను ఎంచుకున్నా కనిపిస్తాయి.',
  'portal.alerts.all_children': 'నా పిల్లలందరూ',
  'portal.alerts.card_title': 'అన్నీ',
  'portal.alerts.card_description': '{count} అలర్ట్‌లు.',
  'portal.alerts.empty_title': 'ఇంకా ఏమీ లేవు',
  'portal.alerts.empty_body':
    'సర్క్యులర్లు, గైర్హాజరులు, ఫీజు గుర్తుచేతలు జరిగినకొద్దీ ఇక్కడ కనిపిస్తాయి.',
  'portal.alerts.action_dismiss': 'తీసివేయండి',
  'portal.alerts.kind_fee_due': 'ఫీజు',
  'portal.alerts.kind_attendance': 'హాజరు',
  'portal.alerts.kind_homework': 'ఇంటిపని',
  'portal.alerts.kind_circular': 'సర్క్యులర్',
  'portal.alerts.kind_ptm': 'సమావేశం',
  'portal.alerts.kind_event': 'కార్యక్రమం',

  // --- portal / Pickup.tsx ----------------------------------------------
  'portal.pickup.loading': 'మీ పాస్‌లు చూస్తున్నాం…',
  'portal.pickup.eyebrow': 'అనుమతి',
  'portal.pickup.title': 'వేరే వారు తీసుకెళ్లడం',
  'portal.pickup.description':
    'మీ పిల్లలను స్కూల్ ఎవరికి అప్పగించవచ్చో ఆ వ్యక్తి పేరు — ఒకసారికి, ఒక రోజుకు.',
  'portal.pickup.stat_in_force': 'అమల్లో ఉన్న పాస్‌లు',
  'portal.pickup.stat_used': 'వాడినవి',
  'portal.pickup.stat_cancelled': 'రద్దు చేసినవి',
  'portal.pickup.code_title': 'ఈ నంబర్ వారికి ఇవ్వండి',
  'portal.pickup.code_description':
    'గేటు దగ్గర దీన్ని అడుగుతారు. తీసుకెళ్లే వ్యక్తికి తప్ప ఇంకెవరికీ పంపవద్దు.',
  // Telugu puts the date before what happens on it, so {date} leads where
  // English trails it.
  'portal.pickup.collecting': '{date}న {child}ను తీసుకెళ్లడానికి',
  'portal.pickup.cancel_confirm': 'రద్దు చేయండి',
  'portal.pickup.cancel_question': 'కోడ్ వెంటనే పనిచేయడం ఆగిపోతుంది.',
  'portal.pickup.action_cancel': 'రద్దు',
  'portal.pickup.history_title': 'మీరు అనుమతించినవన్నీ',
  'portal.pickup.history_description': 'ఎవరు ఎవరిని తీసుకెళ్లారో స్కూల్ చెప్పగలిగేలా భద్రపరిచాం.',
  'portal.pickup.col_person': 'వ్యక్తి',
  'portal.pickup.col_child': 'పిల్లలు',
  'portal.pickup.col_day': 'రోజు',
  'portal.pickup.col_why': 'ఎందుకు',
  'portal.pickup.col_what_happened': 'ఏమైంది',
  'portal.pickup.empty': 'మీ పిల్లలను తీసుకెళ్లమని మీరు ఎవరినీ అడగలేదు.',
  // ID stays: it is the identifier's name, not a word.
  'portal.pickup.id_fallback': 'ID',
  'portal.pickup.collected_on': '{date}న తీసుకెళ్లారు',
  'portal.pickup.released_by': ' · {name} గారు అప్పగించారు',
  'portal.pickup.form_title': 'ఎవరినైనా అనుమతించండి',
  'portal.pickup.form_description':
    'ఒక రోజు, ఒకసారి తీసుకెళ్లడానికి మాత్రమే. వారి ID చివరి నాలుగు అంకెలు ఇస్తే, ఎదురుగా ఉన్న వ్యక్తి మీరు చెప్పిన వ్యక్తేనా అని గేటు సరిచూసుకోగలదు.',
  'portal.pickup.field_child': 'పిల్లలు',
  'portal.pickup.child_placeholder': 'పిల్లలను ఎంచుకోండి',
  'portal.pickup.field_name': 'వారి పేరు',
  'portal.pickup.field_phone': 'వారి ఫోన్ నంబర్',
  'portal.pickup.field_relation': 'పిల్లలకు వారు ఏమవుతారు',
  'portal.pickup.field_day': 'ఏ రోజు',
  'portal.pickup.field_day_hint': 'ఈ రోజు అయితే ఖాళీగా వదిలేయండి. ఎక్కువలో ఎక్కువ ఒక నెల ముందు వరకు.',
  'portal.pickup.field_id': 'వారు తెచ్చే ID',
  'portal.pickup.id_placeholder': 'ఏదీ లేదు',
  'portal.pickup.field_id_last4': 'దాని చివరి నాలుగు అంకెలు',
  'portal.pickup.field_reason': 'వేరే వారు ఎందుకు',
  'portal.pickup.reason_placeholder':
    'నేను ప్రయాణంలో ఉన్నాను, స్కూల్ మూసేలోపు తిరిగి రాలేను',
  'portal.pickup.action_creating': 'సిద్ధం చేస్తున్నాం…',
  'portal.pickup.action_create': 'పాస్ సిద్ధం చేయండి',
  'portal.pickup.created_ok': '{code} కోడ్ వారికి ఇవ్వండి.',

  // --- portal / PTM.tsx --------------------------------------------------
  'portal.ptm.loading': 'సమావేశ సమయాలు చూస్తున్నాం…',
  'portal.ptm.eyebrow': 'స్కూల్ జీవితం',
  'portal.ptm.title': 'తల్లిదండ్రులు-ఉపాధ్యాయుల సమావేశం',
  'portal.ptm.description': 'ఉదయం క్యూలో నిలబడకుండా, మీ పిల్లల ఉపాధ్యాయులతో ఒక సమయం తీసుకోండి.',
  'portal.ptm.stat_free': 'ఖాళీగా ఉన్న సమయాలు',
  'portal.ptm.stat_yours': 'మీ సమావేశాలు',
  'portal.ptm.stat_held': 'జరిగిన సమావేశాలు',
  'portal.ptm.book_title': 'ఒక సమయం బుక్ చేసుకోండి',
  'portal.ptm.book_description':
    'పిల్లలను ఎంచుకుని, మాట్లాడవలసినది ఏదైనా ఉంటే రాసి, ఒక సమయం తీసుకోండి.',
  'portal.ptm.field_child': 'పిల్లలు',
  'portal.ptm.child_placeholder': 'ఏ పిల్లలు…',
  'portal.ptm.field_note': 'మీరు దేని గురించి మాట్లాడాలనుకుంటున్నారు?',
  'portal.ptm.field_note_hint': 'ఐచ్ఛికం. సమావేశానికి ముందు ఉపాధ్యాయులు దీన్ని చూస్తారు.',
  'portal.ptm.note_placeholder': 'చదవడంలో ప్రగతి',
  'portal.ptm.booked_ok': 'సమావేశం బుక్ అయ్యింది.',
  'portal.ptm.col_date': 'తేదీ',
  'portal.ptm.col_time': 'సమయం',
  'portal.ptm.col_teacher': 'ఉపాధ్యాయులు',
  'portal.ptm.col_for': 'ఎవరి కోసం',
  'portal.ptm.col_where': 'ఎక్కడ',
  'portal.ptm.empty_slots': 'స్కూల్ ఇంకా ఏ సమయాలూ ఇవ్వలేదు.',
  'portal.ptm.slot_minutes': ' · {minutes} నిమి',
  // {section} is a record label such as 8-B and is never translated; only the
  // word around it is, and in Telugu that word follows rather than leads.
  'portal.ptm.slot_class': '{section} తరగతి',
  'portal.ptm.slot_any_class': 'ఏ తరగతైనా',
  'portal.ptm.slot_yours': 'మీది · {name}',
  'portal.ptm.slot_taken': 'తీసుకున్నారు',
  'portal.ptm.choose_child_first': 'ముందు పిల్లలను ఎంచుకోండి',
  'portal.ptm.action_take': 'ఈ సమయం తీసుకోండి',
  'portal.ptm.mine_title': 'మీ సమావేశాలు',
  'portal.ptm.mine_description': 'స్కూల్ పంచుకున్నచోట, ఏం నిర్ణయించారో సహా.',
  'portal.ptm.empty_title': 'ఇంకా సమావేశాలు లేవు',
  'portal.ptm.empty_body': 'పైన ఒక సమయం తీసుకుంటే ఇక్కడ కనిపిస్తుంది.',
  'portal.ptm.with_teacher': ' {teacher} గారితో',
  'portal.ptm.meeting_when': '{date} · {time} · {minutes} నిమి',
  'portal.ptm.cancel_confirm': 'సమయాన్ని వదిలేయండి',
  'portal.ptm.cancel_question': 'ఆ సమయం తిరిగి స్కూల్‌కు వెళ్తుంది.',
  'portal.ptm.action_cancel': 'రద్దు',
  'portal.ptm.label_raised': 'లేవనెత్తినది: ',
  'portal.ptm.label_agreed': 'నిర్ణయించినది: ',

  // --- portal / Cafeteria.tsx --------------------------------------------
  'portal.cafeteria.loading': 'క్యాంటీన్ లెక్క చూస్తున్నాం…',
  'portal.cafeteria.eyebrow': 'ఫీజు',
  'portal.cafeteria.title': 'క్యాంటీన్',
  'portal.cafeteria.description': 'కౌంటర్‌లో కొన్న ప్రతి వస్తువు, కొన్న సమయంతో సహా.',
  'portal.cafeteria.stat_spent': 'ఖర్చు',
  'portal.cafeteria.stat_purchases': 'కొనుగోళ్లు',
  'portal.cafeteria.stat_calories': 'కేలరీలు',
  'portal.cafeteria.field_child': 'పిల్లలు',
  'portal.cafeteria.option_all_children': 'నా పిల్లలందరూ',
  'portal.cafeteria.empty_title': 'ఏమీ కొనలేదు',
  'portal.cafeteria.empty_body':
    'మీ పిల్లలు క్యాంటీన్ కౌంటర్‌లో ఏదైనా కొంటే కొన్ని నిమిషాల్లో ఇక్కడ కనిపిస్తుంది.',
  // kcal is a unit symbol and stays as it is, like a currency symbol.
  'portal.cafeteria.day_summary_one': '{count} కొనుగోలు · {kcal} kcal',
  'portal.cafeteria.day_summary_many': '{count} కొనుగోళ్లు · {kcal} kcal',
  'portal.cafeteria.item_kcal': '{kcal} kcal',
  'portal.cafeteria.badge_non_veg': 'నాన్-వెజ్',
  'portal.cafeteria.badge_allergens': '{allergens} ఉన్నాయి',

  // --- portal / StudentIDCard.tsx ----------------------------------------
  'portal.student_id_card.loading': 'కార్డు సిద్ధం చేస్తున్నాం…',
  'portal.student_id_card.no_card': 'కార్డు ఏదీ రాలేదు',
  'portal.student_id_card.eyebrow': 'ప్రొఫైల్',
  'portal.student_id_card.title': 'విద్యార్థి గుర్తింపు కార్డు',
  'portal.student_id_card.description': 'మీ పిల్లల గుర్తింపు కార్డు, దానంతట అదే మారే కోడ్‌తో.',
  'portal.student_id_card.action_print': 'కార్డు ప్రింట్ చేయండి',
  'portal.student_id_card.field_child': 'పిల్లలు',
  'portal.student_id_card.choose_title': 'పిల్లలను ఎంచుకోండి',
  'portal.student_id_card.choose_body':
    'కార్డు, దాని గేటు కోడ్ ఒక్క పిల్లవాడికే చెందుతాయి, కాబట్టి ఈ స్క్రీన్‌కు ఎవరిదో తెలియాలి.',
  'portal.student_id_card.photo': 'ఫోటో',
  'portal.student_id_card.no_photo': 'ఫోటో లేదు',
  'portal.student_id_card.not_enrolled': 'చేరలేదు',
  'portal.student_id_card.roll': ' · రోల్ {roll}',
  'portal.student_id_card.admission_no': 'అడ్మిషన్ నం.',
  'portal.student_id_card.date_of_birth': 'పుట్టిన తేదీ',
  'portal.student_id_card.blood_group': 'బ్లడ్ గ్రూప్',
  'portal.student_id_card.house': 'హౌస్',
  'portal.student_id_card.emergency': 'అత్యవసర సమయంలో',
  'portal.student_id_card.allergies': 'అలర్జీలు',
  'portal.student_id_card.pass_number': 'కార్డు నంబర్ {serial}',
  'portal.student_id_card.gate_note':
    'సుమారు ప్రతి రెండు నిమిషాలకు మారుతుంది. ఫోటో కాదు, ఈ స్క్రీన్‌నే చూపండి.',

  // --- portal / Requests.tsx ---------------------------------------------
  'portal.requests.loading': 'మీ అభ్యర్థనలు చూస్తున్నాం…',
  'portal.requests.eyebrow': 'అభ్యర్థనలు',
  'portal.requests.title': 'సర్టిఫికెట్లు',
  'portal.requests.description':
    'ఆఫీసుకు ఫోన్ చేయకుండానే పత్రం అడగండి, అది ఎంతవరకు వచ్చిందో చూడండి.',
  'portal.requests.stat_with_office': 'ఆఫీసు దగ్గర',
  'portal.requests.stat_issued': 'జారీ అయినవి',
  'portal.requests.stat_ready': 'తీసుకెళ్లడానికి సిద్ధం',
  'portal.requests.form_title': 'సర్టిఫికెట్ కోసం అడగండి',
  'portal.requests.form_description':
    'సర్టిఫికెట్‌పైనే ప్రయోజనాన్ని ఆఫీసు రాస్తుంది, కాబట్టి అది దేనికో చెప్పండి.',
  'portal.requests.field_child': 'పిల్లలు',
  'portal.requests.choose_child': 'పిల్లలను ఎంచుకోండి',
  'portal.requests.field_which': 'ఏ సర్టిఫికెట్',
  'portal.requests.hint_needs_approval': 'దీనికి ముందు ప్రిన్సిపాల్ ఆమోదం కావాలి.',
  'portal.requests.choose_one': 'ఒకటి ఎంచుకోండి',
  'portal.requests.no_types': 'స్కూల్ ఏవీ ఏర్పాటు చేయలేదు',
  'portal.requests.field_purpose': 'ఇది దేనికి',
  'portal.requests.purpose_placeholder': 'పాస్‌పోర్ట్ దరఖాస్తు',
  'portal.requests.sending': 'పంపుతున్నాం…',
  'portal.requests.action_ask': 'ఆఫీసును అడగండి',
  'portal.requests.sent_ok': 'అడిగాం. ఆఫీసు ఇప్పుడు దీన్ని చూడగలదు.',
  'portal.requests.list_title': 'మీ అభ్యర్థనలు',
  'portal.requests.list_description': 'ఆఫీసుకు ఫోన్ చేస్తే ఈ నంబర్ చెప్పాలి.',
  'portal.requests.col_number': 'నంబర్',
  'portal.requests.col_certificate': 'సర్టిఫికెట్',
  'portal.requests.col_child': 'పిల్లలు',
  'portal.requests.col_for': 'దేనికి',
  'portal.requests.col_asked_on': 'అడిగిన తేదీ',
  'portal.requests.col_where': 'ఎక్కడ ఉంది',
  'portal.requests.empty': 'మీరు ఏ సర్టిఫికెట్లూ అడగలేదు.',
  'portal.requests.signed_copy': 'సంతకం చేసిన కాపీ ఫైల్‌లో ఉంది',
  'portal.requests.docs_title': 'స్కూల్ దగ్గర ఉన్న పత్రాలు',
  'portal.requests.docs_description':
    '{count} ఫైల్‌లో ఉన్నాయి, {unchecked} ఇంకా పరిశీలించవలసి ఉంది. లేని పత్రాలు ఏవైనా ఉంటే ఆఫీసుకు ఇవ్వాలి — పోర్టల్ ద్వారా ఇంకా అప్‌లోడ్ చేయలేరు.',
  'portal.requests.docs_description_empty':
    'ఇంకా ఫైల్‌లో ఏమీ లేవు. ఆఫీసుకు ఇచ్చిన పత్రాలు ఇక్కడ కనిపిస్తాయి.',
  'portal.requests.docs_col_document': 'పత్రం',
  'portal.requests.docs_col_child': 'పిల్లలు',
  'portal.requests.docs_col_given_on': 'ఇచ్చిన తేదీ',
  'portal.requests.docs_col_size': 'పరిమాణం',
  'portal.requests.docs_col_checked': 'పరిశీలించారా',
  'portal.requests.docs_empty': 'స్కూల్ దగ్గర ఫైల్‌లో ఏమీ లేవు.',
  'portal.requests.docs_badge_checked': 'పరిశీలించారు',
  'portal.requests.docs_badge_unchecked': 'ఇంకా పరిశీలించలేదు',
  'portal.requests.docs_checked_by': '{name} గారు',

  // --- portal / LeaveRequests.tsx ----------------------------------------
  // సెలవు covers both leave and a holiday, which is exactly how a parent uses
  // the word when they ring the school.
  'portal.leave_requests.loading': 'మీ దరఖాస్తులు చూస్తున్నాం…',
  'portal.leave_requests.eyebrow': 'సెలవు & గైర్హాజరు',
  'portal.leave_requests.title': 'స్కూల్ నుంచి సెలవు',
  'portal.leave_requests.description': 'మీరు అడిగిన ప్రతి రోజు, స్కూల్ ఏం నిర్ణయించిందో.',
  'portal.leave_requests.stat_waiting': 'స్కూల్ నిర్ణయం కోసం',
  'portal.leave_requests.stat_approved': 'ఈ సంవత్సరం ఆమోదించినవి',
  'portal.leave_requests.stat_days': 'ఆమోదించిన రోజులు',
  'portal.leave_requests.list_title': 'దరఖాస్తులు',
  'portal.leave_requests.list_description':
    'పెండింగ్‌లో ఉన్న దరఖాస్తును ఉపసంహరించుకోవచ్చు; స్కూల్ నిర్ణయించాక అది మారదు.',
  'portal.leave_requests.col_child': 'పిల్లలు',
  'portal.leave_requests.col_days': 'రోజులు',
  'portal.leave_requests.col_reason': 'కారణం',
  'portal.leave_requests.col_decision': 'నిర్ణయం',
  'portal.leave_requests.empty': 'మీరు ఏ సెలవూ అడగలేదు.',
  'portal.leave_requests.applied_on': '{date}న దరఖాస్తు',
  'portal.leave_requests.half_day': 'అర్ధ రోజు',
  'portal.leave_requests.days_one': '{count} రోజు',
  'portal.leave_requests.days_many': '{count} రోజులు',
  'portal.leave_requests.decided_by': '{name} గారు',
  'portal.leave_requests.withdraw': 'ఉపసంహరించండి',
  'portal.leave_requests.withdraw_question': 'ఈ దరఖాస్తు స్కూల్‌కు ఇక కనిపించదు.',
  'portal.leave_requests.form_title': 'సెలవు కోసం అడగండి',
  'portal.leave_requests.form_description':
    'క్లాస్ టీచర్ నిర్ణయిస్తారు. కారణం చెప్పండి — కారణం లేని దరఖాస్తు సాధారణంగా తిరిగి వస్తుంది.',
  'portal.leave_requests.field_child': 'పిల్లలు',
  'portal.leave_requests.choose_child': 'పిల్లలను ఎంచుకోండి',
  'portal.leave_requests.field_first_day': 'సెలవు మొదటి రోజు',
  'portal.leave_requests.field_last_day': 'సెలవు చివరి రోజు',
  'portal.leave_requests.field_last_day_hint': 'ఒక్క రోజైతే ఖాళీగా వదిలేయండి.',
  'portal.leave_requests.field_half_day': 'అర్ధ రోజు',
  'portal.leave_requests.half_day_label': 'సగం రోజు మాత్రమే',
  'portal.leave_requests.half_day_hint':
    'అర్ధ రోజు కూడా ఒక రోజే — స్కూల్ దాన్ని 0.5గా లెక్కిస్తుంది.',
  'portal.leave_requests.field_reason': 'కారణం',
  // reason_placeholder names Warangal and is left to fall back to English: a
  // place name is not translated.
  'portal.leave_requests.sending': 'పంపుతున్నాం…',
  'portal.leave_requests.action_send': 'స్కూల్‌కు పంపండి',
  'portal.leave_requests.sent_ok': 'పంపాం. కింది జాబితాలో కనిపిస్తుంది.',

  // --- portal / ReportAbsence.tsx ----------------------------------------
  'portal.report_absence.loading': 'మీ పిల్లలను వెతుకుతున్నాం…',
  'portal.report_absence.eyebrow': 'హాజరు',
  'portal.report_absence.title': 'గైర్హాజరు తెలియజేయండి',
  'portal.report_absence.description':
    'మీ పిల్లలు రావడం లేదని స్కూల్‌కు చెప్పండి. ఇది వెంటనే క్లాస్ టీచర్‌కు చేరుతుంది.',
  'portal.report_absence.form_title': 'రావడం లేదు',
  'portal.report_absence.form_description':
    'ఈ రోజుకు, లేదా గత వారంలో మీరు ఇంకా చెప్పని రోజుకు. ముందే ఒక రోజు సెలవు కావాలంటే సెలవు కోసం దరఖాస్తు చేసుకోండి.',
  'portal.report_absence.field_child': 'పిల్లలు',
  'portal.report_absence.choose_child': 'పిల్లలను ఎంచుకోండి',
  'portal.report_absence.field_why': 'ఎందుకు',
  // Only the label a parent reads is translated; the value posted to the
  // server is still the English string, which the component holds separately.
  'portal.report_absence.reason_fever': 'జ్వరం',
  'portal.report_absence.reason_cold': 'జలుబు, దగ్గు',
  'portal.report_absence.reason_stomach': 'కడుపు నొప్పి',
  'portal.report_absence.reason_doctor': 'డాక్టర్ అపాయింట్‌మెంట్',
  'portal.report_absence.reason_family': 'ఇంట్లో అత్యవసరం',
  'portal.report_absence.reason_other': 'ఇతరత్రా',
  'portal.report_absence.field_day': 'ఏ రోజు',
  'portal.report_absence.field_day_hint': 'ఈ రోజు అయితే ఖాళీగా వదిలేయండి.',
  'portal.report_absence.field_detail': 'ఇంకేమైనా',
  'portal.report_absence.field_detail_other': 'ఏం జరిగిందో చెప్పండి',
  'portal.report_absence.detail_placeholder': 'నిన్న రాత్రి నుంచి జ్వరం ఉంది',
  'portal.report_absence.sending': 'స్కూల్‌కు చెబుతున్నాం…',
  'portal.report_absence.action_tell': 'స్కూల్‌కు చెప్పండి',
  'portal.report_absence.sent_ok': 'క్లాస్ టీచర్‌కు చేరింది.',
  'portal.report_absence.list_title': 'ఇప్పటికే తెలిపినవి',
  'portal.report_absence.list_description': 'స్కూల్‌కు తెలిసిన రోజులు.',
  'portal.report_absence.empty_title': 'పెండింగ్‌లో ఏమీ లేదు',
  'portal.report_absence.empty_body':
    'స్కూల్ దగ్గర పెండింగ్‌లో ఉన్న గైర్హాజరు ఏదీ మీరు తెలియజేయలేదు.',

  // --- portal / Gallery.tsx ----------------------------------------------
  'portal.gallery.loading': 'గ్యాలరీ చూస్తున్నాం…',
  'portal.gallery.eyebrow': 'స్కూల్ జీవితం',
  'portal.gallery.title': 'ఫోటోలు & వీడియోలు',
  'portal.gallery.description': 'క్రీడా దినోత్సవం, వార్షికోత్సవం, స్కూల్ పంచుకున్న మిగతావన్నీ.',
  'portal.gallery.album_fallback': 'ఆల్బమ్',
  'portal.gallery.action_all_albums': 'అన్ని ఆల్బమ్‌లు',
  'portal.gallery.album_loading': 'ఆల్బమ్ తెరుస్తున్నాం…',
  'portal.gallery.album_empty_title': 'ఇంకా ఏమీ ప్రచురించలేదు',
  'portal.gallery.album_empty_body': 'ఈ కార్యక్రమం ఫోటోలను స్కూల్ ఇంకా విడుదల చేయలేదు.',
  'portal.gallery.media_title': 'మీడియా',
  'portal.gallery.media_description': 'స్కూల్ కుటుంబాలకు ప్రచురించిన {count} అంశాలు.',
  'portal.gallery.media_meta': '{name} · {size} · {date}న ప్రచురించారు',
  'portal.gallery.stat_albums': 'ఆల్బమ్‌లు',
  'portal.gallery.stat_photographs': 'ఫోటోలు',
  'portal.gallery.stat_videos': 'వీడియోలు',
  'portal.gallery.field_child': 'పిల్లలు',
  'portal.gallery.field_child_hint': 'ఒక తరగతి ఆల్బమ్ ఆ తరగతికి మాత్రమే కనిపిస్తుంది.',
  'portal.gallery.all_children': 'నా పిల్లలందరూ',
  'portal.gallery.empty_title': 'ఇంకా ఆల్బమ్‌లు లేవు',
  'portal.gallery.empty_body':
    'ఒక కార్యక్రమం ఫోటోలను స్కూల్ ప్రచురించినప్పుడు ఇక్కడ కనిపిస్తాయి.',
  'portal.gallery.class_label': '{section} తరగతి',
  'portal.gallery.counts': '{photos} ఫోటోలు · {videos} వీడియోలు',
  'portal.gallery.action_open': 'తెరవండి',

  // --- portal / IEPGoals.tsx --------------------------------------------
  'portal.iep_goals.loading': 'సహాయ ప్రణాళిక చూస్తున్నాం…',
  'portal.iep_goals.eyebrow': 'చదువు',
  'portal.iep_goals.title': 'సహాయ ప్రణాళిక & లక్ష్యాలు',
  'portal.iep_goals.description': 'స్కూల్ చేస్తామని ఒప్పుకున్నది, ప్రతి లక్ష్యం ఎంతవరకు వచ్చిందో.',
  'portal.iep_goals.field_child': 'పిల్లలు',
  'portal.iep_goals.choose_child_title': 'పిల్లలను ఎంచుకోండి',
  'portal.iep_goals.choose_child_body':
    'సహాయ ప్రణాళిక ఒక్క పిల్లవాడి కోసమే ఒప్పుకుంటారు, కాబట్టి ఈ స్క్రీన్‌కు ఎవరిదో తెలియాలి.',
  'portal.iep_goals.no_plan_title': 'సహాయ ప్రణాళిక లేదు',
  'portal.iep_goals.no_plan_body':
    'మీ పిల్లలకు ఫైల్‌లో సహాయ ప్రణాళిక లేదు. ఉండాలని మీరు అనుకుంటే క్లాస్ టీచర్‌తో మాట్లాడండి.',
  'portal.iep_goals.stat_goals': 'లక్ష్యాలు',
  'portal.iep_goals.stat_met': 'చేరుకున్నవి',
  'portal.iep_goals.stat_average_progress': 'సగటు ప్రగతి',
  'portal.iep_goals.stat_average_hint': 'ఇంకా ఏమీ కొలవలేదు',
  'portal.iep_goals.plan_title': 'ప్రణాళిక',
  'portal.iep_goals.plan_next_review': 'తదుపరి సమీక్ష {date}.',
  'portal.iep_goals.plan_no_review': 'సమీక్ష తేదీ పెట్టలేదు.',
  'portal.iep_goals.plan_concern': 'మేము దేనిపై పనిచేస్తున్నాం',
  'portal.iep_goals.plan_accommodations': 'తరగతి గదిలో',
  'portal.iep_goals.plan_exam_concession': 'పరీక్షల్లో',
  'portal.iep_goals.plan_external_support': 'స్కూల్ వెలుపల',
  'portal.iep_goals.goals_title': 'లక్ష్యాలు',
  'portal.iep_goals.goals_description':
    'మీ పిల్లలు ఎక్కడ మొదలుపెట్టారో, ప్రణాళిక ఎక్కడికి చేరాలనుకుంటుందో — వాటి మధ్య చివరిగా కొలిచినది ప్రతి బార్.',
  'portal.iep_goals.no_goals_title': 'ఇంకా లక్ష్యాలు లేవు',
  'portal.iep_goals.no_goals_body':
    'ప్రణాళిక ఉంది కానీ దానికి కొలవగల లక్ష్యాలు ఏవీ రాయలేదు.',
  'portal.iep_goals.aiming_for': ' · {date} కల్లా చేరాలని',
  'portal.iep_goals.started_at': '{value} వద్ద మొదలు',
  'portal.iep_goals.now': 'ఇప్పుడు {value}',
  'portal.iep_goals.target': 'లక్ష్యం {value}',
  'portal.iep_goals.progress_of_the_way': '{percent}% పూర్తి',
  'portal.iep_goals.lower_is_better': ' — ఈ లక్ష్యానికి తక్కువ సంఖ్య మంచిది',
  'portal.iep_goals.recorded_in_words':
    'సంఖ్యల్లో కాకుండా మాటల్లో నమోదు చేశారు — కింది గమనికలు చూడండి.',
  'portal.iep_goals.not_measured': 'ఇంకా కొలవలేదు.',
  'portal.iep_goals.footnote':
    'కొన్ని లక్ష్యాలు నమోదై ఇక్కడ కనిపించకపోవచ్చు — వైద్య సిఫారసు నుంచి రాసిన లక్ష్యాన్ని స్కూల్ చూపకపోవచ్చు. మీరు ఆశించినది ఏదైనా కనిపించకపోతే క్లాస్ టీచర్‌ను అడగండి.',

  // --- portal / EventPasses.tsx -----------------------------------------
  'portal.event_passes.loading': 'మీ పాస్‌లు చూస్తున్నాం…',
  'portal.event_passes.eyebrow': 'స్కూల్ జీవితం',
  'portal.event_passes.title': 'కార్యక్రమ సీట్లు',
  'portal.event_passes.description':
    'స్కూల్ కార్యక్రమానికి మీ సీట్లు తీసుకుని, ద్వారం దగ్గర నంబర్ చూపండి.',
  'portal.event_passes.action_print': 'పాస్‌లు ప్రింట్ చేయండి',
  'portal.event_passes.stat_passes': 'వాడవలసిన పాస్‌లు',
  'portal.event_passes.stat_seats': 'తీసుకున్న సీట్లు',
  'portal.event_passes.stat_attended': 'హాజరైన కార్యక్రమాలు',
  'portal.event_passes.claim_title': 'సీట్లు తీసుకోండి',
  'portal.event_passes.claim_description': 'కుటుంబాలు అడిగిన వరుసలో సీట్లు ఇస్తారు.',
  'portal.event_passes.field_child': 'పిల్లలు',
  'portal.event_passes.child_placeholder': 'ఏ పిల్లలు…',
  'portal.event_passes.field_event': 'కార్యక్రమం',
  'portal.event_passes.event_placeholder': 'కార్యక్రమం ఎంచుకోండి…',
  'portal.event_passes.event_placeholder_none': 'తెరిచిన కార్యక్రమాలు లేవు',
  'portal.event_passes.field_seats': 'సీట్లు',
  'portal.event_passes.field_seats_hint': 'మీలో ఎంతమంది వస్తున్నారు.',
  'portal.event_passes.claim_ok': 'సీట్లు ఖరారయ్యాయి.',
  'portal.event_passes.action_claim': 'సీట్లు తీసుకోండి',
  'portal.event_passes.empty_title': 'ఇంకా పాస్‌లు లేవు',
  'portal.event_passes.empty_body': 'పైన సీట్లు తీసుకుంటే పాస్ ఇక్కడ కనిపిస్తుంది.',
  'portal.event_passes.badge_withdrawn': 'ఉపసంహరించారు',
  'portal.event_passes.badge_admitted': 'అనుమతించారు',
  'portal.event_passes.badge_valid': 'చెల్లుతుంది',
  'portal.event_passes.seats_count': '{count} సీట్లు',
  // Row and seat numbers are a record; only the words around them translate,
  // and in Telugu those words follow the number.
  'portal.event_passes.row_seat': '{row} వరుస, {seat} సీటు',
  'portal.event_passes.row_seats': '{row} వరుస, {from}–{to} సీట్లు',
  'portal.event_passes.show_code': 'ఈ నంబర్ ద్వారం దగ్గర చూపండి.',

  // --- portal / Concerns.tsx --------------------------------------------
  'portal.concerns.loading': 'మీ ఫిర్యాదులు చూస్తున్నాం…',
  'portal.concerns.eyebrow': 'సందేశాలు',
  'portal.concerns.title': 'ఫిర్యాదులు',
  'portal.concerns.description':
    'ఏదైనా తప్పు జరిగితే, స్కూల్ సమాధానం ఇవ్వగలిగేలా రాతపూర్వకంగా.',
  'portal.concerns.stat_open': 'పరిష్కారం కానివి',
  'portal.concerns.stat_answered': 'సమాధానం వచ్చినవి',
  'portal.concerns.stat_longest': 'ఎక్కువ కాలం ఎదురుచూపు',
  'portal.concerns.days': '{count} రోజులు',
  'portal.concerns.raise_title': 'ఫిర్యాదు చేయండి',
  'portal.concerns.raise_description':
    'ఏం జరిగిందో, ఎప్పుడు జరిగిందో చెప్పండి. ఎంత అత్యవసరమో ఆఫీసు నిర్ణయిస్తుంది, కాబట్టి అత్యవసరమని గుర్తు పెట్టడం కంటే జరిగినది చెప్పండి.',
  'portal.concerns.field_category': 'ఇది దేని గురించి',
  'portal.concerns.category_academic': 'బోధన, చదువు',
  'portal.concerns.category_fees': 'ఫీజు, బిల్లులు',
  'portal.concerns.category_transport': 'బస్సు, రవాణా',
  'portal.concerns.category_hostel': 'హాస్టల్',
  'portal.concerns.category_discipline': 'ప్రవర్తన, క్రమశిక్షణ',
  'portal.concerns.category_safety': 'భద్రత',
  'portal.concerns.category_staff': 'ఒక సిబ్బంది',
  'portal.concerns.category_facilities': 'భవనం, సౌకర్యాలు',
  'portal.concerns.category_other': 'ఇంకేదైనా',
  'portal.concerns.field_child': 'ఏ పిల్లలు',
  'portal.concerns.field_child_hint': 'ఒక పిల్లవాడి గురించి కాకపోతే ఖాళీగా వదిలేయండి.',
  'portal.concerns.child_placeholder': 'ఒక పిల్లవాడి గురించి కాదు',
  'portal.concerns.field_priority': 'ఎంత అత్యవసరం',
  'portal.concerns.priority_low': 'మీకు వీలైనప్పుడు',
  'portal.concerns.priority_normal': 'సాధారణం',
  'portal.concerns.priority_high': 'త్వరగా చూడాలి',
  'portal.concerns.field_subject': 'ఒక్క వాక్యంలో',
  'portal.concerns.subject_placeholder': 'ఈ వారం అంతా బస్సు 30 నిమిషాలు ఆలస్యం',
  'portal.concerns.field_body': 'ఏం జరిగింది',
  'portal.concerns.body_placeholder': 'తేదీలు, సమయాలు, మీరు ఇప్పటికే ఎవరితో మాట్లాడారు.',
  'portal.concerns.sending': 'పంపుతున్నాం…',
  'portal.concerns.action_send': 'పంపండి',
  'portal.concerns.raise_ok': 'ఫిర్యాదు చేశారు. ఆఫీసు ఇప్పుడు దీన్ని చూడగలదు.',
  'portal.concerns.list_title': 'మీ ఫిర్యాదులు',
  'portal.concerns.list_description': 'మీవి మాత్రమే — కుటుంబంలో వేరెవరైనా చేసినవి కాదు.',
  'portal.concerns.empty_title': 'ఏమీ చేయలేదు',
  'portal.concerns.empty_body':
    'మీరు ఏదైనా ఫిర్యాదు చేస్తే, స్కూల్ సమాధానంతో పాటు ఇక్కడే ఉంటుంది.',
  'portal.concerns.raised_on': ' · {date}న చేశారు',
  'portal.concerns.assigned_to': ' · {name} గారి దగ్గర',
  'portal.concerns.school_says': 'స్కూల్ చెప్పినది: ',

  // --- portal / TeacherMessages.tsx --------------------------------------
  'portal.teacher_messages.loading': 'మీ పిల్లలను వెతుకుతున్నాం…',
  'portal.teacher_messages.eyebrow': 'సందేశాలు',
  'portal.teacher_messages.title': 'మీ పిల్లల ఉపాధ్యాయులు',
  'portal.teacher_messages.description':
    'వారికి పాఠాలు చెప్పేవారితో నేరుగా మాట్లాడండి. స్కూల్ మొత్తానికి తెలియవలసినది ఏదైనా ఉంటే దాన్ని ఫిర్యాదుగా పెట్టండి.',
  'portal.teacher_messages.picker_title': 'మీరు ఎవరికి రాస్తున్నారు',
  'portal.teacher_messages.field_child': 'పిల్లలు',
  'portal.teacher_messages.child_placeholder': 'పిల్లలను ఎంచుకోండి',
  'portal.teacher_messages.field_teacher': 'ఉపాధ్యాయులు',
  'portal.teacher_messages.teacher_placeholder': 'ఉపాధ్యాయులను ఎంచుకోండి',
  'portal.teacher_messages.teacher_placeholder_none': 'ఇంకా ఉపాధ్యాయుల జాబితా లేదు',
  'portal.teacher_messages.option_class_teacher': '{name} — క్లాస్ టీచర్',
  'portal.teacher_messages.option_unread': ' · {count} చదవనివి',
  'portal.teacher_messages.empty_child_title': 'పిల్లలను ఎంచుకోండి',
  'portal.teacher_messages.empty_child_body': 'వారి ఉపాధ్యాయులు ఇక్కడ కనిపిస్తారు.',
  'portal.teacher_messages.empty_teachers_title': 'ఇంకా రాయడానికి ఉపాధ్యాయులు లేరు',
  'portal.teacher_messages.empty_teachers_body':
    'మీ పిల్లల తరగతికి టైమ్‌టేబుల్ పెట్టాక, వారి ఉపాధ్యాయులు ఇక్కడ కనిపిస్తారు.',
  'portal.teacher_messages.thread_title': 'సంభాషణ',
  'portal.teacher_messages.thread_class_teacher': 'క్లాస్ టీచర్ — రోజంతా తెలిసిన వ్యక్తి.',
  'portal.teacher_messages.thread_teaches': '{subject} బోధిస్తారు.',
  'portal.teacher_messages.thread_loading': 'సంభాషణ తెరుస్తున్నాం…',
  'portal.teacher_messages.empty_thread_title': 'ఇంకా ఏమీ చెప్పలేదు',
  'portal.teacher_messages.empty_thread_body': 'కింద మొదటి సందేశం రాయండి.',
  'portal.teacher_messages.sender_you': 'మీరు',
  'portal.teacher_messages.not_read': ' · ఇంకా చదవలేదు',
  // draft_placeholder names a child (Ravi) and is left to fall back to
  // English: a person's name is not translated.
  'portal.teacher_messages.sending': 'పంపుతున్నాం…',
  'portal.teacher_messages.action_send': 'పంపండి',
  'portal.teacher_messages.badge_to': '{name} గారికి',

  // --- portal / Forum.tsx -----------------------------------------------
  // The parents' class board, translated alongside the rest of the portal: a
  // forum left in English while its neighbours are Telugu is the worst of
  // both, because it is exactly the screen parents talk to each other on.
  'portal.forum.loading': 'మీ తరగతి బోర్డు తెరుస్తున్నాం…',
  'portal.forum.loading_thread': 'థ్రెడ్ తెరుస్తున్నాం…',
  'portal.forum.eyebrow': 'సందేశాలు',
  'portal.forum.title': 'తరగతి తల్లిదండ్రుల ఫోరం',
  'portal.forum.description':
    'ఒక తరగతి తల్లిదండ్రుల మధ్య సమన్వయం కోసం — విహారయాత్ర, కార్యక్రమం, ఎవరు తీసుకెళ్తారు.',
  'portal.forum.stat_threads': 'థ్రెడ్‌లు',
  'portal.forum.stat_mine': 'మీరు మొదలుపెట్టినవి',
  'portal.forum.stat_class': 'తరగతి',
  'portal.forum.stat_class_all': 'మీ తరగతులన్నీ',
  'portal.forum.picker_title': 'ఏ తరగతి',
  'portal.forum.picker_description':
    'ఒక్కో పిల్లవాడికి ఒక్కో బోర్డు. మీ పిల్లలు ఉన్న తరగతుల బోర్డులను మాత్రమే మీరు చదవగలరు, ఇతరవి కాదు.',
  'portal.forum.picker_label': 'తరగతి బోర్డు',
  'portal.forum.picker_all': 'మీ తరగతులన్నీ',
  'portal.forum.no_board_title': 'ఇంకా తరగతి బోర్డు లేదు',
  'portal.forum.no_board_body':
    'మీ పిల్లల ప్రవేశం రికార్డులో నమోదైన తర్వాత బోర్డు కనిపిస్తుంది. ఇది తప్పు అనిపిస్తే, ఆఫీసు అడ్మిషన్‌ను సరిచూడగలదు.',
  'portal.forum.threads_title': 'థ్రెడ్‌లు',
  'portal.forum.threads_description': 'ముందుగా పిన్ చేసిన నోటీసులు, ఆ తర్వాత చర్చలో ఉన్నవి.',
  'portal.forum.threads_empty': 'ఈ బోర్డులో ఇంకా ఎవరూ థ్రెడ్ మొదలుపెట్టలేదు.',
  'portal.forum.col_thread': 'థ్రెడ్',
  'portal.forum.col_started_by': 'మొదలుపెట్టినవారు',
  'portal.forum.col_replies': 'జవాబులు',
  'portal.forum.col_last': 'చివరి కదలిక',
  'portal.forum.action_open': 'తెరవండి',
  'portal.forum.action_close': 'మూసివేయండి',
  'portal.forum.action_post': 'బోర్డులో పెట్టండి',
  'portal.forum.action_reply': 'జవాబు ఇవ్వండి',
  'portal.forum.action_report': 'ఈ థ్రెడ్‌పై ఫిర్యాదు చేయండి',
  'portal.forum.posted': 'పెట్టారు.',
  'portal.forum.badge_mine': 'మీరు',
  'portal.forum.badge_staff': 'స్కూల్',
  'portal.forum.badge_open': 'తెరిచి ఉంది',
  'portal.forum.badge_locked': 'మూసి ఉంది',
  'portal.forum.compose_title': 'థ్రెడ్ మొదలుపెట్టండి',
  'portal.forum.compose_description':
    'ఈ తరగతిలోని మిగతా తల్లిదండ్రులు తెలుసుకోవలసినది, లేదా కలిసి నిర్ణయించవలసినది.',
  'portal.forum.field_child': 'ఏ పిల్లలు',
  'portal.forum.field_child_hint': 'థ్రెడ్ ఏ తరగతి బోర్డుకు వెళ్తుందో ఇది నిర్ణయిస్తుంది.',
  'portal.forum.field_child_placeholder': 'పిల్లలను ఎంచుకోండి',
  'portal.forum.field_category': 'ఇది దేని గురించి',
  'portal.forum.field_title': 'ఒక్క వాక్యంలో',
  'portal.forum.field_title_placeholder': 'శుక్రవారం మ్యూజియానికి వాహన సదుపాయం',
  'portal.forum.field_body': 'మీరు చెప్పాలనుకుంటున్నది',
  'portal.forum.named_notice':
    'మీరు ఇక్కడ పెట్టే ప్రతిదానిపై మీ పేరు, పిల్లలతో మీ సంబంధం కనిపిస్తాయి. పేరు లేకుండా పెట్టడం కుదరదు.',
  'portal.forum.grievance_notice':
    'ఏదైనా తప్పు జరిగితే, దాన్ని ఫిర్యాదుల కింద పెట్టండి. ఆ మార్గం గోప్యమైనది, ట్రాక్ అవుతుంది, గడువులోపు సమాధానం వస్తుంది; ఈ బోర్డు అలా కాదు.',
  // Telugu is verb-final, so the three values land before the verb and in a
  // different order from English: when, then who, then "started it".
  'portal.forum.thread_by': '{at}న {name} ({relation}) మొదలుపెట్టారు',
  'portal.forum.thread_missing': 'ఆ థ్రెడ్‌ను తెరవలేకపోయాం.',
  'portal.forum.no_replies': 'ఇంకా జవాబులు లేవు.',
  'portal.forum.reply_placeholder': 'జవాబు రాయండి…',
  'portal.forum.pick_child_first': 'జవాబు ఇచ్చే ముందు ఇది ఏ పిల్లల గురించో ఎంచుకోండి.',
  'portal.forum.locked_because': 'కొత్త జవాబులకు మూసివేశారు: {reason}',
  'portal.forum.converted_notice':
    'స్కూల్ దీన్ని ఫిర్యాదుల జాబితాలోకి మార్చింది, అక్కడ ఇది ట్రాక్ అవుతుంది, సమాధానం వస్తుంది. ఫిర్యాదుల కింద దీన్ని అనుసరించవచ్చు.',
  'portal.forum.taken_down': 'తొలగించారు: {reason}',
  'portal.forum.report_explainer':
    'సిబ్బంది చదవవలసినది ఏదైనా ఉంటే ఫిర్యాదు చేయండి. ఫిర్యాదు చేస్తే అది దాగదు — ఒక వ్యక్తి నిర్ణయిస్తారు.',
  'portal.forum.report_label': 'దీనిలో ఏం తప్పు ఉంది',
  'portal.forum.report_placeholder': 'దీనిలో ఏం తప్పు ఉంది',
  'portal.forum.report_confirm': 'ఫిర్యాదు చేయండి',
  'portal.forum.report_question': 'ఈ థ్రెడ్‌ను, మీరు చెప్పిన కారణాన్ని ఒక సిబ్బంది చదువుతారు.',
  'portal.forum.reported': 'ఫిర్యాదు చేశారు. ఒక సిబ్బంది దీన్ని చదువుతారు.',
  // The board's own categories. Not server data: this repository chose these
  // words, so they are translated like any other label it shows.
  'portal.forum.category_general': 'సాధారణం',
  'portal.forum.category_event': 'ఒక కార్యక్రమం',
  'portal.forum.category_trip': 'ఒక విహారయాత్ర',
  'portal.forum.category_volunteering': 'స్వచ్ఛందంగా సాయం',
  'portal.forum.category_logistics': 'రాకపోకలు',
  'portal.forum.category_lost_found': 'పోయినవి, దొరికినవి',
  'portal.forum.category_question': 'ఒక ప్రశ్న',

  // --- common (shared by more than one screen) ---------------------------
  'common.cancel': 'రద్దు',

  // --- display preferences ----------------------------------------------
  // These matter more than their length suggests: a parent who lands in Telugu
  // by accident finds their way back through this screen, so it has to read in
  // Telugu too.
  'preferences.language.label': 'భాష',
  'preferences.language.hint':
    'ఈ పరికరంలో మాత్రమే కాదు, మీరు సైన్ ఇన్ చేసిన ప్రతిచోటా వర్తిస్తుంది.',
  // Not a translation, and deliberately so. A language is named in itself in
  // every catalogue — the same reason LOCALES carries an endonym. Somebody
  // hunting for a language they read is not helped by seeing it named in one
  // they do not.
  'preferences.language.name_en': 'English',
  'preferences.contrast.label': 'కాంట్రాస్ట్',
  'preferences.contrast.checkbox': 'ఎక్కువ కాంట్రాస్ట్',
  'preferences.contrast.hint':
    'అక్షరాలు, అంచులు మరింత స్పష్టంగా. మీరు ఆన్ చేస్తే తప్ప ఆఫ్‌లోనే ఉంటుంది.',
}

export default te
