/* Verbatim copies of defaultReportCardHTML and defaultReportCardCSS from
   internal/api/report_card_templates.go. Edit there first. */
export const defaultReportCardHTML = `<div class="card">
  <div class="rc-top">
    <header>
      <div class="crest">{{school_logo}}</div>
      <h1>{{school_name}}</h1>
      <div class="motto">{{school_motto}}</div>
      <div class="rule"></div>
      <div class="badge">Report Card</div>
      <div class="meta">Academic Year {{academic_year}} &bull; {{exam_name}}</div>
    </header>

    <section class="who">
      <div class="photo">{{photo}}</div>
      <div class="facts">
        <div class="fact"><span>Student name</span><strong>{{student_name}}</strong></div>
        <div class="fact"><span>Class &amp; section</span><strong>{{class}} - {{section}}</strong></div>
        <div class="fact"><span>Father's name</span><strong>{{father_name}}</strong></div>
        <div class="fact"><span>Roll number</span><strong>{{roll_no}}</strong></div>
        <div class="fact"><span>Mother's name</span><strong>{{mother_name}}</strong></div>
        <div class="fact"><span>Admission no.</span><strong>{{admission_no}}</strong></div>
        <div class="fact"><span>Date of birth</span><strong>{{date_of_birth}}</strong></div>
        <div class="fact"><span>Examination</span><strong>{{exam_name}}</strong></div>
      </div>
    </section>

    <h3 class="sec">Scholastic performance</h3>
    <table class="marks">
      <thead>
        <tr>
          <th class="rc-left">Subject</th><th>Maximum marks</th><th>Marks obtained</th><th>Percentage</th><th>Grade</th>
        </tr>
      </thead>
      <tbody>
        {{subject_rows}}
        <tr class="rc-total">
          <td class="rc-left">Grand total</td><td>{{total_marks}}</td><td>{{marks_obtained}}</td><td>{{percentage}}</td><td>{{grade}}</td>
        </tr>
      </tbody>
    </table>

    <div class="mid">
      <div>
        <h3 class="sec">Attendance record</h3>
        <table class="att">
          <thead>
            <tr><th class="rc-left">Month</th><th>Days</th><th>Present</th><th>Absent</th><th>%</th></tr>
          </thead>
          <tbody>
            {{attendance_rows}}
          </tbody>
        </table>
      </div>
      <div>
        <h3 class="sec">Academic summary</h3>
        <div class="stats">
          <div class="stat"><span>Result</span><strong>{{result}}</strong></div>
          <div class="stat"><span>Percentage</span><strong>{{percentage}}</strong></div>
          <div class="stat"><span>Overall grade</span><strong>{{grade}}</strong></div>
          <div class="stat"><span>Rank in section</span><strong>{{rank}}</strong></div>
          <div class="stat"><span>Attendance</span><strong>{{attendance}}</strong></div>
        </div>
      </div>
    </div>

    <div class="remarks">
      <h4>Class teacher's remarks</h4>
      <p>{{class_teacher_remarks}}</p>
    </div>
  </div>

  <footer>
    <div class="signs">
      <div class="sign">
        <div class="ink">{{class_teacher_sign}}</div>
        <span class="line"></span>
        <div class="who-name">{{class_teacher}}</div>
        <em>Class teacher</em>
      </div>
      <div class="sign">
        <div class="ink"></div>
        <span class="line"></span>
        <div class="who-name">Parent / Guardian</div>
        <em>Signature</em>
      </div>
      <div class="sign">
        <div class="ink">{{principal_sign}}</div>
        <span class="line"></span>
        <div class="who-name">{{principal}}</div>
        <em>Principal</em>
      </div>
    </div>
    <div class="issued">Date of issue: {{issued_on}} &bull; {{school_name}} official grade sheet</div>
  </footer>
</div>`

/** The built-in card's colour is the school's own brand colour (the
 *  frame, the title band, the table heads, the rule under the name),
 *  substituted for __ACCENT__ with the font. */
export function reportCardCSS(font: string, accent: string): string {
  return defaultReportCardCSS.split('__FONT__').join(font).split('__ACCENT__').join(accent)
}

