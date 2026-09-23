# Handoff — WISEN on Google Play

You are being handed this folder to guide a non-specialist operator through publishing
**WISEN** (`com.schoolerp.parent`) to Google Play. The engineering is done; what remains
is a Play Console walkthrough plus a handful of facts only the operator has.

Everything in this folder is the submission kit: listing copy, graphics, and the exact
answers for every Play policy form. Read `README.md` for the full checklist — it is
authoritative and this file only tells you the current state.

## The app

| | |
|---|---|
| Package | `com.schoolerp.parent` |
| Display name | WISEN |
| versionName / versionCode | 1.0.0 / 1 |
| targetSdk | 37 (Play's floor is 35) |
| What it is | A WebView shell around the school's portal at https://school-erp-cqj.pages.dev. No login of its own, no local copy of any screen. |
| Bundle | `playstore/out/app-release.aab`, 1.9 MB, signed and verified (`jar verified`, `CN=WISEN, O=WISEN, C=IN`) |

Built 2026-09-23. The bundle is NOT in this folder if it was zipped from git — it is
git-ignored. It lives on the operator's machine at `playstore/out/app-release.aab`.

## Done

- Signed release bundle, built and signature-verified.
- Upload keystore generated (`~/.local/erp-release/wisen-upload.jks`, alias
  `wisen-upload`). **SHA-256:**
  `AE:D9:6E:D9:54:3A:1C:0C:BE:16:4F:62:D6:A1:3D:B9:3D:D2:75:FA:2F:DE:22:3E:B9:95:BB:23:5C:85:63:A0`
  The password is in the operator's password manager. Do not ask them to paste it to you.
- Listing copy written and within Play's length limits (title 18/30, short 79/80,
  full description, release notes).
- Store icon 512×512 (2 KB) and feature graphic 1024×500 (23 KB), both ready.
- Data safety, content rating, and target audience answers drafted in this folder.

## Blocking — the operator must supply these

1. **Screenshots.** 2–8 phone screenshots, PNG/JPEG, ≤ 8 MB each, 16:9 or 9:16, each
   side 320–3840 px. None captured yet. The app cannot be listed without them. See
   `assets/screenshots/README.md`. They must come off a real device or emulator signed
   into a real school account, so nobody but the operator can produce them.
2. **Reviewer login.** `app-access.md` still has `[DEMO_PARENT_EMAIL_OR_PHONE]` and
   friends. The app shows nothing without a login, so review fails outright without a
   working demo parent account. This is the single most common cause of rejection here.
3. **Placeholders in the public legal pages.** These pages must be live and complete
   before submission — Play checks them:
   - `web/public/privacy.html` — `[REGISTERED ADDRESS]`, `[GRIEVANCE_EMAIL]`, `[NAME]`
     (DPDP Act grievance officer), `[REGION]` (where the Neon database lives),
     effective date
   - `web/public/terms.html` — `[OPERATOR LEGAL NAME]`, `[SUPPORT_EMAIL]`, effective date
   - `web/public/delete-account.html` — same identity fields
   - `listing/full_description.txt` and `content-rating.md` — `[SUPPORT_EMAIL]`
   The operator legal name must match the Play developer account exactly.
4. **Developer account.** US$25 one-time, identity verification. If it is a *personal*
   account created after Nov 2023, Play requires **20 testers opted into a closed track
   for 14 continuous days** before production is available. Organisation accounts are
   exempt but need a D-U-N-S number. Plan the 14 days into the timeline — this is
   usually the longest pole.

## Should be resolved, but will not stop an upload

- **No `google-services.json`.** Firebase push is therefore dead in this build, while
  the manifest still declares `POST_NOTIFICATIONS`. A reviewer may flag a permission
  with no working feature. Either add the file (Firebase console → project settings →
  Android app `com.schoolerp.parent` → `mobile/apps/parent/app/google-services.json`)
  and rebuild, or accept the risk for a closed test.
- **Deep links.** After enrolling in Play App Signing, take Google's app-signing
  SHA-256 from Play Console → Setup → App signing and add it to
  `web/public/well-known/assetlinks.json` alongside the existing fingerprint. Until
  then, links into the app will not verify for Play installs.
- **Sideload users cannot update in place.** The Play build is signed with a new
  certificate, different from the key used for the APKs on the school website. Anyone
  with a sideloaded copy must uninstall before installing from Play. Tell schools
  before the listing goes live, not after.
- **A web fix is pending deploy.** The app is a shell around the live site, so it ships
  whatever the site currently serves. An unreleased fix for the on-screen keyboard
  covering the chat composer is in the working tree and not yet deployed. Deploy the
  web app before the app reaches real parents, or the first thing a tester hits is that
  bug.

## How to rebuild

```
export JAVA_HOME=/opt/homebrew/opt/openjdk@17   # the default java is 1.8; AGP 9 rejects it
bash playstore/build/build-aab.sh
```

Bump `versionCode` in `mobile/apps/parent/app/build.gradle.kts` before every re-upload —
Play refuses a bundle whose versionCode it has already seen.

## How to help

Walk the operator through `README.md` top to bottom. They are not an Android developer;
they need Play Console navigation ("Testing → Closed testing → Create new release"),
plain-language readings of the policy questions, and a check that their answers match
what `data-safety.md`, `content-rating.md` and `target-audience.md` already say. The
technical work is finished — do not send them back to the build unless a Play error
actually requires it.
