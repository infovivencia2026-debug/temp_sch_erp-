/* Verbatim copies of defaultReportCardHTML and defaultReportCardCSS from
   internal/api/report_card_templates.go. Edit there first. */
export const defaultReportCardHTML = `<div class="card">
  <header>
    <div class="crest">{{school_logo}}</div>
    <h1>{{school_name}}</h1>
    <div class="motto">{{school_motto}}</div>
    <div class="rule"></div>
    <h2>REPORT CARD</h2>
    <div class="meta">{{academic_year}} &nbsp;·&nbsp; {{exam_name}}</div>
  </header>

  <section class="who">
    <div class="photo">{{photo}}</div>
    <table class="facts">
      <tr><th>Student name</th><td>{{student_name}}</td></tr>
      <tr><th>Father's name</th><td>{{father_name}}</td></tr>
      <tr><th>Mother's name</th><td>{{mother_name}}</td></tr>
      <tr><th>Class &amp; section</th><td>{{class}} - {{section}}</td></tr>
      <tr><th>Admission no.</th><td>{{admission_no}}</td></tr>
      <tr><th>Roll no.</th><td>{{roll_no}}</td></tr>
      <tr><th>Date of birth</th><td>{{date_of_birth}}</td></tr>
    </table>
  </section>

  <table class="marks">
    <thead>
      <tr>
        <th>Subject</th><th>Maximum marks</th><th>Marks obtained</th>
        <th>Percentage</th><th>Grade</th>
      </tr>
    </thead>
    <tbody>
      {{subject_rows}}
    </tbody>
    <tfoot>
      <tr>
        <th>Total</th><th>{{total_marks}}</th><th>{{marks_obtained}}</th>
        <th>{{percentage}}</th><th>{{grade}}</th>
      </tr>
    </tfoot>
  </table>

  <section class="summary">
    <div><span>Result</span><strong>{{result}}</strong></div>
    <div><span>Rank in section</span><strong>{{rank}}</strong></div>
    <div><span>Attendance</span><strong>{{attendance}}</strong></div>
  </section>

  <footer>
    <div class="sign">
      <div class="ink">{{class_teacher_sign}}</div>
      <span></span>{{class_teacher}}<em>Class teacher</em>
    </div>
    <div class="issued">Issued {{issued_on}}</div>
    <div class="sign">
      <div class="ink">{{principal_sign}}</div>
      <span></span>{{principal}}<em>Principal</em>
    </div>
  </footer>
</div>`

