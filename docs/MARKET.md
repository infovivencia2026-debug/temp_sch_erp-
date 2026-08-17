# Indian school ERP market — feature benchmark

Researched August 2026. The point of this document is not a vendor list; it is
to answer one question: **what does a K-12 school in India actually need before
this system is usable in place of what they buy today?**

## The products

| Product | Position | Scale | Feature emphasis |
|---|---|---|---|
| **Entab CampusCare** | Premium private schools | ~2,500 schools, 15–20% share | Board-compliant report cards (CBSE/ICSE), detailed accounting, multi-campus, four mobile apps (parent/student/teacher/admin), AI analytics |
| **Fedena** | SME schools, most affordable | 12–15% share | 50+ modules, plug-and-play modularity: admissions, exams, online fees, transport, library, hostel |
| **Teachmint** | Modern/hybrid schools | Large | Blended learning: live classes, digital whiteboard, integrated LMS, assessments, parent app, fees |
| **MyClassboard** | Mid-size, parent-engagement led | — | Digital diary, PTM appointment booking, real-time homework, admissions, attendance, exams, fees, library |
| **Edisapp** | Customisation-led | 8–10% share | 100% customisable, school-branded mobile apps, SIS, parent portal |
| **Vidyalaya** | India-first | — | Regional language support, CBSE/ICSE compliance, local payment integration |
| **Edunext** | E-learning led | — | Mobile quizzes, digital classroom, performance analytics |
| **Classter / Campus 365 / Smart School** | All-in-one SIS | — | Admission-to-alumni lifecycle, multi-language, 50+ modules |
| **Zoho Creator / MS Dynamics / SAP / NetSuite** | Horizontal platforms | Enterprise | Low-code or full ERP; education is a vertical, not the product |

## What actually differentiates in India

Feature *count* is not the differentiator — Fedena advertises 50 modules and
this catalog already carries 419. Three things decide whether an Indian school
can run on the software:

**1. Statutory and board compliance.** This is the hard requirement and the
main reason schools switch vendors.

| Requirement | What it means | In our catalog? |
|---|---|---|
| **UDISE+** | Annual government return; every student, teacher and facility field must reconcile. Data-integrity rules tighten each cycle. | ❌ was missing |
| **APAAR ID** | One Nation One Student ID, linked to Aadhaar, issued per student. | ❌ was missing |
| **DigiLocker** | Issue TC, report cards and certificates as verifiable digital documents. | ❌ was missing |
| **PARAKH / NEP 2020** | Holistic Progress Card, credit-based evaluation. | ⚠️ HPC present, PARAKH/credits missing |
| **RTE 25%** | Reservation register, lottery, audit-ready documentation. | ✅ present |
| **CBSE/ICSE/State report cards** | Scholastic + co-scholastic, board-specific templates. | ✅ present |
| **Board exam LOC** | List of Candidates submission for Class X/XII. | ❌ was missing |
| **GST-compliant receipts** | Tax-correct fee receipts and invoice numbering. | ⚠️ implied, not explicit |
| **PF / ESI / PT / Form 16** | Statutory payroll returns. | ✅ present |
| **Tally integration** | Almost every Indian school's accountant works in Tally. | ✅ present |
| **DLT-registered SMS** | TRAI requires pre-approved templates and sender IDs. | ✅ present |
| **April–March academic year** | Not a feature, an assumption baked into every date calculation. | ✅ schema-level |

**2. Fee collection.** This is the single biggest purchase driver. Indian fee
handling is unusually intricate: term/installment structures per class and
quota, sibling and staff concessions, RTE waivers, late-fine rules with grace
periods, post-dated cheques and bounce charges, partial and advance payments,
UPI/Razorpay reconciliation, and a printed receipt with a gapless serial.

**3. Parent communication.** WhatsApp and SMS, not email. Absence alerts,
fee reminders, circulars with read receipts, bus tracking.

## Where this system actually stands

Honest reading, not a scorecard:

| | Us | Fedena / Entab / MyClassboard |
|---|---|---|
| Feature breadth catalogued | 419 | ~50 modules |
| Feature breadth **working** | 55 screens, mostly read-only | Everything they list |
| Multi-tenant isolation | Postgres RLS + per-user scope, tested | Typically single-tenant per deployment |
| Role/permission model | 21 roles, 490+ grants, catalog-driven nav | Comparable |
| Board compliance | Report card *structures* catalogued, none generating | Shipping for a decade |
| **Data entry** | Almost none — you cannot yet admit a student, collect a fee, or enter marks | Core of the product |

That last row is the gap you're pointing at, and it is the only one that
matters. The catalog is wide; the application is read-only. A school cannot run
on dashboards.

## What "functional" requires, in order

Sequenced by what a school touches daily, most valuable first:

1. **Fee collection** — structures → invoice generation → counter collection
   (cash/UPI/cheque/card) → allocation → serial-numbered GST receipt → print.
   Plus concessions, late fines, PDC register, defaulter reminders,
   gateway reconciliation.
2. **Admissions** — enquiry → application → document verification → entrance
   test/interview → merit list → seat allocation against quotas → offer →
   fee payment → enrolment handoff creating the student record.
3. **Attendance + parent alert** — period/daily marking (built), plus automated
   absence SMS/WhatsApp to guardians, correction workflow, shortage reports.
4. **Examinations & report cards** — exam setup, marks entry per board scheme,
   grade computation, CBSE/ICSE/State/HPC report card generation as PDF.
5. **Student lifecycle** — full admission form, guardians, documents, promotion,
   transfer, TC generation with board numbering, DigiLocker issue.
6. **Communication** — circulars with targeting and read receipts, DLT SMS,
   WhatsApp Business templates.
7. **Timetable generation** — clash-free automatic generation, substitutions.
8. **Compliance exports** — UDISE+, APAAR, board LOC.
9. **HR & payroll** — salary structures, payroll run, payslips, statutory files.
10. **Operations** — transport with GPS, library circulation, hostel, inventory.

Each of these is days of work done properly, not hours. Building 1–4 well would
make this genuinely deployable in a school; building all ten matches what Entab
and Fedena ship.

## Sources

- [19 Best School ERP Software in India in 2026 — Decentro](https://decentro.tech/blog/best-school-erp-software/)
- [Top 10 Best School ERP Software in India — Entab](https://www.entab.in/top-10-best-school-erp-software-in-india.html)
- [Top 10 School Management Software in India 2026 — Databus](https://databus.co/blog/best-school-management-software-india/)
- [10 Best School Management Systems for Indian Schools — GrowthJockey](https://www.growthjockey.com/blogs/school-management-software)
- [UDISE+ & APAAR ID Integration — Unity Education ERP](https://unityedu.ai/udise-apaar/)
- [UDISE+ Compliance & Data Integrity Guide 2026-27 — Classegy](https://classegy.com/resources/udise-plus-compliance-guide-2026-27)
- [Student Information Software for Indian Schools — Inkwelly](https://inkwelly.com/en/modules/student-information)
- [Top 10 School ERP Software in India 2026 — IntelCampus](https://intelcampus.com/blog/top-10-school-erp-software-india-2026)
