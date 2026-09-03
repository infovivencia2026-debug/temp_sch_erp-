SETTING UP A SCHOOL — THE SHEETS, IN ORDER
==========================================

Every header in this folder was taken from the server that reads it, so the
columns are exactly what the import expects. Fill them in Excel or Google
Sheets and export as CSV.

Nothing is written until you have seen it. Every upload is checked first and
shows which rows are wrong, by row number, with the values. A file with a bad
row writes nothing at all. Any upload can be taken back out afterwards.

If your own spreadsheet has different column names, do not rename anything --
upload it as it is and the screen will ask you which of your columns is which.
A column we have no field for can be kept as an extra field under your own
label.


ORDER MATTERS FOR THREE OF THEM
-------------------------------
  02 staff        before 03, if you want teacher emails in it
  01 classes      before 03 and 05
  04 students     before 05, 06 and 07

Everything else can go in any order.


THE SHEETS
----------

01-classes-and-sections.csv
    Only the class name is required. Sections are written as you say them --
    "A, B" or "Rose, Newton". Capacity is seats per section and defaults to 40
    if you leave it out. A section with no capacity can never be full, so the
    admissions screen can never warn you.

02-staff.csv
    The email is what creates their login. No email means a personnel record
    and no account, which is a real choice for a school that does not give
    every member of staff one. subjects is a semicolon list of what they
    teach: MATH; SCI.

03-subjects-classes-teachers.csv
    One sheet doing three jobs. What each row does depends on what it carries:

        subject alone                     adds the subject
        subject + class                   the class studies it
        + section                         that section only, and its room
        + class_teacher_email             who takes the form class
        + teacher_email                   who teaches the subject

    A subject the school has not added yet is created from this sheet, so
    there is no separate subject list to do first. Leave section empty and the
    teacher covers every section of that class.

04-students.csv
    Only full_name is required; every other column is optional.

    GUARDIAN_PHONE IS THE ONE THAT MATTERS. It is the parent's login, the fee
    reminder and the absence alert. A child imported without one is invisible
    to their own family.

    admission_date is the day they actually joined, not today. Without it
    every child appears to have joined on the morning of the import, which
    decides seniority and prints on transfer certificates.

    previous_class and previous_year give a child who did not start here a
    history, so "which class was she in last year" has an answer.

05-past-years-per-child.csv    (only if the school ran before this system)
    One row per child per year. Attendance as a total, fees as a figure. Held
    apart from this year's registers and collection, so a closed year is never
    counted as today's.

06-past-results-grid.csv       (only if the school ran before this system)
    The mark sheet as a staff room keeps it: children down, subjects across.
    Name the subject each marks column holds when you upload; leave Total and
    Rank unmapped, they are worked out from the marks. AB is absent. A blank
    cell is a subject the child does not take, not a zero.

    The year, the exam, the class and what the papers are out of are asked
    once, above the file.

07-staff-service.csv           (only if the school ran before this system)
    Years served before this system, for experience certificates and
    seniority. Without it an imported teacher has worked here since the
    morning of the upload.


WHAT IS NOT A SHEET
-------------------
These are typed in, once, and take a few minutes each:

    the school day       period names and times; name a second day if the
                         little ones run different hours, and tick which
                         classes use it
    grading scale        A1 91-100, A2 81-90, and so on. Marks cannot become
                         grades without it
    fee heads            Tuition, Admission, Transport, Lab, Books, Exam
    fee structures       per class: which heads, how much, which instalment,
                         due date
    an exam              name, kind, dates, grading scale
    UDISE+ code          eleven digits, needed before the annual return


MINIMUM TO OPEN THE SCHOOL: 01, 02, 03, 04.
