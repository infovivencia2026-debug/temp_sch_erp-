SETTING UP A SCHOOL — THE SHEETS, IN ORDER
==========================================

These are written with the column names a school's own export already uses --
Class, Section, Full Name, Father Mobile No -- so the sheet you have is very
close to the sheet you upload. Every one was run through the live importer
before it was put here.

Nothing is written until you have seen it. Every upload is checked first and
shows which rows are wrong, by row number, with the values. A file with a bad
row writes nothing at all. Any upload can be taken back out afterwards.

If your own spreadsheet has different column names, do not rename anything --
upload it as it is and the screen will ask you which of your columns is which.
A column we have no field for can be kept as an extra field under your own
label.


ORDER MATTERS FOR THREE OF THEM
-------------------------------
  02 staff        before 03, if you want teacher names in it
  01 classes      before 03 and 07
  06 fee heads    before 07
  04 students     before 08, 09 and 10

Everything else can go in any order.


THE SHEETS
----------

01-classes-and-sections.csv        Class, Sections, Capacity, Strength
    Only the class is required. Sections are written as you say them -- "A, B"
    or "Rose, Newton". "(none)" is read as empty, because that is what an
    export writes for a class with none. Capacity is seats per section and
    defaults to 40; a section with no capacity can never be full, so the
    admissions screen can never warn you.

    Strength is how many children are on the roll today -- a different
    question from how many desks there are. It is not used as the roll: the
    roll is counted from the children themselves. It is held so that after
    the students are imported the two can be compared, and a section where
    the school said 42 and 39 arrived says so instead of looking finished.
    Leave it blank if you have not counted. Zero is a real answer for a
    section opened for next year.

02-staff.csv                       Staff Code, Staff Name, Mobile No, Email,
                                   Role / Designation, Department,
                                   Employment Status, Date of Joining,
                                   Date of Inactive, Subjects
    The email is what creates their login. No email means a personnel record
    and no account -- a real choice for a school that does not give everyone
    one, and it means nothing can be assigned to them. Subjects is a semicolon
    list: MATH; SCI. Dates read as 01 Jan 2024, 2024-01-01 or 01/01/2024.
    Department and Employment Status are kept under their own labels.

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

04-students.csv                    Enrollment Code, Full Name, Class, Section,
                                   Date Of Birth, Gender, Date Of Admission,
                                   Father/Mother Name, Mobile No, EmailID,
                                   Guardian Name, Guardian Mobile No,
                                   Guardian EmailID, Guardian Relation,
                                   Concession, Concession Percent,
                                   Concession Amount, Concession Reason,
                                   Address, Aadhaar, Using Transport,
                                   Category, Status
    Only the name is required; every other column is optional.

    Class and Section are two columns, as every export writes them -- Nursery
    and A, not Nursery-A. Boy and Girl are read as well as male and female.
    Dates read as 9-Dec-22, 23-Mar-26 or 2022-12-09.

    Both parents are kept. The mother is not a spare: she is frequently the
    number that answers, and she becomes the first contact where a row carries
    no father.

    The guardian columns are for the child neither parent's row can carry --
    a grandmother, an uncle, an elder brother. Fill them and that person is
    linked to the child as well; where the row has no father and no mother,
    they become the first contact. Guardian Relation is written as you say it
    -- grandmother, uncle, aunt, brother -- and anything outside father or
    mother is filed as guardian.

    The concession columns carry a discount the family already has, so the
    first fee run does not bill them in full. Concession is one of
    scholarship, sibling, staff_ward, rte, merit, full_payment or other; No,
    None, "-" and Regular all read as no concession. Give a percentage or an
    amount -- percent between 1 and 100, amount in rupees -- and a reason in
    your own words. It is imported as already approved, because it is a fact
    the school is stating, not a request anyone is making.

    Enrollment Code is the admission number -- the stable one. Category here
    means whatever your school means by it; Day Scholar and Hosteller are kept
    under your own label rather than refused.

    THE PARENT'S MOBILE NUMBER IS THE ONE THAT MATTERS. It is their login,
    the fee reminder and the absence alert. A child imported without one is
    invisible to their own family.

    Date Of Admission is the day they actually joined, not today. Without it
    every child appears to have joined on the morning of the import, which
    decides seniority and prints on transfer certificates.

05-school-day.csv                  Sequence, Period, Starts, Ends, Break
    The periods and the breaks, in order. Breaks are listed too: the timetable
    needs them to know a teacher is free, and attendance needs them to know a
    period was not taught. A school whose primary section runs different hours
    names a second day on the screen and ticks which classes use it.

06-fee-heads.csv                   Fee Head, Code, Recurring
    What the school charges for, before what any class pays. The code is what
    a receipt prints and what a second upload matches on, so a corrected sheet
    edits rather than doubles.

07-fee-structures.csv              Structure, Class, Fee Head, Annual Amount,
                                   Instalments
    One row per head per class. The structure name groups them -- every row
    with the same name is one price list. Instalments is how many times a year
    it is billed: 3 for a termly fee, 1 for a one-off like admission.

    Needs 01 and 06 first: it is matched to the class by name and to the head
    by name.

08-past-years-per-child.csv    (only if the school ran before this system)
    One row per child per year. Attendance as a total, fees as a figure. Held
    apart from this year's registers and collection, so a closed year is never
    counted as today's.

09-past-results-grid.csv       (only if the school ran before this system)
    The mark sheet as a staff room keeps it: children down, subjects across.
    Name the subject each marks column holds when you upload; leave Total and
    Rank unmapped, they are worked out from the marks. AB is absent. A blank
    cell is a subject the child does not take, not a zero.

    The year, the exam, the class and what the papers are out of are asked
    once, above the file.

10-staff-service.csv           (only if the school ran before this system)
    Years served before this system, for experience certificates and
    seniority. Without it an imported teacher has worked here since the
    morning of the upload.


WHAT IS NOT A SHEET
-------------------
These are typed in, once, and take a few minutes each:

    grading scale        A1 91-100, A2 81-90, and so on. Marks cannot become
                         grades without it
    an exam              name, kind, dates, grading scale
    UDISE+ code          eleven digits, needed before the annual return


MINIMUM TO OPEN THE SCHOOL: 01, 02, 03, 04.
Money needs 06 and 07. A timetable needs 05.
