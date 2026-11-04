/* FREQUENTLY ASKED QUESTIONS, by role (owner, 2026-11-04: "FAQs with solution
   and Show me button, 15-20 questions for their role").

   Each answer names the screen it happens on (`screen`, the feature's name as
   the menu shows it). Help finds that screen in the person's own menu: if
   they have it, "Show me" opens it; if not, the answer still reads. */

export type Faq = { q: string; a: string[]; screen?: string }

const COMMON: Faq[] = [
  { q: 'How do I change my password?', a: ['Open your profile from the photo at the bottom of the menu.', 'Under Sign-in and security, choose Change password.', 'Enter the current password, then the new one twice, and save.'], screen: 'Profile' },
  { q: 'I forgot my password. What do I do?', a: ['On the sign-in page, choose Forgot password and follow the code sent to your phone or email.', 'If no code arrives, ask the school office to reset it for you.'] },
  { q: 'How do I change my photo or phone number?', a: ['Open your profile from the photo at the bottom of the menu.', 'Press the pencil at the top right, change the details and save.'], screen: 'Profile' },
  { q: 'Something failed with a code like Ref: ABC123. What now?', a: ['Copy the code shown at the end of the message.', 'Press Report a problem below and paste it, so support can find what happened.'] },
  { q: 'Can I use this on my phone?', a: ['Yes. Open the same address in the phone browser, or install the XULO app from the Play Store, and sign in with the same details.'] },
]

const STAFF: Faq[] = [
  { q: 'How do I apply for leave?', a: ['Open Leave & self service.', 'Choose Apply, pick the dates and the leave type, add a reason and send.', 'You see the approval here once it is decided.'], screen: 'Leave & self service' },
  { q: 'Where is my payslip?', a: ['Open My pay.', 'Pick the month to see or download the payslip.'], screen: 'My pay' },
  { q: 'My attendance shows absent but I was present.', a: ['Check your punches in Leave & self service.', 'If a punch is missing, raise a correction there, or tell HR so they can mark it.'], screen: 'Leave & self service' },
  { q: 'Where do I see school messages and circulars?', a: ['Open Messages from the menu. New items show a count beside it.'], screen: 'Messages' },
]