export const defaultReportCardCSS = `
/* THE SCHOOL'S OWN DESIGN (owner, 2026-10-13, supplied as a finished page).

   Taken from the HTML they sent, with three things changed and the reasons
   for each:

   WIDTH. Theirs fixed the sheet at 210mm with its own 12mm @page margin. The
   application prints everything at 14mm, so a 210mm card is 28mm wider than
   the paper it lands on and the last column -- the grade, on a document whose
   subject is the grade -- falls off the right edge. Fluid here, with 190mm
   only as a ceiling, so it fits whatever margin is in force.

   COLOUR. Theirs is #b91c1c throughout. Every school that prints this would
   get that red whatever its own colours are, so the red is __ACCENT__: the
   school's brand colour, which is red at the school this came from and
   whatever each other school has set.

   TYPEFACE. Theirs loads Inter from Google. A printer, an offline office and
   a PDF built on the server cannot fetch it, so it falls back to something
   unpredictable rather than to the school's chosen face. __FONT__ is the
   font chosen on the Report cards screen.

   Everything else -- the layout, the banded table, the red total row, the
   stat cards, the remark box with its left rule, the three signature
   columns -- is as supplied. */
.card {
  width: 100%; max-width: 190mm; min-height: 0; margin: 0 auto; background: #fff;
  border: 1.5px solid __ACCENT__; padding: 10mm 11mm; box-sizing: border-box;
  font-family: __FONT__; color: #111827; display: flex; flex-direction: column;
  justify-content: space-between; -webkit-font-smoothing: antialiased;
}
.card * { box-sizing: border-box; }
.card header { text-align: center; }
.card .crest { height: 52px; margin-bottom: 4px; }
.card .crest img { height: 52px; width: auto; max-width: 100%; object-fit: contain; display: inline-block; }
.card h1 { font-size: 24px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin: 0; }
.card .motto { font-size: 12px; font-style: italic; color: #4b5563; margin-top: 3px; }
.card .rule { border: none; height: 1.5px; background: __ACCENT__; margin: 10px 0 12px; }
.card .badge {
  display: inline-block; background: __ACCENT__; color: #fff; font-size: 11px; font-weight: 700;
  letter-spacing: 2px; padding: 4px 18px; text-transform: uppercase;
}
.card .meta { font-size: 11.5px; color: #4b5563; margin-top: 6px; font-weight: 500; }

.card .who { display: flex; gap: 20px; margin: 20px 0; align-items: center; }
.card .photo {
  width: 95px; height: 115px; border: 1px solid #d1d5db; background: #f9fafb;
  flex-shrink: 0; overflow: hidden;
}
.card .facts { flex: 1; display: grid; grid-template-columns: 1fr 1fr; column-gap: 28px; row-gap: 6px; }
.card .fact {
  display: flex; justify-content: space-between; gap: 10px;
  border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; font-size: 12px;
}
.card .fact span { color: #6b7280; font-weight: 500; }
.card .fact strong { font-weight: 600; text-align: right; }

.card .sec {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
  color: __ACCENT__; margin: 0 0 6px;
}
.card table { width: 100%; border-collapse: collapse; font-size: 12px; }
.card th {
  background: __ACCENT__; color: #fff; padding: 8px 10px; font-weight: 600;
  letter-spacing: 0.4px; font-size: 11px; text-transform: uppercase; text-align: center;
}
.card td { padding: 7px 10px; border-bottom: 1px solid #e5e7eb; text-align: center; }
.card th.rc-left, .card td.rc-left { text-align: left; }
.card .marks tbody tr:nth-child(even) td { background: #f9fafb; }
.card .marks td:first-child { text-align: left; font-weight: 500; }
.card tr.rc-total td {
  background: __ACCENT__ !important; color: #fff !important; font-weight: 700; border-bottom: none;
}

.card .mid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 16px; margin: 16px 0; }
.card .att th { background: #374151; padding: 6px; font-size: 10.5px; }
.card .att td { padding: 5.5px 6px; font-size: 11px; }
.card .att tr.rc-total td { background: #f3f4f6 !important; color: #111827 !important; font-weight: 700; }
.card .stats { display: flex; flex-direction: column; gap: 8px; }
.card .stat {
  border: 1px solid #e5e7eb; border-radius: 3px; padding: 8px 12px;
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
}
.card .stat span { font-size: 11px; font-weight: 600; color: #4b5563; text-transform: uppercase; letter-spacing: 0.5px; }
.card .stat strong { font-size: 13px; font-weight: 700; }

.card .remarks {
  border: 1px solid #e5e7eb; border-left: 3px solid __ACCENT__;
  padding: 10px 14px; background: #f9fafb; margin-bottom: 16px; min-height: 52px;
}
.card .remarks h4 {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
  color: __ACCENT__; margin: 0 0 4px;
}
.card .remarks p { font-size: 11.5px; line-height: 1.5; color: #374151; font-style: italic; margin: 0; }

.card .signs { display: flex; justify-content: space-between; margin-top: 24px; padding: 0 10px; }
.card .sign { text-align: center; width: 140px; }
/* The signature image sits above its rule, and the box keeps its height when
   nobody has signed yet so the three columns stay level. */
.card .sign .ink { height: 34px; }
.card .sign .ink img { height: 34px; width: auto; max-width: 100%; object-fit: contain; display: inline-block; }
.card .sign .line { display: block; border-top: 1px solid #111827; margin-bottom: 5px; }
.card .sign .who-name { font-size: 11px; font-weight: 600; }
.card .sign em { font-size: 10px; color: #6b7280; font-style: normal; display: block; }
.card .issued { text-align: center; font-size: 10px; color: #9ca3af; margin-top: 14px; }

@media print {
  .card { box-shadow: none; break-inside: auto; }
  .card thead { display: table-header-group; }
  .card tr { break-inside: avoid; }
}
`

