# Content rating (IARC questionnaire) — answers for EDU CLOUD

Play Console → Policy → App content → **Content ratings** → Start questionnaire.
Email address: `[SUPPORT_EMAIL]`. **Category: "Utility, Productivity, Communication, or Other"**
(not Reference/News, not Social — the forum is a school-moderated feature, not the app's purpose).

Answer every question truthfully as below. Expected result: **Everyone / 3+ / PEGI 3** (all boards),
possibly with an "Users Interact" / "Shares Info" interactive element flag because of messaging.

## Violence, sexuality, language, controlled substances
| Question | Answer |
|---|---|
| Does the app contain violence, blood, gore? | **No** |
| Sexual content or nudity? | **No** |
| Profanity or crude humour? | **No** |
| References to drugs, alcohol, tobacco? | **No** |
| Gambling (simulated or real)? | **No** |
| Frightening or horror content? | **No** |
| Content about or glorifying crime? | **No** |

## Interactive elements
| Question | Answer | Why |
|---|---|---|
| Does the app allow users to interact or exchange information with each other (chat, forum, comments)? | **Yes** | Parent ↔ school messaging; a school forum where the school enables it. |
| Is that interaction moderated? | **Yes** — by the school's staff, who can remove posts and suspend accounts; the interaction is restricted to members of one school. | Say this in the free-text box if offered. |
| Does the app share the user's current location with other users? | **No** | The parent app has no location permission. Bus positions come from the school's driver device, not from parents. |
| Does the app allow users to purchase digital goods? | **No** | School fees paid via UPI to the school are real-world services, not digital goods; wallet top-ups are recorded at the school office, not bought in-app. There is no in-app purchase flow. |
| Does the app share personal information (name, photo, contact) with third parties or other users? | **Yes, limited** — a user's name and photo are visible to the school and, on the forum, to other members of the same school. | Answer "Yes" to be safe; it produces a "Shares Info" descriptor, which is accurate. |
| Unrestricted internet access / web browser? | **No** — the WebView loads only the school portal's own host; other links open in the system browser. | |

## User-generated content (UGC) policy note
Because the forum/messaging exists, the Play UGC policy applies. Confirm before submission that the product provides, for UGC surfaces:
1. a way for users to **report** a post/message and for the school to act on it;
2. a way to **block** or restrict a user (school suspends the account);
3. in-app terms/rules for conduct (link to https://school-erp-cqj.pages.dev/terms §3).
If "report" is not visible in the forum UI today, add it before going to production.
