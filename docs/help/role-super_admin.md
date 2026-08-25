# Using the app as Super Admin

The platform across every institution. Tenancy, permissions, and the audit trail of who changed what.

You have 22 screens. They are grouped the way the sidebar groups them: a workspace holds sections, and a section holds the screens themselves. Your workspace key is `super_admin`, which is the first part of every address in this role.

Each entry below is the name you will see in the sidebar, followed by what that screen is for and the data it can reach.

## Access & Security

### Access & Security

**Login & session audit.** View login history, active sessions and suspicious access.

- Where to find it: Sidebar → Access & Security → Login & session audit
- What it can see: All users
- Also visible to: institution_admin

**Roles & permissions.** Assign roles and define data scope such as institution, campus, department, class or self.

- Where to find it: Sidebar → Access & Security → Roles & permissions
- What it can see: All users
- Also visible to: institution_admin

**User directory.** Create, search, suspend and reset accounts across the school.

- Where to find it: Sidebar → Access & Security → User directory
- What it can see: Assigned institution/campus
- Also visible to: institution_admin

**Users.** Create, activate, suspend and search users.

- Where to find it: Sidebar → Access & Security → Users
- What it can see: All users
- Also visible to: institution_admin

## Dashboard

### Dashboard

**Alerts.** Only system-level issues needing action: failed integrations, payment reconciliation failures, inactive campus setup, security alerts.

- Where to find it: Sidebar → Dashboard → Alerts
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**All campuses summary.** A small overall strip above/below campus cards: total campuses, total students, total fee collected, total outstanding. Keep this secondary to campus cards.

- Where to find it: Sidebar → Dashboard → All campuses summary
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**Campus cards.** Show one card per campus instead of generic KPI boxes. Each campus card shows Campus Name, Total Students, Fee Collected, Outstanding Fee, with a View Campus action.

- Where to find it: Sidebar → Dashboard → Campus cards
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**Central Admission Funnel KPI.** Track total inquiries, applications, admissions finalized, and conversion rate across all campuses.

- Where to find it: Sidebar → Dashboard → Central Admission Funnel KPI
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**Executive System Alerts.** Display system-critical alerts including integration downtime, security breaches, and pending audits.

- Where to find it: Sidebar → Dashboard → Executive System Alerts
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**Global Attendance Heatmap.** Monitor real-time student and staff attendance percentages across all campus locations.

- Where to find it: Sidebar → Dashboard → Global Attendance Heatmap
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**Multi-Branch Revenue Analytics.** View aggregate fee collection, outstanding balances, and comparative revenue across branches.

- Where to find it: Sidebar → Dashboard → Multi-Branch Revenue Analytics
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**System health.** Background jobs, queue depth, failed integrations and recent errors.

- Where to find it: Sidebar → Dashboard → System health
- What it can see: Assigned institution/campus
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations

## Institution Setup

### Institution Setup

**Academic year defaults.** Set active academic year/term defaults per campus; actual academic structure remains with institution admins.

- Where to find it: Sidebar → Institution Setup → Academic year defaults
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**Institutions & campuses.** Create/edit institution and campuses; address, timezone, academic model, contact details and status.

- Where to find it: Sidebar → Institution Setup → Institutions & campuses
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**School settings.** Institution profile, campuses, academic year and numbering.

- Where to find it: Sidebar → Institution Setup → School settings
- What it can see: Assigned institution/campus
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

## Platform Setup

### Operations

**System Health & Integration Alerts.** Monitor failed Webhooks, payment gateway time-outs, SMS delivery failures, and API errors.

- Where to find it: Sidebar → Platform Setup → Operations → System Health & Integration Alerts
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations

### Statutory & Boards

**APAAR ID Provisioning.** Generate and reconcile APAAR (One Nation One Student) IDs against Aadhaar and the UDISE+ register.

- Where to find it: Sidebar → Platform Setup → Statutory & Boards → APAAR ID Provisioning
- What it can see: All institutions / all campuses
- Also visible to: finance, hod, hr, institution_admin, seller_admin

**UDISE+ Data Sync.** Map school, student, teacher and facility fields to the UDISE+ return format and validate data integrity before submission.

- Where to find it: Sidebar → Platform Setup → Statutory & Boards → UDISE+ Data Sync
- What it can see: All institutions / all campuses
- Also visible to: finance, hod, hr, institution_admin, seller_admin

## Platform Configuration

### Platform Configuration

**Audit log.** Search critical configuration and data-change history.

- Where to find it: Sidebar → Platform Configuration → Audit log
- What it can see: All institutions / all campuses
- Also visible to: institution_admin

**Data operations.** Controlled import/export, archival, retention and backup/restore administration.

- Where to find it: Sidebar → Platform Configuration → Data operations
- What it can see: All institutions / all campuses
- Also visible to: admissions, faculty, finance, hod, institution_admin, operations

**Import & export.** Bulk import of students, staff and opening balances, with validation reports.

- Where to find it: Sidebar → Platform Configuration → Import & export
- What it can see: Assigned institution/campus
- Also visible to: admissions, faculty, finance, hod, hr, institution_admin, operations, parent, seller_admin, student

**Module configuration.** Enable/disable modules by institution so users only see what their institution uses.

- Where to find it: Sidebar → Platform Configuration → Module configuration
- What it can see: All institutions / all campuses
- Also visible to: institution_admin, seller_admin


If a screen listed here is not in your sidebar, it is because nothing has been assigned to you for it yet -- a teacher with no section, a head of department with no department. The permission is real and the workspace is empty; ask the office to make the assignment rather than waiting for a release.