/* THE SCHOOL FORMAT (Yajur Public School, 2026-10-15: "change the report card
   template to this"). Their file was a blank sheet to type into -- a print
   toolbar and contenteditable cells. Here every cell is filled from the
   record: the subjects are only the papers the timetable dated (see
   examinedPaper in card.ts), the bands are the exam's grading scale, the
   attendance is the exam's term with months across, and the chart is plain
   HTML bars so it prints in grey on any printer. Sized to one A4 page per
   child at the application's print margin. */
export const schoolFormatHTML = `<div class="yrc">
  <div class="yrc-frame">
    <header class="yrc-head">
      <div class="yrc-seal">{{school_seal}}</div>
      <div class="yrc-school">{{school_name}}</div>
      <div class="yrc-address">{{school_address}}</div>
      <div class="yrc-report">{{exam_name}} REPORT - {{academic_year}}</div>
      <div class="yrc-photo">{{photo}}</div>
    </header>
    <table class="yrc-info">
      <tr><td class="yrc-l">ROLL NO</td><td>{{roll_no}}</td><td class="yrc-l">ACADEMIC YEAR</td><td>{{academic_year}}</td></tr>
      <tr><td class="yrc-l">STUDENT NAME</td><td>{{student_name}}</td><td class="yrc-l">ASSESSMENT</td><td>{{exam_name}}</td></tr>
      <tr><td class="yrc-l">D.O.B</td><td>{{date_of_birth}}</td><td class="yrc-l">FATHER NAME</td><td>{{father_name}}</td></tr>
      <tr><td class="yrc-l">GRADE</td><td>{{class}} - {{section}}</td><td class="yrc-l">MOBILE NUMBER</td><td>{{mobile_number}}</td></tr>
    </table>
    <table class="yrc-marks">
      <colgroup><col style="width:7%"><col style="width:25%"><col style="width:17%"><col style="width:18%"><col style="width:15%"><col style="width:18%"></colgroup>
      <thead><tr><th>S.No</th><th>SUBJECTS</th><th>Total Marks</th><th>Obtained Marks</th><th>Grade</th><th>Percentage</th></tr></thead>
      <tbody>
        {{subject_rows_numbered}}
        <tr class="yrc-total"><td colspan="2">GRAND TOTAL</td><td>{{total_marks}}</td><td>{{marks_obtained}}</td><td>{{grade}}</td><td>{{percentage}}</td></tr>
      </tbody>
    </table>
    <div class="yrc-small">Scholastic Grades:</div>
    {{grade_band_table}}
    <div class="yrc-remarks">Class Teacher's Remarks:<div class="yrc-remark">{{class_teacher_remarks}}</div></div>
    {{attendance_table}}
    <div class="yrc-chart-title">Student Performance {{exam_name}}</div>
    {{grade_chart}}
    <table class="yrc-signs">
      <tr><td><div class="yrc-ink">{{class_teacher_sign}}</div>Class Teacher</td><td><div class="yrc-ink">{{principal_sign}}</div>Principal</td><td><div class="yrc-ink"></div>Parent</td></tr>
      <tr><td class="yrc-date">Date :</td><td class="yrc-date">Date :</td><td class="yrc-date">Date :</td></tr>
    </table>
  </div>
</div>`

