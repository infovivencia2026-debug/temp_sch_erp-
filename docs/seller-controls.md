# Seller controls: every school-level setting

Owner, 2026-10-02: "Seller admin should be able to control everything. Data
will be private, but I am talking about the features and all things like that."

This file is the inventory behind the seller console's Controls area
(Entitlements > Controls). It lists every place a school-level setting lives,
who changes it today, and whether the vendor may change it from the console.
The registry that the console reads is `worker/src/services/settings_registry.ts`
(types in `shared/api/settings.ts`); a setting is editable from the console only
when it is declared there.

Rules for "Vendor may change":

- **yes**: configuration only; changing it touches no private record.
- **yes, with notice**: allowed, and the school also gets a notice on its board
  (a targeted announcement) because it changes what the school's people see.
- **no**: either it holds or would expose private records, or the decision is
  the school's own by law or by trust (recording people, money already taken,
  number sequences already issued). Listed so nobody adds it by accident.

Every vendor change is a row in `seller_audit` (CONTROL), which the school
reads under Security > Vendor activity (`GET /admin/security/seller-audit`).

Resolution order shown in the console: **school** (the school's stored value,
when it differs from the default that applies) > **plan** default > **platform**
default > **built-in** default (the code's own fallback). Plan and platform
defaults are written into a new school when it is created (`runProvision`), and
can be pushed to existing schools with "Apply to schools"; they are not read at
run time, so the console never shows a value the school is not actually using.

## CONTROL database (the vendor's own)

| Setting | Where | Changed today by | Vendor | Default for new schools |
|---|---|---|---|---|
| Feature switches, one per catalogue feature (about 300) | `school_feature_overrides` (+ `institutions.features_version` trigger) | Seller, Features screen | yes | the plan's modules |
| Plan, status, licensed students, renewal | `subscriptions` | Seller, Tenants | yes (billing screens; not in the registry) | chosen at creation |
| Plan contents (modules, caps, price) | `plans` | Seller, Plans | yes (Plans screen) | n/a |
| Colour, accent, tagline, login headline/message, support e-mail/phone | `institutions` columns | Seller, Tenants / New school | yes, with notice | from the New school form |
| Time zone, locale | `institutions.timezone`, `.locale` | Seller | yes, with notice | Asia/Kolkata, en-IN |
| Custom domain, app id, slug, country | `institutions` | Seller, Tenants | no from Controls (routing and app builds depend on them; kept on Tenants) | n/a |
| Teacher day-code secret, D1 binding/database | `institutions` | system | no (secret / infrastructure) | n/a |
| Announcements to schools | `platform_broadcasts`, `_targets` | Seller, Announcements | yes (Announcements screen) | n/a |
| Platform and plan defaults for the registry | `platform_setting_defaults` (CONTROL 0014) | Seller, Controls | yes | n/a |
| Role templates (built-in roles' permissions) | `platform_role_templates` (CONTROL 0014), else `SYSTEM_ROLES` in code | Seller, Controls > Roles | yes | used by `runProvision` |

## The school's own database

### `module_settings` (one row per module: `enabled` + JSON `config`)

| Module / key | Meaning | Changed today by | Vendor | Built-in default |
|---|---|---|---|---|
| plan modules (`students`, `fees`, ... 11) `.enabled` | what the plan includes | provisioning, seller plan change, admin Modules | yes, through the plan / Features (not duplicated in the registry) | from the plan |
| `student_logins.enabled` | children may hold logins | school admin, Logins & access | yes, with notice | on |
| `student_logins.config.min_level` | old lowest-class rule, no longer enforced | nobody | no (dead value, not offered) | none |
| `class_status.enabled` | Class Status on | school admin | yes, with notice | on |
| `class_status.config.needs_approval` | posts wait for the principal | school admin | yes, with notice | off |
| `class_status.config.who` | teachers / class teachers / admins | school admin | yes, with notice | teachers |
| `class_status.config.allow_video` | videos allowed | school admin | yes | on |
| `class_status.config.max_video_seconds` | 5..60 | school admin | yes | 30 |
| `session_activity.enabled` | record staff sign-ins and screens | school admin | **no**: recording people is the school's decision; the vendor can only forbid it (feature `staff.session_activity`) | off |
| `session_activity.config.retention_days` | 7..730 | school admin | yes | 90 |
| `ai.enabled` | AI assistant and briefs | school admin | yes, with notice | on |
| `ai.config.daily_cap` | AI calls per day | school admin | yes | code default |
| `ai.config.email_principal_brief`, `parent_weekly_sms`, `parent_weekly_email` | AI messages | school admin | yes, with notice | off |
| `admissions.config.entrance_test`, `.interview` | admission stages | school admin | yes | on |
| `admissions.config.enrolment_needs_approval` | enrolment waits for approval | school admin | yes | off |
| `finance.config.cheque_bounce_fine_paise` | fine on a bounced cheque | school admin | yes, with notice | 0 |
| `library_fines.config.fine_per_day_paise` | library fine | librarian | yes, with notice | 0 |
| `examinations.config.report_card_font` | report card typeface | exams | yes | default font |

### Settings tables

| Table / column | Changed today by | Vendor | Why |
|---|---|---|---|
| `message_settings` digest time, quiet hours, daily cap, repeat window | school admin, Messaging > Delivery | yes, with notice | delivery rules only |
| `message_policies` channel ladder per message type | school admin | no from Controls (per message type, and costs the school money per channel; left to the school) | spend |
| `auth_policies` password length, password expiry, idle sign-out, MFA grace days | school admin, Security | yes, with notice | sign-in rules |
| `auth_policies` MFA roles, e-mail domains, SSO fields | school admin | no (could lock the school's own people out) | access |
| `session_policies` per-role hours/devices | school admin | no from Controls (per role; Security screen) | access |
| `numbering_schemes` receipt/admission prefixes and counters | school admin | no (a number already issued must not change under the school) | money records |
| `academic_years` | school admin | no (school calendar; carries enrolments) | records |
| `branding_profiles` per campus | school admin | no from Controls (the CONTROL columns above are the school-wide ones) | per campus |
| `lms_course_settings.gating` | teachers, per section and subject | no (per course, a teaching decision) | per course |
| `collections_settings`, `ledger_settings`, `payroll_settings`, `fee_fine_rules`, `leave_policy*` | finance / HR | no (money and pay rules; changing them alters amounts owed) | money |
| `tally_connector_settings`, `crm_connector_settings` | school admin | no (credentials) | secrets |
| `report_digest_settings`, `parent_forum_settings`, `transport_tracking_policy`, `grievance_sla_policies`, `teacher_load_rules`, `board_configurations`, `backup_policies` | school admin | not yet in the registry; candidates for "yes" | see "Remains" |
| `message_templates`, `message_trigger_rules`, `report_card_templates` | school | no (school's wording, may name people) | content |
| `roles` / `role_permissions` | school admin, Roles screen | yes through role templates, only for roles the school has not customised (`roles.customised_at IS NULL`) | access |
| `user_display_preferences`, `user_permissions`, `user_roles` | each person / admin | no (about a person) | private |

### Never reachable from Controls

Students, guardians, staff personal data, marks, attendance rows, invoices and
payments, messages, files and status media. The registry declares no key that
reads or writes them, and `test/integration/seller_controls.test.ts` proves the
routes refuse anything undeclared and that a seller session reaches school
records only through the recorded, time-limited support access.

## Counts

Declared in the registry: the feature switches (one per catalogue feature,
vendor-editable, each with a notice) plus 37 settings. Of the 37, 36 are
vendor-editable (26 with a notice to the school) and 1 is shown read-only
(`security.activity_recording`, the school's own decision).

## Remains

- Help articles, tips and canned replies are being built by another session
  (support desk); they are not settings and are not in this registry.
- The settings tables marked "candidates" above can be declared later; each
  needs an adapter and a decision on notice.
