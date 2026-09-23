# App access — reviewer credentials for WISEN

Play Console → Policy → App content → **App access** → **"All or some functionality is restricted"** → Add instructions.

The app has no public content: it opens the school portal's sign-in. Google's review
**will fail** unless a working login is provided here. Provide a **demo parent** on a
demo school, not a real family.

## Fill in before submitting

```
Instruction name:  Parent demo login
Username / ID:     [DEMO_PARENT_EMAIL_OR_PHONE]
Password:          [DEMO_PARENT_PASSWORD]
Any other info:
  1. Open the app; it shows the WISEN sign-in.
  2. Sign in with the email/phone and password above (school: [DEMO_SCHOOL_NAME]).
  3. If asked for an OTP, none is required for this demo account.
  4. You land on the parent Home. Fees → "Fees & payments" and "Wallet";
     Attendance; Homework; Results; Bus; Notices; Account → Delete my account.
  5. This is a demo school with fictitious students; no real person's data.
```

Optional second instruction (staff view):
```
Instruction name:  Teacher demo login
Username / ID:     [DEMO_TEACHER_EMAIL]
Password:          [DEMO_TEACHER_PASSWORD]
Any other info:    Opens the staff workspace: Take attendance, Homework, Timetable.
```

## How to create the demo accounts (do this on the live system, as a seller/super admin)
1. Create (or reuse) a demo institution, e.g. "WISEN Demo School", with one class, one section, 3–5 fictitious students and fee structures.
2. Create a parent user linked to two of those students (so the child-switcher shows), role **parent**. Set a strong password; **turn OTP/MFA off** for this account.
3. Top up one student's wallet a little and post one fee receipt so Fees/Wallet screens are not empty.
4. Create a teacher user as class teacher of the section, role **teacher**.
5. Test both logins **inside the installed APK/AAB**, not only in a browser.
6. Keep these accounts alive for the life of the listing — Google re-reviews on every update. Store the credentials in your password manager, **not** in this repo.

## Also fill in Play Console → Store settings
- Support email: `[SUPPORT_EMAIL]` (shown publicly on the listing)
- Website: https://school-erp-cqj.pages.dev
- Phone (optional)