export const schoolFormatCSS = `
.yrc { width: 100%; max-width: 186mm; margin: 0 auto; background: #fff; color: #141414;
  font-family: Arial, Helvetica, sans-serif; font-size: 10.5px; box-sizing: border-box;
  break-after: page; page-break-after: always; break-inside: avoid; page-break-inside: avoid;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.yrc:last-child { break-after: auto; page-break-after: auto; }
.yrc * { box-sizing: border-box; }
.yrc-frame { border: 2px solid #171717; padding: 6px 8px 8px; }
.yrc-head { text-align: center; position: relative; min-height: 84px; padding: 4px 76px 8px; }
.yrc-school { font-family: Georgia, 'Times New Roman', serif; font-weight: 900; font-size: 24px; letter-spacing: -0.5px; text-transform: uppercase; }
.yrc-address { font-weight: bold; font-size: 9.5px; margin-top: 3px; text-transform: uppercase; }
.yrc-report { font-size: 15px; font-weight: 800; text-decoration: underline; margin-top: 6px; text-transform: uppercase; }
.yrc-seal { position: absolute; left: 0; top: 6px; width: 66px; height: 66px; border: 3px double #333; border-radius: 50%;
  overflow: hidden; text-align: center; font-size: 8px; font-weight: bold; padding: 6px; line-height: 1.15;
  display: flex; align-items: center; justify-content: center; text-transform: uppercase; }
.yrc-photo { position: absolute; right: 0; top: 4px; width: 60px; height: 72px; border: 1px solid #555; overflow: hidden; }
.yrc table { border-collapse: collapse; width: 100%; table-layout: fixed; }
.yrc td, .yrc th { border: 1px solid #444; padding: 3px 4px; vertical-align: middle; }
.yrc-info td { height: 21px; }
.yrc-info .yrc-l { font-weight: bold; background: #f4f4f4; width: 22%; }
.yrc-marks { margin-top: 10px; }
.yrc-marks th, .yrc-marks td { text-align: center; }
.yrc-marks th:nth-child(2), .yrc-marks td:nth-child(2) { text-align: left; }
.yrc-marks td { height: 22px; }
.yrc-total td { font-weight: bold; background: #eee; }
.yrc-small { font-size: 10.5px; font-weight: 700; margin: 9px 0 3px; }
.yrc-grading td { text-align: center; padding: 3px 2px; }
.yrc-grading td:first-child { text-align: left; font-weight: 700; width: 14%; }
.yrc-remarks { margin-top: 10px; border: 1px solid #444; min-height: 58px; padding: 6px 8px; font-weight: 700; }
.yrc-remark { font-weight: normal; margin-top: 3px; }
.yrc-attend { margin-top: 10px; }
.yrc-attend td, .yrc-attend th { text-align: center; height: 21px; }
.yrc-attend td:first-child, .yrc-attend th:first-child { text-align: left; width: 18%; font-weight: bold; }
.yrc-chart-title { text-align: center; font-weight: bold; margin: 10px 0 5px; text-transform: uppercase; }
.yrc-chart { height: 150px; border: 1px solid #444; display: flex; padding: 14px 10px 22px; }
.yrc-y { display: flex; flex-direction: column; justify-content: space-between; width: 28px; font-size: 9px; color: #444; }
.yrc-plot { flex: 1; border-left: 1px solid #888; border-bottom: 1px solid #888; display: flex; align-items: flex-end; justify-content: space-around; height: 100%; }
.yrc-col { flex: 1; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; position: relative; }
.yrc-barbox { height: 100%; width: 100%; display: flex; align-items: flex-end; justify-content: center; }
.yrc-bar { width: 26px; max-width: 70%; background: #8a8a8a; border: 1px solid #333; border-bottom: 0; position: relative; min-height: 1px; }
.yrc-bg { position: absolute; top: -13px; left: -10px; right: -10px; text-align: center; font-size: 9px; font-weight: bold; }
.yrc-sub { position: absolute; bottom: -16px; left: 0; right: 0; text-align: center; font-size: 8.5px; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-transform: uppercase; }
.yrc-signs { margin-top: 10px; }
.yrc-signs td { height: 46px; vertical-align: bottom; font-weight: bold; text-align: center; }
.yrc-ink { height: 26px; }
.yrc-ink img { height: 26px; width: auto; max-width: 100%; object-fit: contain; display: inline-block; }
.yrc-signs .yrc-date { height: 19px; text-align: left; vertical-align: middle; }
`
