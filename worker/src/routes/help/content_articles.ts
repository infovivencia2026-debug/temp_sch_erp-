import { registerDefaults } from './content'

/* The shipped help articles and tips. Each article describes a flow that was
   read in the code before it was written down, and names the screen and the
   button as they are labelled. The desk can edit, hide or add to them
   (Support > Help content); an edit replaces the article with the same key.

   `roles` empty means everyone. `topic` is a request category key, which is
   how a topic page finds its likely fixes. `route`, when present, is the
   screen the article is about; the Help Centre offers Open for it.
   Articles are English only for now: no Telugu article ships until a Telugu
   speaker has read it (docs/owner-requests.md, waiting on the owner). */

export interface HelpArticle {
  key: string
  title: string
  topic: string
  roles: string[]
  /** Plain sentences; each paragraph is a line. A line starting "1." is a step. */
  body: string
  route?: string
  /** The control on that screen "Show me" rings (data-help-anchor). */
  anchor?: string
  /** Words people type that are not in the title. */
  keywords?: string
}

export interface HelpTip {
  key: string
  title: string
  title_te?: string
  body: string
  body_te?: string
  roles: string[]
  /** Only on a desktop (a keyboard shortcut), only on a phone, or both. */
  device?: 'desktop' | 'phone'
  /** Shown from this release on; a new release's tips appear as new. */
  since: string
  sort: number
}

const ADMIN = ['institution_admin', 'super_admin']

export const DEFAULT_ARTICLES: HelpArticle[] = [
  { key: 'change_password', anchor: 'change-password', title: 'Change your password', topic: 'sign_in', roles: [], route: '/account', keywords: 'password reset new login',
    body: [
      'Open your account: the person icon at the top right, or Settings, then Account, then My profile.',
      '1. In Login password, type your current password.',
      '2. Type the new password twice. It must be at least 12 characters.',
      '3. Press Change password.',
      'Everywhere else you are signed in is signed out, so sign in again on your other devices with the new password.',
    ].join('\n') },
  { key: 'sign_out_devices', anchor: 'sign-out-others', title: 'Sign out a phone or computer you no longer use', topic: 'sign_in', roles: [], route: '/account', keywords: 'session device lost phone',
    body: [
      'Open your account (the person icon at the top right) and find Where you are signed in. It lists every device holding a live sign-in.',
      '1. Press Sign out other devices and confirm.',
      'Only this device stays signed in. If a device on the list is not yours, change your password as well.',
    ].join('\n') },
  { key: 'find_screen', anchor: 'search', title: 'Find a screen by its name', topic: 'screen', roles: [], keywords: 'search where menu missing',
    body: [
      'Press the search box at the top of the page, or Ctrl K on Windows and Cmd K on a Mac, and type part of the screen\'s name. A misspelt word still finds it.',
      'If the screen is not in the results, your role does not include it. Ask your school office to give your account that screen; it is set under Staff, Logins and access.',
    ].join('\n') },
  { key: 'error_reference', title: 'A message says "Ref:" and a code', topic: 'other', roles: [], keywords: 'error ref code something went wrong',
    body: [
      'The code is a reference to the exact error the server met, for example Ref: K7Q2X9. It is kept for 14 days.',
      '1. Press Copy beside the code.',
      '2. Open Help, then Report a problem. The code of the last error is already filled in.',
      'Whoever answers can then see which screen failed and when, without asking you to describe it again.',
    ].join('\n') },
  { key: 'how_requests_work', title: 'Who answers a request for help', topic: 'other', roles: [], keywords: 'request ticket reply status reopen',
    body: [
      'A request you send from Help goes to your school\'s helpdesk. When they reply, the bell at the top shows it and the request opens under Your requests.',
      'If the school cannot solve it, they pass it to the software\'s support team without your name or your child\'s, and answer you when it is fixed.',
      'When it is solved, press the thumbs up if the answer worked. If it did not, press the thumbs down and then Reopen within 14 days.',
    ].join('\n') },
  { key: 'concern_not_help', anchor: 'concerns-link', title: 'A complaint about something at school', topic: 'other', roles: [], route: '/concerns', keywords: 'complaint grievance teacher concern',
    body: [
      'Help is for problems with the app. A complaint about a class, a fee decision, transport or a member of staff is a concern, and it goes to the school office or to HR.',
      'Open your account page (the person icon at the top right) and press Open my concerns. Choose what it is about, write what happened and send it. Every update shows there.',
    ].join('\n') },
  { key: 'me_too', title: 'Someone has already reported the same problem', topic: 'other', roles: [], keywords: 'me too same problem duplicate',
    body: [
      'When you report a problem on a screen that someone else in your school has already reported, Help says so before you send yours.',
      'Press Me too instead of writing it again. The helpdesk sees how many people it affects, and you are told when it is solved.',
    ].join('\n') },
  { key: 'desk_escalate', title: 'Pass a request to XULO support', topic: 'other', roles: ADMIN, route: '/go/help/helpdesk', anchor: 'helpdesk-list', keywords: 'escalate vendor support helpdesk',
    body: [
      'Open Help, then Helpdesk, and open the request.',
      '1. Press Pass to XULO support.',
      '2. Write a summary of the fault in your own words. Name the screen and what goes wrong, but no child: write "a student in Class 5 A", not a name or an admission number.',
      '3. Tick that the summary names no child, then press Send to XULO support.',
      'The family\'s own words, their screenshot and their name stay in the school. When XULO support replies, the bell tells you and the reply shows under the request.',
    ].join('\n') },
  { key: 'desk_reply', title: 'Answer a request on the Helpdesk', topic: 'other', roles: ADMIN, route: '/go/help/helpdesk', anchor: 'helpdesk-list', keywords: 'reply note helpdesk',
    body: [
      'Open Help, then Helpdesk. Unassigned is what nobody has picked up; Overdue is past the time the school promised.',
      '1. Open a request and press Take to make it yours.',
      '2. Write a reply and press Send. Tick Note for the office only to keep it out of the family\'s view.',
      '3. When it is fixed, press Mark solved and say what fixed it. The person who asked is told at once.',
    ].join('\n') },
]

