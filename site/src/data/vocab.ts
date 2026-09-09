export const FIRST = [
  'Aarav','Ananya','Vihaan','Diya','Aditya','Ishita','Rohan','Meera','Kabir','Saanvi',
  'Arjun','Kavya','Devansh','Riya','Nikhil','Tara','Yash','Nandini','Farhan','Zoya',
  'Ritvik','Sneha','Kiran','Aisha','Manav','Pooja','Siddharth','Trisha','Imran','Neha',
  'Varun','Lakshmi','Joel','Ritika','Aman','Gauri','Karthik','Shreya','Rahul','Anjali',
  'Naveen','Divya','Pranav','Sara','Harsh','Bhavna','Omkar','Nikita','Rehan','Ira',
]
export const LAST = [
  'Sharma','Iyer','Reddy','Nair','Kulkarni','Menon','Banerjee','Chatterjee','Desai','Patel',
  'Verma','Rao','Joshi','Pillai','Ghosh','Mehta','Bhatia','Sinha','Naidu','Kapoor',
  'Dutta','Shetty','Malhotra','Bose','Chauhan','Fernandes','Sengupta','Trivedi','Khanna','Qureshi',
]

export const DEPARTMENTS = [
  'Computer Science & Engineering','Electronics & Communication','Mechanical Engineering',
  'Civil Engineering','Electrical Engineering','Information Technology','Biotechnology',
  'Applied Mathematics','Applied Physics','Chemistry','Management Studies','Commerce',
  'Economics','English & Liberal Arts','Architecture','Pharmacy','Nursing','Law',
]

export const PROGRAMS = [
  'B.Tech Computer Science','B.Tech Electronics','B.Tech Mechanical','B.Tech Civil',
  'B.Tech Information Technology','B.Tech Biotechnology','M.Tech Data Science',
  'M.Tech VLSI Design','M.Tech Structural Engineering','BBA','MBA Finance','MBA Marketing',
  'MBA Operations','B.Com (Hons)','M.Com','BCA','MCA','B.Sc Physics','B.Sc Chemistry',
  'M.Sc Mathematics','B.Arch','B.Pharm','M.Pharm','B.Sc Nursing','LL.B','LL.M','Ph.D CSE',
  'Ph.D Management','B.A Economics','M.A English',
]

export const COURSES = [
  'Data Structures & Algorithms','Operating Systems','Database Management Systems',
  'Computer Networks','Machine Learning','Compiler Design','Digital Signal Processing',
  'Thermodynamics','Fluid Mechanics','Structural Analysis','Power Systems','Microprocessors',
  'Organic Chemistry','Linear Algebra','Discrete Mathematics','Financial Accounting',
  'Corporate Finance','Marketing Management','Organisational Behaviour','Business Law',
  'Human Anatomy','Pharmacology','Constitutional Law','Technical Communication',
  'Engineering Graphics','Cloud Computing','Cyber Security','Embedded Systems',
]

export const CAMPUSES = [
  'Main Campus — Bengaluru','North Campus — Delhi NCR','West Campus — Pune',
  'South Campus — Chennai','East Campus — Kolkata','Hyderabad Campus',
]

export const INSTITUTIONS = [
  'Vivencia Institute of Technology',
  'Vivencia School of Management',
  'Vivencia College of Science',
]

export const CITIES = ['Bengaluru','Pune','Chennai','Hyderabad','Delhi','Mumbai','Kochi','Jaipur','Indore','Lucknow']

export const SOURCES = ['Website','Walk-in','Referral','Education Fair','Google Ads','Meta Ads','Counsellor','Partner School']

export const COMPANIES = [
  'Infosys','TCS','Wipro','Accenture','Zoho','Freshworks','Razorpay','Swiggy','Flipkart',
  'Deloitte','Cognizant','HCLTech','Bosch','Siemens','L&T','Mahindra','Adobe India','PhonePe',
]

export const VENDORS = [
  'Sunrise Stationers','Bharat Lab Supplies','TechnoServe IT','GreenLeaf Catering',
  'Metro Book House','Prime Furnishings','SecureNet Systems','CleanCo Facility Services',
]

export const ROOMS = ['A-101','A-102','A-204','B-301','B-305','C-110','C-212','D-004','Lab-CS1','Lab-CS2','Lab-EC1','Auditorium','Seminar Hall 2']

/* ---------------------------------------------------------------------------
   K-12 vocabulary. The same generator drives both segments — only the word
   pools change, so a school deployment reads "Class VIII-B / Mathematics"
   where a university reads "Semester 5 / B.Tech Computer Science".
   --------------------------------------------------------------------------- */

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

export const CLASSES = ROMAN.flatMap((r) => ['A', 'B', 'C'].map((s) => `Class ${r}-${s}`))

export const GRADE_LEVELS = [
  'Pre-Primary', 'Primary (I–V)', 'Middle (VI–VIII)', 'Secondary (IX–X)', 'Senior Secondary (XI–XII)',
]

export const SCHOOL_SUBJECTS = [
  'English', 'Hindi', 'Mathematics', 'Environmental Studies', 'Science', 'Social Science',
  'Physics', 'Chemistry', 'Biology', 'Computer Science', 'Sanskrit', 'French',
  'Physical Education', 'Art & Craft', 'Music', 'General Knowledge', 'Accountancy',
  'Business Studies', 'Economics', 'Political Science', 'History', 'Geography',
]

export const SCHOOL_DEPARTMENTS = [
  'Languages', 'Mathematics', 'Science', 'Social Science', 'Computer Science',
  'Physical Education', 'Performing Arts', 'Visual Arts', 'Counselling',
  'Pre-Primary', 'Primary', 'Middle School', 'Senior School', 'Administration',
]

export const BOARDS = ['CBSE', 'ICSE', 'State Board', 'IB', 'IGCSE']

/** Scholastic grades used on a CBSE-style report card. */
export const CBSE_GRADES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D', 'E']

/** Co-scholastic areas are graded 3-point, not marked. */
export const CO_SCHOLASTIC = [
  'Work Education', 'Art Education', 'Health & Physical Education',
  'Discipline', 'Attitude towards Teachers', 'Attitude towards Peers',
]

export const VISIT_PURPOSES = [
  'Admission enquiry', 'Fee payment', 'Meet class teacher', 'Meet principal',
  'Collect documents', 'Vendor delivery', 'Maintenance work', 'Student pickup',
]
