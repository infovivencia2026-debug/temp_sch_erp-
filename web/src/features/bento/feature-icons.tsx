/* AN ICON FOR EVERY FEATURE.
 *
 * Material Symbols Rounded, one name per catalogue slug. The value is the
 * ligature text the font turns into a glyph, so "fact_check" typed inside a
 * span with the font applied IS the glyph -- see FeatureGlyph.tsx.
 *
 * Every slug in catalog.gen.ts has a row here and the test beside this file
 * fails the build the day one does not, which is what retires the two-letter
 * monogram for good: no feature falls back to its initials, and a feature
 * added to the CSV without a row here is caught before it ships.
 *
 * The font is a SUBSET. web/src/assets/fonts/material-symbols-rounded-subset.woff2
 * carries only the names used in this file (FILL 1 and weight 500 baked in,
 * the optical-size axis kept), so a name added here that is not in the file
 * renders as its text until scripts/subset-icons.sh is run again. The test
 * checks the font's manifest against this table for that reason.
 *
 * Keyed on slug, not on the display name: a name can be edited in the
 * catalogue without silently dropping the icon. Siblings share a name only
 * where they are the same thing seen from two roles (four bus screens are a
 * bus); a section never gets one icon for all its features.
 */

export const FEATURE_ICONS: Record<string, string> = {
  '24_7_admission_chatbot': 'smart_toy', // 24/7 Admission Chatbot
  academic_calendar_model: 'calendar_view_month', // Academic Calendar Model
  academic_performance: 'monitoring', // Academic Performance
  academic_record: 'history_edu', // Academic record
  academic_year_defaults: 'event_repeat', // Academic year defaults
  access: 'key', // Access
  accession_register: 'menu_book', // Accession register
  accounting_tax_reports: 'request_quote', // Accounting & tax reports
  achievements_showcase: 'emoji_events', // Achievements showcase
  activities_electives: 'palette', // Activities & Electives
  add_school: 'add_business', // Add School
  admission_reports: 'summarize', // Admission reports
  admission_status: 'pending_actions', // Admission status
  admissions_pipeline: 'filter_alt', // Admissions Pipeline
  adoption_metrics: 'trending_up', // Adoption Metrics
  ai_child_performance_summary_audio: 'record_voice_over', // AI Child Performance Summary Audio
  ai_examcell_paper_generator: 'auto_awesome', // AI Examcell Paper Generator
  ai_personal_learning_companion: 'psychology', // AI Personal Learning Companion
  ai_sentiment_analysis_on_feedback: 'sentiment_satisfied', // AI Sentiment Analysis on Feedback
  ai_voice_agent_integration: 'support_agent', // AI Voice Agent Integration
  ais_140_telematics_vahan_compliance: 'satellite_alt', // AIS-140 Telematics & VAHAN Compliance
  alumni_job_internship_board: 'work', // Alumni Job & Internship Board
  alumni_network_registration: 'diversity_3', // Alumni Network Registration
  anecdotal_records: 'sticky_note_2', // Anecdotal records
  annual_book_stock_verification: 'inventory', // Annual Book Stock Verification
  apaar_id_provisioning: 'fingerprint', // APAAR ID Provisioning
  applicant_communication: 'forward_to_inbox', // Applicant communication
  application_forms: 'description', // Application Forms
  apply_for_leave: 'event_busy', // Apply for leave
  apply_student_leave: 'event_busy', // Apply Student Leave
  approvals: 'task_alt', // Approvals
  approve_pay_salaries: 'price_check', // Approve & pay salaries
  assign_leads: 'assignment_ind', // Assign Leads
  assignments_submissions: 'assignment_turned_in', // Assignments & submissions
  attendance: 'fact_check', // Attendance
  attendance_audit: 'rule', // Attendance Audit
  attendance_correction: 'edit_calendar', // Attendance correction
  attendance_overview: 'fact_check', // Attendance Overview
  audit: 'policy', // Audit
  audit_log: 'receipt_long', // Audit log
  audit_trail: 'manage_search', // Audit trail
  automated_exam_question_translation: 'translate', // Automated Exam Question Translation
  automated_timetable_optimizer: 'auto_fix_high', // Automated Timetable Optimizer
  automated_trigger_rules: 'bolt', // Automated Trigger Rules
  background_jobs: 'schedule', // Background jobs
  barcode_spine_label_printing: 'barcode', // Barcode & Spine Label Printing
  behaviour: 'sentiment_neutral', // Behaviour
  biometric_device_integration: 'fingerprint', // Biometric Device Integration
  biometric_machine_attendance_sync: 'sync', // Biometric Machine Attendance Sync
  biometric_punch_in_out_grace_period: 'timer', // Biometric Punch In/Out Grace Period
  biometric_readers: 'fingerprint', // Biometric Readers
  board_affiliation_disclosure: 'verified', // Board Affiliation & Disclosure
  boarder_laundry: 'local_laundry_service', // Boarder laundry
  book_cataloging_accession_register: 'library_books', // Book Cataloging & Accession Register
  book_issue_return_terminal: 'point_of_sale', // Book Issue & Return Terminal
  book_reservation_queue: 'bookmark_add', // Book Reservation Queue
  books_copies: 'auto_stories', // Books & copies
  branding: 'brush', // Branding
  bus_breakdown_emergency_dispatch: 'car_crash', // Bus Breakdown Emergency Dispatch
  bus_speeding_rash_driving_alerts: 'speed', // Bus Speeding & Rash Driving Alerts
  cafeteria_store_sales: 'restaurant', // Cafeteria & store sales
  calendar: 'calendar_month', // Calendar
  calendar_ptm: 'event_available', // Calendar & PTM
  campus_visits: 'tour', // Campus Visits
  cce_formative_assessment_entry: 'edit_note', // CCE Formative Assessment Entry
  cce_summative_assessment_entry: 'grading', // CCE Summative Assessment Entry
  certificate_requests: 'workspace_premium', // Certificate requests
  certificates_transfers: 'card_membership', // Certificates & transfers
  checkups_camps: 'medical_services', // Checkups & camps
  child_absence_reporting_button: 'person_off', // Child Absence Reporting Button
  child_daily_cafeteria_purchase_timeline: 'lunch_dining', // Child Daily Cafeteria Purchase Timeline
  child_info_portal_sync: 'cloud_sync', // Child Info Portal Sync
  child_remarks: 'rate_review', // Child remarks
  circulars: 'campaign', // Circulars
  class_promotion: 'moving', // Class Promotion
  class_setup: 'meeting_room', // Class Setup
  class_teacher_remarks: 'rate_review', // Class teacher remarks
  class_timetable: 'table_chart', // Class timetable
  class_transport_fee_setup: 'price_change', // Class & transport fee setup
  classmate_homework_help_forum: 'forum', // Classmate Homework Help Forum
  classroom_communication: 'chat', // Classroom communication
  clubs_activities: 'sports_soccer', // Clubs & activities
  collections_dues: 'account_balance_wallet', // Collections & dues
  communication: 'forum', // Communication
  conduct_notes: 'gavel', // Conduct notes
  courses_subjects: 'subject', // Courses / subjects
  curriculum_roadmap: 'route', // Curriculum Roadmap
  custom_theme_selection: 'palette', // Custom Theme Selection
  dashboard: 'dashboard', // Dashboard
  data_backup_restore: 'settings_backup_restore', // Data Backup & Restore
  data_operations: 'database', // Data operations
  delays_exceptions: 'running_with_errors', // Delays & exceptions
  department_timetable: 'view_timeline', // Department timetable
  digilocker_document_pull: 'cloud_download', // DigiLocker Document Pull
  digilocker_issuer_integration: 'cloud_upload', // DigiLocker Issuer Integration
  digital_diary_schedule: 'book', // Digital Diary & Schedule
  digital_hall_of_fame: 'military_tech', // Digital Hall of Fame
  digital_library_usage: 'query_stats', // Digital Library Usage
  digital_locker_combination_access_log: 'lock_open', // Digital Locker Combination & Access Log
  digital_parent_id_card_for_campus_entry: 'badge', // Digital Parent ID Card for Campus Entry
  digital_student_id_card_view: 'badge', // Digital Student ID Card View
  direct_teacher_messaging: 'chat_bubble', // Direct Teacher Messaging
  district_mandal_master: 'map', // District & Mandal Master
  document_verification: 'verified_user', // Document Verification
  donations_aid: 'volunteer_activism', // Donations & aid
  driver_attendant_profiles: 'contact_page', // Driver & Attendant Profiles
  driver_phone_tracker: 'phone_iphone', // Driver Phone Tracker
  driver_sobriety_safety_checklist: 'checklist', // Driver Sobriety & Safety Checklist
  drivers_attendants: 'group', // Drivers & attendants
  dropped_leads: 'person_remove', // Dropped leads
  e_learning_resource_hub: 'video_library', // E-Learning Resource Hub
  educloud_channels: 'hub', // EduCloud Channels
  email_server_smtp_integration: 'mail', // Email Server (SMTP) Integration
  emergency_pickups: 'emergency', // Emergency Pickups
  enquiries: 'contact_support', // Enquiries
  exam_desk: 'quiz', // Exam desk
  exams_grades: 'grade', // Exams & grades
  exams_papers: 'article', // Exams & papers
  exams_results: 'leaderboard', // Exams & results
  faculty_allocation: 'assignment_ind', // Faculty allocation
  family_conversations: 'family_restroom', // Family conversations
  fee_collection: 'point_of_sale', // Fee Collection
  fee_dashboard: 'insights', // Fee Dashboard
  fee_default: 'money_off', // Fee Default
  fee_enrollment: 'request_quote', // Fee & Enrollment
  fee_overview: 'pie_chart', // Fee overview
  fee_receipts: 'receipt', // Fee receipts
  fees: 'payments', // Fees
  fees_payments: 'credit_card', // Fees & payments
  fine_penalty_summary: 'currency_rupee', // Fine & Penalty Summary
  fines: 'currency_rupee', // Fines
  follow_up_calls: 'phone_callback', // Follow-up Calls
  franchise_management: 'account_tree', // Franchise Management
  front_desk: 'desk', // Front desk
  fuel_sensor_mileage_telematics: 'local_gas_station', // Fuel Sensor & Mileage Telematics
  gamified_learning_badge_showcase: 'stars', // Gamified Learning Badge Showcase
  gamified_learning_streak_counter: 'local_fire_department', // Gamified Learning Streak Counter
  geo_fenced_bus_stop_alerts: 'notifications_active', // Geo-fenced Bus Stop Alerts
  global_university_guidance_counselor: 'public', // Global University Guidance Counselor
  gps_hardware_integration: 'gps_fixed', // GPS Hardware Integration
  grievances: 'feedback', // Grievances
  groups_lists: 'groups', // Groups & lists
  hall_ticket_issue: 'confirmation_number', // Hall Ticket Issue
  hall_tickets_seating: 'event_seat', // Hall tickets & seating
  health_records: 'medical_information', // Health records
  homework_academics: 'menu_book', // Homework & academics
  homework_assignments: 'assignment', // Homework & assignments
  homework_classwork: 'edit_document', // Homework / classwork
  hostel_rooms: 'bed', // Hostel & rooms
  hostel_visitor_log: 'door_front', // Hostel visitor log
  iep_progress_goal_tracker: 'flag', // IEP Progress Goal Tracker
  import_export: 'swap_vert', // Import & export
  incident_log: 'report', // Incident log
  instance_health: 'monitor_heart', // Instance Health
  institutions_campuses: 'domain', // Institutions & campuses
  integrations: 'extension', // Integrations
  issue_return: 'swap_horiz', // Issue & return
  language: 'language', // Language
  language_subject_allocation: 'spellcheck', // Language subject allocation
  leave: 'beach_access', // Leave
  leave_rules: 'rule_folder', // Leave rules
  leave_rules_lop: 'rule_folder', // Leave Rules & LOP
  leave_self_service: 'flight_takeoff', // Leave & self service
  leaves_subs: 'person_off', // Leaves & Subs
  lesson_plans: 'menu_book', // Lesson Plans
  lesson_plans_content: 'library_books', // Lesson plans / content
  library_book_hold_request: 'bookmark_add', // Library Book Hold Request
  license_capacity: 'key', // License & Capacity
  live_bus_tracking: 'directions_bus', // Live bus tracking
  live_event_seating_pass: 'local_activity', // Live Event Seating Pass
  live_vehicle_tracking: 'my_location', // Live vehicle tracking
  lms_study_material_upload: 'upload_file', // LMS Study Material Upload
  login_session_audit: 'login', // Login & session audit
  logins_access: 'lock_person', // Logins & access
  logins_sessions: 'login', // Logins & sessions
  lost_found_item_board: 'search', // Lost & Found Item Board
  lost_found_photo_board_with_claim_verification: 'photo_camera', // Lost & Found Photo Board with Claim Verification
  mark_moderation: 'balance', // Mark moderation
  marks_entry: 'edit_square', // Marks entry
  master_timetable: 'calendar_view_week', // Master Timetable
  match_bank_records: 'account_balance', // Match bank records
  meritto_leadsquared_sync: 'sync_alt', // Meritto / LeadSquared Sync
  message_channels: 'cell_tower', // Message Channels
  message_credits: 'toll', // Message Credits
  messages: 'mail', // Messages
  module_configuration: 'tune', // Module configuration
  module_entitlement_matrix: 'grid_view', // Module Entitlement Matrix
  monthly_payroll: 'paid', // Monthly payroll
  my_bus_route: 'directions_bus', // My bus & route
  my_calendar: 'calendar_today', // My calendar
  my_classes: 'school', // My classes
  my_day: 'wb_sunny', // My day
  my_id_card: 'badge', // My ID card
  my_pay: 'payments', // My pay
  my_run: 'directions_bus', // My run
  my_students: 'groups', // My students
  my_timetable: 'schedule', // My timetable
  my_work: 'work_history', // My work
  new_session_textbook_orders: 'shopping_cart', // New Session Textbook Orders
  night_study: 'nightlight', // Night study
  night_study_attendance: 'bedtime', // Night study attendance
  numbering_templates: 'tag', // Numbering & templates
  objective_online_test_creation: 'quiz', // Objective Online Test Creation
  offline_attendance_diary_capture: 'cloud_off', // Offline Attendance & Diary Capture
  online_fee_portal: 'account_balance_wallet', // Online fee portal
  opac_digital_book_search: 'manage_search', // OPAC Digital Book Search
  operations_desk: 'engineering', // Operations desk
  outpasses_mess: 'exit_to_app', // Outpasses & mess
  parent_app_biometric_lock_face_id_fingerprint: 'face', // Parent App Biometric Lock (Face ID / Fingerprint)
  parent_app_dark_mode_high_contrast_accessibility: 'contrast', // Parent App Dark Mode & High Contrast Accessibility
  parent_app_live_bus_tracking_refresh_rate_customizer: 'update', // Parent App Live Bus Tracking Refresh Rate Customizer
  parent_bus_proximity_radius_customizer: 'radar', // Parent Bus Proximity Radius Customizer
  parent_teacher_meeting_booking: 'handshake', // Parent-Teacher Meeting Booking
  password_reset_delivery: 'lock_reset', // Password Reset Delivery
  payment_gateway_connectors: 'credit_score', // Payment Gateway Connectors
  peer_tutoring_study_groups: 'diversity_2', // Peer Tutoring & Study Groups
  performance_overview: 'analytics', // Performance overview
  period_close: 'event_note', // Period Close
  permission_slips: 'approval', // Permission Slips
  plans_pricing: 'sell', // Plans & Pricing
  predictive_dropout_risk_engine: 'warning', // Predictive Dropout Risk Engine
  profile: 'account_circle', // Profile
  ptm_notes_action_items: 'notes', // PTM notes & action items
  question_bank_management: 'inventory_2', // Question Bank Management
  question_paper_approval: 'approval', // Question paper approval
  question_papers: 'article', // Question papers
  real_time_school_bus_live_video_feed_access: 'videocam', // Real-time School Bus Live Video Feed Access
  real_time_vehicle_tracking_vts: 'my_location', // Real-time Vehicle Tracking (VTS)
  remarks: 'rate_review', // Remarks
  remarks_about_me: 'reviews', // Remarks about me
  report_cards: 'school', // Report cards
  reports: 'bar_chart', // Reports
  requests: 'inbox', // Requests
  reservations: 'bookmark', // Reservations
  results_report_cards: 'leaderboard', // Results & report cards
  roles_permissions: 'admin_panel_settings', // Roles & permissions
  room_inventory_checklists: 'checklist', // Room inventory checklists
  route_attendance: 'where_to_vote', // Route attendance
  route_distance_fee_slabs: 'straighten', // Route Distance Fee Slabs
  route_pickup_stop_mapping: 'pin_drop', // Route & Pickup Stop Mapping
  routes_stops: 'alt_route', // Routes & stops
  rte_quota: 'diversity_1', // RTE Quota
  salary_setup: 'request_page', // Salary setup
  school_achievements_showcase: 'emoji_events', // School Achievements Showcase
  school_calendar: 'calendar_month', // School Calendar
  school_management_type: 'corporate_fare', // School Management Type
  school_photo_video_gallery: 'photo_library', // School Photo & Video Gallery
  school_property_budgeting: 'savings', // School property & budgeting
  school_settings: 'settings', // School settings
  school_setup: 'home_work', // School setup
  schools: 'apartment', // Schools
  seatbelt_cctv_video_streaming: 'airline_seat_recline_normal', // Seatbelt & CCTV Video Streaming
  service_book_qualifications: 'history_edu', // Service book & qualifications
  setup: 'build', // Setup
  smart_fee_cash_flow_predictor: 'trending_up', // Smart Fee Cash Flow Predictor
  sms_gateway_integration: 'sms', // SMS Gateway Integration
  sqaa_framework_management: 'workspace_premium', // SQAA Framework Management
  sso_mfa: 'shield_lock', // SSO / MFA
  staff_analytics_reports: 'query_stats', // Staff analytics & reports
  staff_attendance_register: 'list_alt', // Staff attendance register
  staff_attendance_reports: 'assessment', // Staff attendance reports
  staff_duty_roster: 'event_note', // Staff duty roster
  staff_groups_lists: 'groups', // Staff groups & lists
  staff_hiring: 'person_add', // Staff hiring
  staff_hours_this_month: 'hourglass_bottom', // Staff Hours This Month
  staff_joinings_exits: 'transfer_within_a_station', // Staff joinings & exits
  staff_performance_reviews: 'star_rate', // Staff performance reviews
  staff_records: 'folder_shared', // Staff records
  staff_register: 'how_to_reg', // Staff register
  staff_timetable: 'schedule', // Staff timetable
  staff_training_development: 'model_training', // Staff training & development
  staff_welfare: 'health_and_safety', // Staff welfare
  staff_working_hours: 'timelapse', // Staff Working Hours
  state_board_configuration: 'account_balance', // State Board Configuration
  stock_movements: 'inventory_2', // Stock & movements
  student_360: 'person', // Student 360
  student_allocation: 'person_pin_circle', // Student allocation
  student_club_event_ticketing_qr_check_in: 'qr_code_scanner', // Student Club Event Ticketing & QR Check-In
  student_details: 'contact_page', // Student details
  student_leave_requests: 'event_busy', // Student leave requests
  student_photographs: 'photo_camera', // Student photographs
  student_portfolio_management: 'folder_special', // Student Portfolio Management
  student_progress: 'trending_up', // Student progress
  student_route_assignment: 'person_pin_circle', // Student Route Assignment
  student_wall_peer_recognition: 'thumb_up', // Student Wall & Peer Recognition
  subscription_ledger: 'receipt_long', // Subscription Ledger
  substitution_request_submission: 'swap_horiz', // Substitution Request Submission
  substitution_requests: 'swap_horiz', // Substitution requests
  substitutions: 'swap_horiz', // Substitutions
  support: 'help', // Support
  syllabus_progress: 'timeline', // Syllabus Progress
  system_health: 'monitor_heart', // System health
  system_health_integration_alerts: 'notification_important', // System Health & Integration Alerts
  systems_desk: 'dns', // Systems desk
  take_attendance: 'how_to_reg', // Take attendance
  take_fee_payment: 'point_of_sale', // Take fee payment
  tally_erp_prime_connector: 'sync_alt', // Tally ERP / Prime Connector
  taxes_statutory: 'account_balance', // Taxes & statutory
  teacher_assignment: 'assignment_ind', // Teacher Assignment
  teacher_remarks: 'rate_review', // Teacher remarks
  timetable: 'calendar_view_week', // Timetable
  todays_classes: 'schedule', // Today's classes
  transport_attendance_scans: 'qr_code_scanner', // Transport Attendance Scans
  transport_office: 'local_shipping', // Transport office
  udise_data_sync: 'cloud_sync', // UDISE+ Data Sync
  unpaid_fees_reminders: 'notifications', // Unpaid fees & reminders
  usage_cost: 'data_usage', // Usage & Cost
  user_directory: 'contacts', // User directory
  users: 'manage_accounts', // Users
  ved_ai_assessment_assistant: 'auto_awesome', // Ved AI Assessment Assistant
  vehicle_fuel_maintenance_log: 'build', // Vehicle Fuel & Maintenance Log
  vehicle_master_registry: 'garage', // Vehicle Master Registry
  vehicles: 'directions_bus', // Vehicles
  vehicles_routes: 'commute', // Vehicles & routes
  vendor_bills_petty_cash: 'receipt', // Vendor bills & petty cash
  virtual_classroom_hand_raise_telemetry: 'front_hand', // Virtual Classroom Hand-Raise Telemetry
  virtual_classroom_integration: 'video_call', // Virtual Classroom Integration
  visitor_log: 'door_front', // Visitor log
  visits_medication: 'medication', // Visits & medication
  waitlist: 'hourglass_top', // Waitlist
  whatsapp_api_integration: 'chat', // WhatsApp API Integration
  where_the_money_goes: 'donut_small', // Where the money goes
  white_label_branding: 'branding_watermark', // White-Label Branding
  year_rollover: 'update', // Year Rollover
}

