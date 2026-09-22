# EDU CLOUD — Google Play submission kit

**App:** EDU CLOUD (parent / school app) · **Package:** `com.schoolerp.parent` · **Project:** `mobile/apps/parent/`
**Portal it loads:** https://school-erp-cqj.pages.dev · **API:** Cloud Run, asia-south1

This folder holds everything needed to publish the Android app on Google Play:
the store-listing text, the graphics, the exact answers for every policy form,
the build/signing scripts, and the checklist of Play rules the app must meet.
Work through the checklist top to bottom.

```
playstore/
├── README.md                    ← this file: rules, sizes, step-by-step
├── listing/                     ← paste into Play Console → Store listing
│   ├── title.txt                (≤ 30 chars)
│   ├── short_description.txt    (≤ 80 chars)
│   ├── full_description.txt     (≤ 4000 chars)
│   └── whats_new.txt            (≤ 500 chars, per release)
├── assets/
│   ├── icon-512.png             ← 512×512 32-bit PNG, ≤ 1 MB  (READY)
│   ├── feature-graphic-1024x500.png ← 1024×500 PNG, ≤ 15 MB (READY)
│   └── screenshots/README.md    ← you must capture 2–8 real phone screenshots
├── data-safety.md               ← answers for the Data safety form
├── content-rating.md            ← answers for the IARC questionnaire
├── target-audience.md           ← Target audience & content / Families
├── app-access.md                ← reviewer login (fill in a demo parent)
└── build/
    ├── KEYSTORE.md              ← create the upload key (one time)
    ├── keystore.properties.example
    ├── build-aab.sh             ← Linux/macOS: builds app-release.aab
    └── build-aab.ps1            ← Windows PowerShell: same
```

---

## 0. Things you MUST fill in (search for `[` in this folder and in `web/public/*.html`)

| Placeholder | Where | Why Play needs it |
|---|---|---|
| `[OPERATOR LEGAL NAME]`, `[REGISTERED ADDRESS]` | privacy.html, terms.html, delete-account.html | Developer identity must match the Play developer account |
| `[SUPPORT_EMAIL]` | all three HTML pages, `listing/full_description.txt` | Play shows a support email on the listing; policy pages must have a contact |
| `[GRIEVANCE_EMAIL]`, `[NAME]` | privacy.html | DPDP Act grievance officer |
| `[REGION]` | privacy.html §5 | Where the Neon database lives |
| `[DD Month YYYY]` | privacy.html, terms.html | Effective date |
| Demo parent login | `app-access.md` | Review fails without one — the app has no public content |
| Screenshots | `assets/screenshots/` | Minimum 2 phone screenshots; the app cannot be listed without them |

The three legal pages are already live once deployed (push to `main`):
**https://school-erp-cqj.pages.dev/privacy** · **/terms** · **/delete-account**

---

## 1. Size limits (what "how many MB" means on Play)

| Item | Limit | Ours |
|---|---|---|
| **App bundle (AAB) download size** | **200 MB** compressed for base + config splits (no Play Asset/Feature Delivery). | ~1–2 MB. The APK is 0.7 MB; the AAB with Firebase Messaging is a little more. **Nowhere near the limit.** |
| Legacy APK (not used) | 100 MB | — |
| **Store icon** | 512×512 px, 32-bit PNG, **≤ 1 MB**, no rounded corners/shadow (Play masks it) | `assets/icon-512.png` — 2 KB ✅ |
| **Feature graphic** | 1024×500 px, PNG or JPEG, **≤ 15 MB**, required | `assets/feature-graphic-1024x500.png` — 23 KB ✅ |
| **Phone screenshots** | 2–8 images, PNG/JPEG, **≤ 8 MB each**, 16:9 or 9:16, each side 320–3840 px | you capture (see `assets/screenshots/README.md`) |
| 7"/10" tablet screenshots | optional unless you claim tablet support; same limits | optional |
| Promo video | optional; a public YouTube URL | optional |
| Title | ≤ 30 characters | `listing/title.txt` ✅ |
| Short description | ≤ 80 characters | ✅ |
| Full description | ≤ 4000 characters | ✅ |
| Release notes | ≤ 500 characters per language | ✅ |

So **this whole folder is ~30 KB of text and graphics, and the AAB will be about 1–2 MB.** The only "big" files you add are screenshots (a few hundred KB each).

---

## 2. Play rules this app must satisfy — and status

