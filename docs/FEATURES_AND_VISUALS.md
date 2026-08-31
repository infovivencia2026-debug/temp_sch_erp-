# Features and visuals, as they exist today

Generated from `web/src/catalog.gen.ts` and the bento source. 306 features, 13 roles.

## The visual vocabulary

### Cell drawings — `web/src/features/bento/bento-cards.tsx`

- CardShell
- Line
- Area
- Bars
- Rows
- Gauge
- Stack
- Distribution
- Compare
- PartOf
- Facts
- Funnel
- Scale
- Flow
- Heat
- Segments
- Ladder
- Waterfall
- Stripes
- Ranked
- Rings
- Forecast
- Diverging
- Radar
- Matrix
- Nil

### Card art — `web/src/features/bento/bento-kit.tsx`

- Sparkline
- CalendarDensityArt
- ReservoirArt
- BlockedFlowArt
- PopulationArt
- NetworkArt
- FunnelArt
- RiskGridArt

### Board-local — `PrincipalDashboard.tsx`

- SeverityLadder
- SeverityScale
- AttentionDraw
- PulseCard
- histogram
- unitGrid

---

## Features by role


### admissions (18)

**home**
- Dashboard

**enquiries**
- Enquiries
- Assign Leads
- Follow-up Calls
- 24/7 Admission Chatbot
- AI Voice Agent Integration
- Campus Visits

**applications**
- Application Forms
- Document Verification

**reports**
- Admission reports
- Dropped leads

**communication**
- Messages

**my_profile**
- My pay

**admissions**
- Seat Allotment
- RTE Quota
- Waitlist
- Fee & Enrollment

**front_desk**
- Front desk


### faculty (34)

**home**
- Today's classes
- My work
- My day

**my_classes**
- My classes
- Student progress
- Student Behavior & Demerits
- My students
- Student details

**attendance**
- Take attendance
- Attendance correction
- Offline Attendance & Diary Capture

**teaching**
- Homework / classwork
- Assignments & submissions
- Lesson plans / content
- LMS Study Material Upload

**timetable**
- My timetable
- Substitution Request Submission

**marks_report_cards**
- Marks entry
- Report cards

**assessment_schemes**
- CCE Formative Assessment Entry
- CCE Summative Assessment Entry

**question_papers_online_tests**
- Question Bank Management
- AI Examcell Paper Generator
- Ved AI Assessment Assistant
- Objective Online Test Creation

**communication**
- Communication
- Remarks
- Messages

**my_profile**
- Leave & self service
- Profile
- Student leave requests
- Remarks about me
- My pay

**exams**
- Question papers


### finance (13)

**home**
- Dashboard

**fees**
- Take fee payment
- Online fee portal
- Unpaid fees & reminders
- Class & transport fee setup

**campus_money**
- Cafeteria & store sales
- Donations & aid

**accounts**
- Approve & pay salaries
- Vendor bills & petty cash
- School property & budgeting

**banking_reports**
- Match bank records
- Accounting & tax reports

**my_profile**
- My pay


### front_office (3)

**front_desk**
- Front desk

**communication**
- Messages

**my_profile**
- My pay


### hod (22)

**home**
- Dashboard

**timetable**
- Class timetable
- Staff timetable
- Department timetable
- Substitution requests
- My timetable

**academics**
- Language subject allocation
- Faculty allocation

**staff**
- Teacher remarks
- Leaves & Subs

**my_profile**
- Profile
- Leave & self service
- My pay

**attendance**
- Take attendance

**teaching**
- Homework / classwork
- Lesson plans / content

**marks_report_cards**
- Marks entry
- Report cards

**communication**
- Communication
- Messages

**exams**
- Question paper approval
- Mark moderation


### hr (19)

**home**
- Dashboard

**attendance**
- Staff register
- Biometric Machine Attendance Sync
- Biometric Punch In/Out Grace Period
- Staff duty roster

**leave**
- Leave
- Leave rules

**hiring_training**
- Staff hiring
- Staff performance reviews
- Staff training & development

**reports**
- Staff analytics & reports

**my_profile**
- My pay

**records**
- Staff records
- Service book & qualifications

**onboarding_exit**
- Staff joinings & exits

**payroll**
- Monthly payroll
- Salary setup
- Taxes & statutory

**welfare**
- Staff welfare


### institution_admin (35)

**home**
- Dashboard

**getting_started**
- School setup

**approvals**
- Approvals

**students**
- Student 360
- Certificates & transfers
- Class Promotion
- Academic Performance

**admissions**
- Admissions Pipeline

**academics**
- Master Timetable
- Substitutions
- School Calendar
- Curriculum Roadmap
- Lesson Plans
- Syllabus Progress
- Attendance Audit
- Class Setup
- Teacher Assignment

**examinations**
- Performance overview
- Hall Ticket Issue
- Exams & results
- Exams & papers

**fees**
- Fee Dashboard
- Fee Default

**communication**
- Grievances
- School Achievements Showcase
- Circulars
- Messages

**standard**
- Reports
- Attendance Overview
- Fee Collection

**staff**
- Leaves & Subs

**my_profile**
- Leave & self service
- My pay

**exams**
- Question paper approval
- Mark moderation


### librarian (15)