/** One per section, the fallback for a slug that somehow has no row above
    (a freshly generated catalogue, before the table catches up). */
export const SECTION_ICONS: Record<string, string> = {
  academics: 'school', // Academics
  access: 'key', // Access
  access_security: 'security', // Access & Security
  accounts: 'account_balance', // Accounts
  activities: 'sports_soccer', // Activities
  admissions: 'how_to_reg', // Admissions
  ai_automation: 'auto_awesome', // AI & Automation
  alerts_preferences: 'notifications', // Alerts & Preferences
  alumni: 'diversity_3', // Alumni
  applications: 'description', // Applications
  approvals: 'task_alt', // Approvals
  assessment_schemes: 'grading', // Assessment Schemes
  attendance: 'fact_check', // Attendance
  attendance_devices: 'fingerprint', // Attendance Devices
  audit: 'policy', // Audit
  banking_reports: 'account_balance', // Banking & Reports
  campus_life: 'celebration', // Campus Life
  campus_money: 'savings', // Campus Money
  campuses_academic_year: 'domain', // Campuses & Academic Year
  channel_setup: 'cell_tower', // Channel Setup
  clinic: 'medical_services', // Clinic
  communication: 'forum', // Communication
  consent_permissions: 'approval', // Consent & Permissions
  counselling: 'psychology', // Counselling
  dashboard: 'dashboard', // Dashboard
  delivery: 'send', // Delivery
  discipline: 'gavel', // Discipline
  documents: 'folder', // Documents
  enquiries: 'contact_support', // Enquiries
  entitlements: 'grid_view', // Entitlements
  examinations: 'quiz', // Examinations
  exams: 'quiz', // Exams
  exams_results: 'leaderboard', // Exams & Results
  fees: 'payments', // Fees
  front_desk: 'desk', // Front Desk
  getting_started: 'flag', // Getting Started
  hiring_training: 'person_add', // Hiring & Training
  home: 'home', // Home
  homework: 'assignment', // Homework
  hostel: 'bed', // Hostel
  institution_setup: 'settings', // Institution Setup
  learning: 'menu_book', // Learning
  leave: 'beach_access', // Leave
  leave_absence: 'event_busy', // Leave & Absence
  library: 'local_library', // Library
  marks_report_cards: 'grade', // Marks & Report Cards
  messages: 'mail', // Messages
  messaging: 'sms', // Messaging
  money: 'account_balance_wallet', // Money
  my_childs_bus: 'directions_bus', // My Child's Bus
  my_classes: 'groups', // My Classes
  my_profile: 'account_circle', // My Profile
  notices_calendar: 'calendar_month', // Notices & Calendar
  onboarding_exit: 'transfer_within_a_station', // Onboarding & Exit
  operations: 'engineering', // Operations
  payments_devices: 'extension', // Payments & Devices
  payroll: 'paid', // Payroll
  platform_configuration: 'tune', // Platform Configuration
  profile: 'account_circle', // Profile
  question_papers_online_tests: 'article', // Question Papers & Online Tests
  records: 'folder_shared', // Records
  reports: 'bar_chart', // Reports
  requests: 'inbox', // Requests
  school_life: 'celebration', // School Life
  schools: 'apartment', // Schools
  staff: 'badge', // Staff
  standard: 'dashboard', // Standard
  statutory_boards: 'verified', // Statutory & Boards
  stores: 'inventory_2', // Stores
  students: 'person', // Students
  subscriptions_billing: 'receipt_long', // Subscriptions & Billing
  support: 'help', // Support
  systems: 'dns', // Systems
  teaching: 'cast_for_education', // Teaching
  timetable: 'calendar_view_week', // Timetable
  transport: 'directions_bus', // Transport
  usage_health: 'monitor_heart', // Usage & Health
  welfare: 'health_and_safety', // Welfare
}

/** The last resort, so the plate is never empty and never letters. */
export const DEFAULT_ICON = 'apps'

export function featureIcon(slug: string, sectionSlug?: string): string {
  return FEATURE_ICONS[slug] ?? (sectionSlug ? SECTION_ICONS[sectionSlug] : undefined) ?? DEFAULT_ICON
}