| Rule | Requirement | Status |
|---|---|---|
| **Developer account** | US$25 one-time; identity verification; an **organisation** account needs a D-U-N-S number and a verified website/email. | Your action |
| **Closed testing first** (new *personal* accounts created after Nov 2023) | 20 testers opted-in for 14 continuous days before you may apply for production. Organisation accounts are exempt. | Plan for it: invite 20 parents/staff to a closed track |
| **Target API level** | New apps must target Android 15 (API 35) or higher. | `targetSdk = 37` ✅ |
| **App bundle format** | Must upload `.aab`, not `.apk`. | `build/` scripts produce `app-release.aab` |
| **Play App Signing** | Mandatory for new apps. You upload with an *upload key*; Google signs with the *app signing key*. | See `build/KEYSTORE.md`. **After enrolling, replace the SHA-256 in `web/public/well-known/assetlinks.json` with Google's app-signing certificate fingerprint**, or deep links stop verifying. |
| **Privacy policy URL** | Required in Play Console and inside the app. | https://school-erp-cqj.pages.dev/privacy ✅ (fill placeholders) |
| **Data safety section** | Mandatory, must be truthful, must match behaviour. | `data-safety.md` ✅ |
| **Account deletion** | Apps with sign-in must offer an in-app deletion path and a web URL. | In-app: Account → "Request account deletion" ✅ · Web: /delete-account ✅ |
| **Content rating** | IARC questionnaire before publishing. | `content-rating.md` ✅ |
| **Target audience & Families** | Declare the age groups the app is *designed for*. This app is for parents and staff (18+), not for children, even though it holds children's data. | `target-audience.md` ✅ |
| **App access** | If content is behind a login, give reviewers working credentials. | `app-access.md` — **fill in** |
| **Ads declaration** | Declare whether the app shows ads. | No ads ✅ |
| **Financial features declaration** | Declare if the app offers payments, wallets, loans, etc. | Declare: **shows school fee dues and a UPI QR code to pay the school directly; shows a school-held prepaid balance. No payment processing, no stored card data, no loans.** Payments for real-world school fees are exempt from Google Play Billing. |
| **Permissions** | Each dangerous permission must be justified by a core feature. | INTERNET, ACCESS_NETWORK_STATE, VIBRATE, USE_BIOMETRIC (app lock), POST_NOTIFICATIONS (school alerts), WRITE_EXTERNAL_STORAGE ≤ API 28 (receipt downloads). **No location, camera, contacts, SMS, call log.** ✅ |
| **News / Government / Health** declarations | Not applicable. | N/A |
| **Device & network abuse** | The app must not download/install other APKs. The parent app does not; the school website's `/apps` sideload page is opened in the system browser, not inside the app. | ✅ (keep it that way) |
| **User-generated content (UGC)** | If the app hosts UGC (parent forum, messaging) it needs moderation, reporting and a way to block/remove. | The school moderates and can remove posts/suspend accounts; state this in the rating questionnaire (`content-rating.md`). Make sure the forum UI exposes "report" — verify before submission. |
| **Version codes** | Every upload needs a higher `versionCode`. | `versionCode = 1` for the first upload; bump in `app/build.gradle.kts` for each new release |
| **64-bit** | Only for native code. | Pure Kotlin/WebView — N/A ✅ |
| **Push (Firebase)** | `google-services.json` is **not** in the repo. Without it the app builds but push is silently dead while still declaring POST_NOTIFICATIONS. | Put the file at `mobile/apps/parent/app/google-services.json` on the build box before building (it is git-ignored). |

---

## 3. Step-by-step: from this folder to "Published"

### A. Build the signed bundle (on a machine with JDK 17 + Android SDK — this repo's CI image or Android Studio)
1. One time: create the upload keystore → `build/KEYSTORE.md`. Put `keystore.properties` at `mobile/apps/parent/keystore.properties` (git-ignored).
2. Put `google-services.json` at `mobile/apps/parent/app/` (from Firebase console).
3. Run `playstore/build/build-aab.sh` (or `.ps1`). Output: `playstore/out/app-release.aab` (+ a `mapping.txt` is not produced: minify is off).
4. Sanity check: `bundletool build-apks --bundle=app-release.aab --output=t.apks --mode=universal` and install on one phone.

### B. Play Console — create the app
1. https://play.google.com/console → **Create app**: name from `listing/title.txt`, default language English (India), **App**, **Free**. Accept the declarations.
2. **Set up your app** (dashboard checklist), using these files:
   - App access → `app-access.md`
   - Ads → No
   - Content rating → `content-rating.md`
   - Target audience → `target-audience.md`
   - News app → No · COVID → No · Data safety → `data-safety.md`
   - Government app → No · Financial features → see table above
   - Privacy policy → `https://school-erp-cqj.pages.dev/privacy`
   - App category → **Education** · Tags: Education, Parenting
   - Store settings → contact email = `[SUPPORT_EMAIL]`, website = https://school-erp-cqj.pages.dev
3. **Main store listing** → paste `listing/*.txt`, upload `assets/icon-512.png`, `assets/feature-graphic-1024x500.png`, and your screenshots.

### C. Release
1. **Testing → Closed testing → Create track** (e.g. "School pilot") → upload the `.aab` → add 20+ tester emails or a Google Group → roll out. Testers install from the opt-in link.
2. Keep it running **14 days** with testers opted in (personal accounts). Fix anything they hit; each new build bumps `versionCode`.
3. **Apply for production access** (personal accounts) → answer the questions about your testing → wait for approval (a few days).
4. **Production → Create release** → same `.aab` (or a newer one) → release notes from `listing/whats_new.txt` → **Review release** → **Start rollout**. First review typically takes 1–7 days.

### D. After Play App Signing is on
- Play Console → **Setup → App signing** → copy the **App signing key certificate SHA-256** → put it in `web/public/well-known/assetlinks.json` (keep the old fingerprint too during the transition) → push to `main`. Verify with https://developers.google.com/digital-asset-links/tools/generator.

---

## 4. What I could NOT do from this machine (no Java / Android SDK / keystore here)
- Build or sign the `.aab` — scripts and instructions are in `build/`; the repo's GitHub Actions runner already has JDK 17 + Android SDK (`.github/workflows/ci.yml`), so a `bundleRelease` job there is the fastest route.
- Capture phone screenshots — they must be real screens of the app.
- Fill legal identity (operator name, address, support and grievance emails) and a demo login — placeholders are marked.

## 5. Notes an assessor may raise
- The app is a WebView shell of the school portal. Play permits this when the app **adds value beyond the website** (push notifications, offline pages, biometric lock, home-screen presence, deep links) — all present. Say so in the full description; it is already worded that way.
- The store icon and feature graphic reuse the app's existing launcher mark (a bus). If you have proper EDU CLOUD brand art, replace `assets/icon-512.png` (keep 512×512, no transparency) and the feature graphic.
- Children's data: the *users* are adults; the app is **not** child-directed. Do not opt into the "Designed for Families" programme — it would impose requirements (ad SDK certification, etc.) that do not apply.