export const DEFAULT_TIPS: HelpTip[] = [
  { key: 'help_shortcut', title: 'Press ? for Help', title_te: 'సహాయం కోసం ? నొక్కండి', device: 'desktop', since: '2026-10', sort: 10, roles: [],
    body: 'On a computer, press the question mark key on any screen to open Help.', body_te: 'కంప్యూటర్‌లో ఏ స్క్రీన్‌లోనైనా ప్రశ్నార్థకం (?) కీ నొక్కితే సహాయం తెరుచుకుంటుంది.' },
  { key: 'error_refs', title: 'Errors now carry a code', title_te: 'లోపాలకు ఇప్పుడు ఒక కోడ్ ఉంటుంది', since: '2026-10', sort: 20, roles: [],
    body: 'When something fails, the message ends with Ref: and six letters. Send it with your request and nobody has to ask what happened.',
    body_te: 'ఏదైనా విఫలమైతే, సందేశం చివర Ref: మరియు ఆరు అక్షరాలు ఉంటాయి. మీ అభ్యర్థనతో దాన్ని పంపండి.' },
  { key: 'me_too_tip', title: 'Already reported? Press Me too', title_te: 'ఇప్పటికే తెలియజేశారా? Me too నొక్కండి', since: '2026-10', sort: 30, roles: [],
    body: 'If others in your school reported the same problem, Help shows it before you write. One press adds you and you hear when it is fixed.',
    body_te: 'మీ పాఠశాలలో ఇతరులు అదే సమస్యను తెలియజేస్తే, మీరు రాసే ముందే సహాయం దాన్ని చూపిస్తుంది. ఒక్క నొక్కుతో మీరు చేరతారు, సరిచేసినప్పుడు మీకు తెలుస్తుంది.' },
  { key: 'helpdesk_tip', title: 'Requests from your school come to the Helpdesk', since: '2026-10', sort: 40, roles: ADMIN,
    body: 'Parents and staff now ask for help in the app. Their requests wait for you under Help, Helpdesk; pass one to XULO support only when the school cannot solve it.' },
]

registerDefaults('article', DEFAULT_ARTICLES)
registerDefaults('tip', DEFAULT_TIPS)