const BY_ROLE: Record<string, Faq[]> = {
  institution_admin: [
    { q: 'How do I add a new student?', a: ['Open Student 360.', 'Press Add student, fill the details and the class, then save.'], screen: 'Student 360' },
    { q: 'How do I add a staff member and give them a login?', a: ['Open Logins & access.', 'Add the person, choose their role and send the login to their phone or email.'], screen: 'Logins & access' },
    { q: 'How do I make someone a class teacher?', a: ['Open Teacher Assignment.', 'Pick the teacher for each section. You can add more than one class teacher to a section.'], screen: 'Teacher Assignment' },
    { q: 'How do I see who is absent today?', a: ['Open Present & absent. It shows students and staff for today, by class.'], screen: 'Present & absent' },
    { q: 'How do I approve leave and other requests?', a: ['Open Approvals.', 'Open a request, then Approve or Reject with a note.'], screen: 'Approvals' },
    { q: 'How do I see today\'s fee collection?', a: ['Open Fee Dashboard. Collection, dues and defaulters are shown at the top.'], screen: 'Fee Dashboard' },
    { q: 'How do I send a circular to parents?', a: ['Open Circulars.', 'Write the circular, choose classes or everyone, and send.'], screen: 'Circulars' },
    { q: 'How do I set up the timetable?', a: ['Open Master Timetable.', 'Fill periods per section, or copy from another section, and publish.'], screen: 'Master Timetable' },
    { q: 'How do I issue a TC or bonafide certificate?', a: ['Open Certificates & transfers.', 'Pick the student and the certificate, check it and print.'], screen: 'Certificates & transfers' },
    { q: 'How do I promote students to the next class?', a: ['Open Class Promotion.', 'Choose the class, mark who moves up or stays, and confirm.'], screen: 'Class Promotion' },
    { q: 'How do I change what a role can see?', a: ['Open Roles & permissions.', 'Copy a built-in role and add or remove areas on the copy.'], screen: 'Roles & permissions' },
    { q: 'How do I set leave rules and loss of pay?', a: ['Open Leave Rules & LOP.', 'Set leaves per month and how extra days are cut.'], screen: 'Leave Rules & LOP' },
    { q: 'How do I see staff biometric attendance?', a: ['Open Staff attendance register. Punches from the machine show per day.'], screen: 'Staff attendance register' },
    { q: 'How do I change the school logo or colours?', a: ['Open Branding.', 'Upload the logo and pick colours. They show for everyone after saving.'], screen: 'Branding' },
    { q: 'Where are the reports?', a: ['Open Reports for ready-made reports, or Custom Report Builder to make your own.'], screen: 'Reports' },
  ],
  faculty: [
    { q: 'How do I take attendance?', a: ['Open Take attendance.', 'Pick the class and period, tap absentees, and save.'], screen: 'Take attendance' },
    { q: 'I marked attendance wrongly. How do I fix it?', a: ['Open Attendance correction.', 'Pick the day and student, change the mark and give a reason.'], screen: 'Attendance correction' },
    { q: 'How do I give homework?', a: ['Open Homework / classwork.', 'Choose class and subject, write the work, attach a file if needed, and post.'], screen: 'Homework / classwork' },
    { q: 'How do I enter marks?', a: ['Open Marks entry.', 'Pick the exam, class and subject, enter marks and save.'], screen: 'Marks entry' },
    { q: 'How do I write a lesson plan?', a: ['Open Lesson plans / content.', 'Pick the class and chapter, add the plan and save.'], screen: 'Lesson plans / content' },
    { q: 'Where is my timetable?', a: ['Open My timetable. Today\'s classes also show on Today\'s classes.'], screen: 'My timetable' },
    { q: 'How do I see my class list?', a: ['Open My students. Tap a student for their full record.'], screen: 'My students' },
    { q: 'How do I message parents?', a: ['Open Classroom communication.', 'Choose the class or a parent, write and send.'], screen: 'Classroom communication' },
    { q: 'How do I approve a student\'s leave?', a: ['Open Student leave requests.', 'Approve or reject each request.'], screen: 'Student leave requests' },
    { q: 'How do I write remarks for report cards?', a: ['Open Class teacher remarks.', 'Write a remark for each student and save.'], screen: 'Class teacher remarks' },
    { q: 'How do I see report cards?', a: ['Open Report cards, pick the exam and class.'], screen: 'Report cards' },
  ],
  finance: [
    { q: 'How do I take a fee payment?', a: ['Open Take fee payment.', 'Search the student, pick the dues, enter amount and mode, and save. The receipt prints.'], screen: 'Take fee payment' },
    { q: 'How do I correct a wrong receipt?', a: ['Open Fee corrections.', 'Find the receipt and cancel or adjust it with a reason.'], screen: 'Fee corrections' },
    { q: 'How do I see who has not paid?', a: ['Open Unpaid fees & reminders. Filter by class and send reminders.'], screen: 'Unpaid fees & reminders' },
    { q: 'How do I set fees for a class?', a: ['Open Class & transport fee setup.', 'Set the fee heads and amounts per class and save.'], screen: 'Class & transport fee setup' },
    { q: 'How do I pay salaries?', a: ['Open Approve & pay salaries.', 'Check the month\'s payroll, approve and mark paid.'], screen: 'Approve & pay salaries' },
    { q: 'How do I record an expense?', a: ['Open Vendor bills & petty cash and add the bill or cash spend.'], screen: 'Vendor bills & petty cash' },
    { q: 'How do I match the bank statement?', a: ['Open Match bank records and upload the statement.'], screen: 'Match bank records' },
    { q: 'Where are the daily collection reports?', a: ['Open Fixed reports and pick the day-wise collection.'], screen: 'Fixed reports' },
  ],
  hr: [
    { q: 'How do I add a new staff member?', a: ['Open Staff register.', 'Press Add staff, fill the details and save.'], screen: 'Staff register' },
    { q: 'How do I run payroll for the month?', a: ['Open Monthly payroll.', 'Pick the month, check attendance and LOP, and generate.'], screen: 'Monthly payroll' },
    { q: 'How do I set a staff member\'s salary?', a: ['Open Salary setup, pick the person and set the components.'], screen: 'Salary setup' },
    { q: 'How do I approve staff leave?', a: ['Open Leave and approve or reject each request.'], screen: 'Leave' },
    { q: 'How do I set leave rules?', a: ['Open Leave rules. Set leaves per month and loss of pay.'], screen: 'Leave rules' },
    { q: 'Biometric punches are not showing.', a: ['Open Biometric Machine Attendance Sync and check the machine\'s last sync time.', 'If it is old, check the machine is on and online.'], screen: 'Biometric Machine Attendance Sync' },
    { q: 'How do I see staff working hours?', a: ['Open Staff Hours This Month.'], screen: 'Staff Hours This Month' },
    { q: 'How do I record a staff member leaving?', a: ['Open Staff joinings & exits and add the exit with the last day.'], screen: 'Staff joinings & exits' },
  ],
  admissions: [
    { q: 'How do I add a new enquiry?', a: ['Open Enquiries, press Add and fill the parent and child details.'], screen: 'Enquiries' },
    { q: 'How do I book a campus visit?', a: ['Open Campus Visits and add the date and time for the family.'], screen: 'Campus Visits' },
    { q: 'How do I check documents?', a: ['Open Document Verification, open the application and mark each document.'], screen: 'Document Verification' },
    { q: 'How do I see the application forms?', a: ['Open Application Forms. Filter by class and stage.'], screen: 'Application Forms' },
    { q: 'How do I make a student\'s certificate?', a: ['Open Certificates & transfers, pick the student and the certificate.'], screen: 'Certificates & transfers' },
    { q: 'How do I follow up dropped leads?', a: ['Open Dropped leads and call or message each family.'], screen: 'Dropped leads' },
  ],
  parent: [
    { q: 'How do I see my child\'s attendance?', a: ['Open Attendance. Each day of the month shows present or absent.'], screen: 'Attendance' },
    { q: 'How do I see homework?', a: ['Open Homework & academics. Today\'s work is at the top.'], screen: 'Homework & academics' },
    { q: 'How do I pay fees online?', a: ['Open Fees & payments.', 'Press Pay on the due, finish the payment, and the receipt appears here.'], screen: 'Fees & payments' },
    { q: 'Where is the fee receipt?', a: ['Open Fees & payments and tap the payment to download the receipt.'], screen: 'Fees & payments' },
    { q: 'How do I see marks and report cards?', a: ['Open Results & report cards and pick the exam.'], screen: 'Results & report cards' },
    { q: 'How do I apply leave for my child?', a: ['Open Apply Student Leave, pick the dates, give a reason and send.'], screen: 'Apply Student Leave' },
    { q: 'Where is the timetable?', a: ['Open Timetable.'], screen: 'Timetable' },
    { q: 'Where is the school bus?', a: ['Open Live bus tracking to see the bus on the map.'], screen: 'Live bus tracking' },
    { q: 'How do I message the teacher?', a: ['Open Communication, pick the teacher, write and send.'], screen: 'Communication' },
    { q: 'How do I download the hall ticket?', a: ['Open Hall ticket and download it before the exam.'], screen: 'Hall ticket' },
    { q: 'How do I ask for a certificate?', a: ['Open Certificate requests, choose the certificate and send.'], screen: 'Certificate requests' },
    { q: 'How do I update our phone number or address?', a: ['Open Update my details, change and save. The school checks it.'], screen: 'Update my details' },
    { q: 'When is the next holiday or PTM?', a: ['Open Calendar & PTM.'], screen: 'Calendar & PTM' },
    { q: 'How do I change the app language?', a: ['Open Language and pick one.'], screen: 'Language' },
  ],
  student: [
    { q: 'Where is my timetable?', a: ['Open Timetable.'], screen: 'Timetable' },
    { q: 'Where is my homework?', a: ['Open Homework & assignments.'], screen: 'Homework & assignments' },
    { q: 'Where are my marks?', a: ['Open Exams & grades.'], screen: 'Exams & grades' },
    { q: 'How do I download my hall ticket?', a: ['Open Hall ticket.'], screen: 'Hall ticket' },
    { q: 'How do I see my attendance?', a: ['Open Attendance.'], screen: 'Attendance' },
    { q: 'Where is my ID card?', a: ['Open My ID card.'], screen: 'My ID card' },
    { q: 'How do I hold a library book?', a: ['Open Library Book Hold Request, find the book and request it.'], screen: 'Library Book Hold Request' },
    { q: 'Where are study materials?', a: ['Open LMS.'], screen: 'LMS' },
    { q: 'When are the holidays?', a: ['Open Calendar.'], screen: 'Calendar' },
    { q: 'How do I see my fees?', a: ['Open Fees.'], screen: 'Fees' },
  ],
}

/** The questions for one role: its own first, then the ones every staff
    member or every person asks, up to 20. */
export function faqsFor(roleKey: string | undefined): Faq[] {
  const own = (roleKey && BY_ROLE[roleKey]) || []
  const family = roleKey === 'parent' || roleKey === 'student'
  return [...own, ...(family ? [] : STAFF), ...COMMON].slice(0, 20)
}
