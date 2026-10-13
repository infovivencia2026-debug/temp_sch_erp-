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