**library**
- Book Cataloging & Accession Register
- Barcode & Spine Label Printing
- Book Issue & Return Terminal
- Book Reservation Queue
- Fine & Penalty Summary
- OPAC Digital Book Search
- Digital Library Usage
- Annual Book Stock Verification
- New Session Textbook Orders
- Books & copies
- Accession register
- Issue & return
- Reservations
- Fines

**my_profile**
- My pay


### parent (32)

**home**
- Dashboard

**attendance**
- Attendance
- Child Absence Reporting Button

**academics**
- Homework & academics
- Results & report cards
- AI Child Performance Summary Audio
- IEP Progress Goal Tracker
- Child remarks

**fees**
- Fees & payments
- Fee receipts
- Child Daily Cafeteria Purchase Timeline

**my_childs_bus**
- Live bus tracking

**alerts_preferences**
- Parent Bus Proximity Radius Customizer
- Real-time School Bus Live Video Feed Access
- Parent App Live Bus Tracking Refresh Rate Customizer

**messages**
- Communication
- Direct Teacher Messaging
- Teacher remarks

**school_life**
- Calendar & PTM
- Parent-Teacher Meeting Booking
- School Photo & Video Gallery
- Live Event Seating Pass

**documents**
- Certificate requests
- DigiLocker Document Pull

**leave_absence**
- Apply Student Leave

**consent**
- Consent & acknowledgement
- Parent Delegation for Emergency Pickup

**profile**
- Digital Student ID Card View
- Digital Parent ID Card for Campus Entry
- Parent App Biometric Lock (Face ID / Fingerprint)
- Language
- Parent App Dark Mode & High Contrast Accessibility


### seller_admin (14)

**home**
- Dashboard

**schools**
- Schools
- Add School
- Access
- Setup

**subscriptions_billing**
- Plans & Pricing
- Subscription Ledger
- License & Capacity

**entitlements**
- Module Entitlement Matrix

**usage_health**
- Adoption Metrics
- Instance Health
- Usage & Cost

**support**
- Support
- Audit


### student (32)

**home**
- My day
- Digital Diary & Schedule
- Custom Theme Selection

**timetable**
- Timetable

**attendance**
- Attendance
- Apply for leave

**homework**
- Homework & assignments
- Classmate Homework Help Forum

**learning**
- Courses / subjects
- E-Learning Resource Hub
- AI Personal Learning Companion
- Peer Tutoring & Study Groups
- Gamified Learning Streak Counter
- Gamified Learning Badge Showcase
- Virtual Classroom Hand-Raise Telemetry
- Global University Guidance Counselor
- Student Portfolio Management

**exams_results**
- Exams & grades
- Academic record

**fees**
- Fees

**notices_calendar**
- Calendar
- Library Book Hold Request

**campus_life**
- Student Wall & Peer Recognition
- Digital Hall of Fame
- Student Club Event Ticketing & QR Check-In
- Lost & Found Item Board
- Lost & Found Photo Board with Claim Verification
- Digital Locker Combination & Access Log

**alumni**
- Alumni Network Registration
- Alumni Job & Internship Board

**requests**
- Requests

**profile**
- My ID card


### super_admin (46)

**dashboard**
- Dashboard
- System health

**institution_setup**
- Institutions & campuses
- Academic year defaults
- Branding
- School settings

**access_security**
- Users
- Roles & permissions
- Login & session audit
- SSO / MFA
- User directory

**platform_configuration**
- Module configuration
- Integrations
- Numbering & templates
- Audit log
- Data operations
- Import & export

**campuses_academic_year**
- Franchise Management
- White-Label Branding
- Academic Calendar Model

**messaging**
- SMS Gateway Integration
- WhatsApp API Integration
- Email Server (SMTP) Integration
- Automated Trigger Rules

**payments_devices**
- Payment Gateway Connectors
- Biometric Device Integration
- GPS Hardware Integration
- Virtual Classroom Integration
- Tally ERP / Prime Connector
- Meritto / LeadSquared Sync

**statutory_boards**
- SQAA Framework Management
- UDISE+ Data Sync
- APAAR ID Provisioning
- DigiLocker Issuer Integration
- Board Affiliation & Disclosure
- State Board Configuration
- School Management Type
- District & Mandal Master
- Child Info Portal Sync

**operations**
- Data Backup & Restore
- System Health & Integration Alerts

**ai_automation**
- Predictive Dropout Risk Engine
- Automated Timetable Optimizer
- AI Sentiment Analysis on Feedback
- Automated Exam Question Translation
- Smart Fee Cash Flow Predictor


### transport_manager (23)

**transport**
- Vehicle Master Registry
- Driver & Attendant Profiles
- Route & Pickup Stop Mapping
- Student Route Assignment
- Route Distance Fee Slabs
- Transport Attendance Scans
- Real-time Vehicle Tracking (VTS)
- Geo-fenced Bus Stop Alerts
- Bus Speeding & Rash Driving Alerts
- Vehicle Fuel & Maintenance Log
- Fuel Sensor & Mileage Telematics
- Driver Sobriety & Safety Checklist
- Bus Breakdown Emergency Dispatch
- Seatbelt & CCTV Video Streaming
- AIS-140 Telematics & VAHAN Compliance
- Vehicles
- Drivers & attendants
- Routes & stops
- Student allocation
- Route attendance
- Delays & exceptions
- Live vehicle tracking

**my_profile**
- My pay