export const defaultReportCardCSS = `
/* A CARD MEASURED AGAINST THE PAPER, NOT AGAINST A GUESS ABOUT IT.

   This was 190mm, which is A4 less two 10mm margins -- correct, against a
   10mm margin. The application prints everything at @page margin 14mm, so
   there are 182mm of paper. The card was 8mm wider than the sheet it goes on,
   and what falls off the right-hand edge is the last column: the grade, on a
   document whose subject is the grade. The frame lost its right side with it.

   Fluid now, with 190mm only as a ceiling, so it fits whatever margin is in
   force -- the app's, the browser's default, or one somebody sets in the
   print dialogue. No number here has to agree with a number somewhere else,
   which is what made the old one wrong. */
/* A DEFINITE WIDTH ON SCREEN, A FLEXIBLE ONE ON PAPER.

   width:100% was wrong on screen: the viewer measures the card to scale it to
   fit, so it sits in a fit-content box, and a percentage inside a box that is
   sized by its contents has nothing to resolve against. The card collapsed
   towards its own text and every column with it.

   190mm is what a sheet of A4 is, so that is the width. max-width lets it
   give way when the paper turns out to be narrower -- which it does, since
   the application prints at a 14mm margin and leaves 182mm. */
.card { width: 190mm; max-width: 100%; margin: 0 auto; padding: 8mm;
        box-sizing: border-box;
        border: 2px solid #1e3a5f;
        /* The face is the school's choice, substituted below. A fallback chain
           would have meant the card printed in whichever of the three happened
           to be on the machine, which is a different document in the office
           and in the staff room. */
        font: 11pt/1.45 __FONT__;
        color: #14213d; background: #fff; }
.card header { text-align: center; }
/* The crest, where the school has one. The block collapses to nothing when it
   is empty, so a school that has not set one gets a title where the title
   belongs rather than a gap above it. */
.card .crest:empty { display: none; }
.card .crest img { height: 18mm; width: auto; margin-bottom: 2mm; }
.card .motto:empty { display: none; }
.card .motto { font-size: 9.5pt; font-style: italic; color: #4a5568; margin-top: 1mm; }
.card h1 { margin: 0; font-size: 20pt; letter-spacing: .5px; text-transform: uppercase; }
.card h2 { margin: 3mm 0 1mm; font-size: 12pt; letter-spacing: 3px;
           background: #1e3a5f; color: #fff; display: inline-block; padding: 1.5mm 8mm; }
.card .rule { height: 1px; background: #c9a227; margin: 2mm 0; }
.card .meta { font-size: 9.5pt; color: #4a5568; }
.card .who { display: flex; gap: 6mm; margin: 5mm 0; align-items: flex-start; }
.card .photo { width: 28mm; height: 34mm; border: 1px solid #cbd5e0; flex: 0 0 auto;
               display: flex; align-items: center; justify-content: center; overflow: hidden; }
.card .photo img { width: 100%; height: 100%; object-fit: cover; }
.card .facts { flex: 1; border-collapse: collapse; font-size: 10pt; }
/* One hairline under each fact, run right across the table.

   The rule is on the row and the table collapses its borders, so the line is
   continuous instead of stopping at the gap between the label and the value.
   The last row has none: a line under the final fact is a line under nothing,
   and it reads as a row that failed to print. */
.card .facts { width: 100%; }
/* One hairline under each fact and no vertical rules at all.

   The two columns are a label and its value, not a grid: a line between them
   turns a list of facts into a table of two things, and the eye starts reading
   down the second column as if it were a series. */
.card .facts tr { border-bottom: 1px solid #dbe2ea; }
.card .facts tr:last-child { border-bottom: none; }
.card .facts th, .card .facts td { border-left: none; border-right: none; }
/* A fixed label column, so the values line up with each other rather than
   with the longest label. */
.card .facts th { width: 42%; }
.card .facts th { text-align: left; font-weight: normal; color: #4a5568;
                  padding: 1.4mm 4mm 1.4mm 0; white-space: nowrap; }
.card .facts td { font-weight: bold; padding: 1.4mm 0; }
.card table.marks { width: 100%; border-collapse: collapse; font-size: 10pt; }
.card table.marks th, .card table.marks td { border: 1px solid #99a; padding: 1.6mm 2mm; }
.card table.marks thead th, .card table.marks tfoot th {
        background: #1e3a5f; color: #fff; }
.card table.marks td:first-child, .card table.marks th:first-child { text-align: left; }
.card table.marks td { text-align: center; }
.card .summary { display: flex; gap: 4mm; margin: 5mm 0; }
.card .summary div { flex: 1; border: 1px solid #cbd5e0; padding: 2.5mm; text-align: center; }
.card .summary span { display: block; font-size: 8.5pt; color: #4a5568;
                      text-transform: uppercase; letter-spacing: .5px; }
.card .summary strong { font-size: 12pt; }
/* THE PAPER HAS TO DISAPPEAR, LEAVING THE INK.

   Almost nobody uploads a signature on a transparent background. What arrives
   is a photograph of a signature on a sheet of paper, taken on a phone, and
   printed as-is it lands on the report card as a grey square with a signature
   somewhere inside it, which is what a school notices immediately and what
   makes the whole feature look unfinished.

   multiply is what removes it: white and near-white multiply to the card's own
   white and vanish, while the dark pen strokes survive. It costs nothing, it
   needs no image processing on the way in, and it works on a photograph of a
   grey sheet as well as on a clean scan.

   The contrast and brightness lift ahead of it pushes a phone camera's grey
   paper up towards white before the blend, so a dim photograph does not leave
   a faint rectangle behind. Signatures are ink on paper: greyscale loses
   nothing and stops a blue-tinted photograph printing as a blue box.

   The negative margin sets it ON the line rather than floating above it, which
   is how a person signs a form. */
.card footer .ink { height: 12mm; display: flex; align-items: flex-end;
                    justify-content: center; margin-bottom: -3mm; }
.card footer .ink img { max-height: 14mm; max-width: 45mm;
                        mix-blend-mode: multiply;
                        filter: grayscale(1) brightness(1.08) contrast(1.9); }
/* Printers drop blend modes more often than screens do; without this the grey
   square comes back on paper only, which is the one place it matters. */
@media print { .card footer .ink img { mix-blend-mode: multiply; } }
.card footer { display: flex; align-items: flex-end; justify-content: space-between;
               margin-top: 10mm; font-size: 9.5pt; }
.card footer .sign { text-align: center; }
.card footer .sign span { display: block; width: 45mm; border-top: 1px solid #14213d;
                          margin-bottom: 1mm; }
.card footer .sign em { display: block; font-style: normal; font-size: 8.5pt; color: #4a5568; }
.card footer .issued { color: #4a5568; }
/* On paper the page's own margin is the card's margin, so the frame and the
   padding come off -- and the width becomes the paper's, not a number. */
@media print {
  .card { border: none; padding: 0; width: auto; max-width: 100%; }
  /* A long subject name must wrap inside its cell rather than widen the
     table: one Environmental Studies is enough to push the grade column off
     the sheet, and the column that gets pushed off is the one the card is
     about. */
  .card table.marks { table-layout: fixed; }
  .card table.marks td:first-child, .card table.marks th:first-child {
    word-break: break-word; }
}
`
