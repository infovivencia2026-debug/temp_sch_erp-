import type { Box, BoxMarks, BoxNumber } from './box'
import { uid } from './util'

/**
 * Ready-made boxes for common question types. They are ordinary Boxes built from the same switches as
 * everything else — insert one and change anything; save your own versions to the library.
 */

const P = (html: string) => html.split('\n').map((l) => `<p>${l}</p>`).join('')
const Q_NUM: BoxNumber = { format: '1', pattern: '{n}.', scope: 'paper', counter: 'q' }
const marks = (value: number): BoxMarks => ({ mode: 'fixed', value, show: true, pattern: '[{m}]' })
const box = (b: Omit<Box, 'id'>): Box => ({ id: uid(), ...b, children: b.children?.map((c) => ({ ...c, id: uid() })) })
const text = (html: string, extra: Partial<Box> = {}): Box => ({ id: uid(), content: html, ...extra })
const key = (html: string): Box => ({ id: uid(), visible: 'key', content: html })
const lines = (n: number): Box => ({ id: uid(), visible: 'paper', content: `<div data-lines="${n}"></div>` })
const opt = (html: string, correct = false): Box => ({ id: uid(), content: html, number: { format: 'a', pattern: '({n})', scope: 'local' }, correct: correct || undefined })
const options = (items: string[], cols = 4, correct = -1): Box => ({ id: uid(), name: 'Options', layout: { mode: 'grid', cols }, children: items.map((t, i) => opt(`<p>${t}</p>`, i === correct)) })
const question = (name: string, m: number, children: Box[], extra: Partial<Box> = {}): Box => ({ id: uid(), name, number: Q_NUM, marks: marks(m), children, ...extra })
const table = (rows: string[][], header = true, borderless = false) =>
  `<table${borderless ? ' data-borderless="true"' : ''}><tbody>${rows.map((r, i) => `<tr>${r.map((c) => (header && i === 0 ? `<th><p>${c}</p></th>` : `<td><p>${c}</p></td>`)).join('')}</tr>`).join('')}</tbody></table>`

export interface Preset {
  name: string
  group: string
  hint: string
  make: () => Box
}

export const PRESETS: Preset[] = [
  // ----- building blocks -----
  { group: 'Basic', name: 'Text', hint: 'A paragraph, table, image — anything', make: () => text('') },
  { group: 'Basic', name: 'Empty box', hint: 'A container; add anything inside', make: () => box({ children: [] }) },
  { group: 'Basic', name: 'Section / heading', hint: 'Title with a rule and the marks of everything inside', make: () => box({ name: 'Section', content: '<p>Section A</p>', style: { bold: true, rule: true, spaceBefore: 8 }, marks: { mode: 'sum', show: true, pattern: '{m} Marks' }, children: [] }) },
  { group: 'Basic', name: 'Question', hint: 'Numbered, with marks — put anything inside', make: () => question('Question', 1, [text('')]) },
  { group: 'Basic', name: 'Two columns', hint: 'Side by side; each side holds anything', make: () => box({ name: 'Two columns', layout: { mode: 'grid', cols: 2 }, children: [text(''), text('')] }) },
  { group: 'Basic', name: 'Three columns', hint: 'Three side-by-side areas', make: () => box({ name: 'Three columns', layout: { mode: 'grid', cols: 3 }, children: [text(''), text(''), text('')] }) },
  { group: 'Basic', name: 'Either / or', hint: 'Numbered choice: students answer one', make: () => box({ name: 'Either / or', number: Q_NUM, choice: true, marks: { mode: 'best', best: 1, show: true, pattern: '[{m}]' }, children: [box({ marks: { mode: 'fixed', value: 5, show: false }, children: [text('')] }), box({ marks: { mode: 'fixed', value: 5, show: false }, children: [text('')] })] }) },
  { group: 'Basic', name: 'Answer any N', hint: 'Group where only the best N count', make: () => box({ name: 'Answer any N', marks: { mode: 'best', best: 2, show: true, pattern: '{k} × {e} = {m}' }, children: [text('<p><em>Answer any two of the following.</em></p>')] }) },
  { group: 'Basic', name: 'Answer (key only)', hint: 'Printed only in the answer key', make: () => key('<p><strong>Answer:</strong> </p>') },
  { group: 'Basic', name: 'Answer lines', hint: 'Space to write (paper only)', make: () => lines(4) },
  { group: 'Basic', name: 'Instructions', hint: 'General instructions block', make: () => text(P('<strong>General Instructions:</strong>\n1. All questions are compulsory.'), { name: 'Instructions', style: { scale: 0.92 } }) },
  { group: 'Basic', name: 'Page break', hint: 'Start a new page here', make: () => box({ name: 'Page break', style: { pageBreak: true } }) },

  // ----- objective -----
  { group: 'Objective', name: 'MCQ (single correct)', hint: '4 options; mark the correct one', make: () => question('MCQ', 1, [text(''), options(['', '', '', ''])]) },
  { group: 'Objective', name: 'MCQ (more than one correct)', hint: 'Mark every correct option', make: () => question('MCQ multiple', 2, [text('<p> <em>(More than one option may be correct.)</em></p>'), options(['', '', '', ''])]) },
  { group: 'Objective', name: 'Assertion – Reason', hint: 'CBSE format (check the wording against your board)', make: () => question('Assertion–Reason', 1, [
    text(P('<strong>Assertion (A):</strong> \n<strong>Reason (R):</strong> ')),
    options(['Both A and R are true and R is the correct explanation of A.', 'Both A and R are true but R is not the correct explanation of A.', 'A is true but R is false.', 'A is false but R is true.'], 1),
  ]) },
  { group: 'Objective', name: 'Statement-based MCQ', hint: 'Statements I, II, III — which are correct?', make: () => question('Statements', 1, [
    text(P('Consider the following statements:\nI. \nII. \nIII. \nWhich of the statements given above is/are correct?')),
    options(['I only', 'I and II only', 'II and III only', 'I, II and III'], 2),
  ]) },
  { group: 'Objective', name: 'True / False', hint: 'Statement with the answer in the key', make: () => question('True/False', 1, [text(''), key('<p><strong>Answer:</strong> True</p>')]) },
  { group: 'Objective', name: 'Fill in the blank', hint: 'Sentence with ____', make: () => question('Fill in the blank', 1, [text('<p> ________ .</p>'), key('<p><strong>Answer:</strong> </p>')]) },
  { group: 'Objective', name: 'Fill in the blanks (word bank)', hint: 'Box of words above the sentences', make: () => question('Word bank', 3, [text(`${table([['word 1', 'word 2', 'word 3', 'word 4']], false)}`), box({ children: [opt('<p> ________ .</p>'), opt('<p> ________ .</p>'), opt('<p> ________ .</p>')] })]) },
  { group: 'Objective', name: 'Match the following', hint: 'Column B is shuffled on the paper; in order in the key', make: () => question('Match', 4, [
    text('<p>Match the following:</p>'),
    box({ name: 'Match columns', layout: { mode: 'grid', cols: 2 }, style: { border: true, paddingMm: 2 }, children: [
      box({ content: '<p><strong>A</strong></p>', children: [1, 2, 3, 4].map(() => ({ id: uid(), content: '', number: { format: '1', pattern: '{n}.', scope: 'local' } })) }),
      box({ content: '<p><strong>B</strong></p>', shuffle: true, children: [1, 2, 3, 4].map(() => ({ id: uid(), content: '', number: { format: 'a', pattern: '({n})', scope: 'local' } })) }),
    ] }),
  ]) },
  { group: 'Objective', name: 'Match with codes', hint: 'Lists I and II, answer as a code', make: () => question('Match codes', 1, [
    text(`<p>Match List I with List II:</p>${table([['List I', 'List II'], ['A. ', '1. '], ['B. ', '2. '], ['C. ', '3. '], ['D. ', '4. ']])}`),
    options(['A-1, B-2, C-3, D-4', 'A-2, B-1, C-4, D-3', 'A-3, B-4, C-1, D-2', 'A-4, B-3, C-2, D-1'], 2),
  ]) },
  { group: 'Objective', name: 'Odd one out', hint: 'Pick the item that does not belong', make: () => question('Odd one out', 1, [text('<p>Find the odd one out:</p>'), options(['', '', '', ''])]) },
  { group: 'Objective', name: 'Analogy', hint: 'A : B :: C : ?', make: () => question('Analogy', 1, [text('<p> : :: : ________</p>'), options(['', '', '', ''])]) },
  { group: 'Objective', name: 'Picture-based MCQ', hint: 'Image beside the question and options', make: () => question('Picture MCQ', 1, [box({ layout: { mode: 'grid', cols: 2, widths: [35, 65] }, children: [text('<p>[insert image]</p>'), box({ children: [text('<p>Look at the picture and answer.</p>'), options(['', '', '', ''], 2)] })] })]) },
  { group: 'Objective', name: 'Numeric answer (JEE)', hint: 'Integer / decimal answer, no options', make: () => question('Numeric', 4, [text('<p>Answer as an integer.</p>'), text('<p>Answer: ☐☐☐</p>', { visible: 'paper' }), key('<p><strong>Answer:</strong> </p>')]) },

  // ----- written -----
  { group: 'Written', name: 'Very short answer', hint: '1–2 lines', make: () => question('Very short', 1, [text(''), lines(2), key('<p><strong>Answer:</strong> </p>')]) },
  { group: 'Written', name: 'Short answer', hint: '2–3 marks, a few lines', make: () => question('Short answer', 3, [text(''), lines(5), key('<p><strong>Model answer:</strong> </p>')]) },
  { group: 'Written', name: 'Long answer', hint: '5 marks, many lines', make: () => question('Long answer', 5, [text(''), lines(12), key('<p><strong>Marking points:</strong> </p>')]) },
  { group: 'Written', name: 'Give reasons', hint: '"Give reasons for the following"', make: () => question('Give reasons', 2, [text('<p>Give reasons: </p>'), key('<p><strong>Answer:</strong> </p>')]) },
  { group: 'Written', name: 'Correct the statement', hint: 'Rewrite the false statement correctly', make: () => question('Correct it', 1, [text('<p>Correct and rewrite: </p>'), lines(2)]) },
  { group: 'Written', name: 'Differentiate (table)', hint: 'Basis | X | Y', make: () => question('Differentiate', 3, [text(`<p>Differentiate between ____ and ____:</p>${table([['Basis', '', ''], ['', '', ''], ['', '', ''], ['', '', '']])}`)]) },
  { group: 'Written', name: 'Define', hint: 'Definition', make: () => question('Define', 1, [text('<p>Define </p>'), key('<p><strong>Answer:</strong> </p>')]) },
  { group: 'Written', name: 'Numerical problem', hint: 'Given data, find, with working', make: () => question('Numerical', 3, [text(''), lines(6), key('<p><strong>Solution:</strong> </p>')]) },
  { group: 'Written', name: 'Prove / derive', hint: 'Proof with answer space', make: () => question('Prove', 4, [text('<p>Prove that </p>'), lines(8)]) },

  // ----- with parts / stimulus -----
  { group: 'Parts & passages', name: 'Question with parts', hint: '(a), (b) each with marks', make: () => question('Parts', 5, [text(''), ...['(a)', '(b)'].map(() => box({ number: { format: 'a', pattern: '({n})', scope: 'local' }, marks: marks(2), children: [text('')] }))], { marks: { mode: 'sum', show: true, pattern: '[{m}]' } }) },
  { group: 'Parts & passages', name: 'Case study / passage', hint: 'Passage then (i), (ii), (iii)', make: () => question('Case study', 4, [
    text('<p><em>Read the passage and answer the questions that follow.</em></p><p></p>', { style: { border: true, paddingMm: 2 } }),
    ...[1, 1, 2].map((m) => box({ number: { format: 'i', pattern: '({n})', scope: 'local' }, marks: marks(m), children: [text('')] })),
  ], { marks: { mode: 'sum', show: true, pattern: '[{m}]' } }) },
  { group: 'Parts & passages', name: 'Source-based', hint: 'Extract + questions', make: () => question('Source-based', 4, [text('<p><strong>Source:</strong></p><p><em></em></p>', { style: { border: true, paddingMm: 2 } }), ...[1, 1, 2].map((m) => box({ number: { format: 'i', pattern: '({n})', scope: 'local' }, marks: marks(m), children: [text('')] }))], { marks: { mode: 'sum', show: true, pattern: '[{m}]' } }) },
  { group: 'Parts & passages', name: 'Unseen passage', hint: 'Comprehension with MCQs and short answers', make: () => question('Unseen passage', 10, [text('<p><strong>Read the passage carefully.</strong></p><p></p>'), ...[1, 1, 2, 2].map((m) => box({ number: { format: 'i', pattern: '({n})', scope: 'local' }, marks: marks(m), children: [text('')] }))], { marks: { mode: 'sum', show: true, pattern: '[{m}]' } }) },
  { group: 'Parts & passages', name: 'Cloze passage', hint: 'Passage with numbered gaps', make: () => question('Cloze', 4, [text('<p>Fill in the blanks: … (1) ______ … (2) ______ … (3) ______ … (4) ______ …</p>')]) },
  { group: 'Parts & passages', name: 'Data / graph interpretation', hint: 'Table or chart + questions', make: () => question('Data', 4, [text(`${table([['Year', 'Value'], ['', ''], ['', '']])}`), ...[1, 1, 2].map((m) => box({ number: { format: 'i', pattern: '({n})', scope: 'local' }, marks: marks(m), children: [text('')] }))], { marks: { mode: 'sum', show: true, pattern: '[{m}]' } }) },

  // ----- visual -----
  { group: 'Visual', name: 'Label the diagram', hint: 'Image with numbered labels to fill', make: () => question('Label diagram', 3, [text('<p>Label the parts marked 1–4.</p>'), box({ layout: { mode: 'grid', cols: 2, widths: [60, 40] }, children: [text('<p>[insert diagram]</p>'), box({ children: [1, 2, 3, 4].map(() => ({ id: uid(), content: '<p>________</p>', number: { format: '1', pattern: '{n}.', scope: 'local' } })) })] })]) },
  { group: 'Visual', name: 'Draw and label', hint: 'Empty box to draw in', make: () => question('Draw', 3, [text('<p>Draw a neat labelled diagram of </p>'), text('<div data-box="60"></div>', { visible: 'paper' })]) },
  { group: 'Visual', name: 'Table completion', hint: 'Fill the empty cells', make: () => question('Complete table', 3, [text(`<p>Complete the table:</p>${table([['', '', ''], ['', '', ''], ['', '', '']])}`)]) },
  { group: 'Visual', name: 'Map work', hint: 'Locate and label on the map', make: () => question('Map', 5, [text('<p>On the outline map, locate and label:</p>'), box({ children: ['', '', ''].map(() => ({ id: uid(), content: '', number: { format: 'a', pattern: '({n})', scope: 'local' } })) }), text('<p>[insert outline map]</p>')]) },
  { group: 'Visual', name: 'Picture grid', hint: 'Row of pictures with labels', make: () => question('Pictures', 2, [text('<p>Name the following:</p>'), box({ layout: { mode: 'grid', cols: 4 }, children: [1, 2, 3, 4].map(() => ({ id: uid(), content: '<p style="text-align: center">[image]</p><p style="text-align: center">________</p>', number: { format: 'a', pattern: '({n})', scope: 'local' } })) })]) },
  { group: 'Visual', name: 'Crossword', hint: 'Grid + clues', make: () => question('Crossword', 5, [text(`${table(Array.from({ length: 6 }, () => Array(6).fill('')), false)}`), box({ layout: { mode: 'grid', cols: 2 }, children: [text('<p><strong>Across</strong></p><p>1. </p>'), text('<p><strong>Down</strong></p><p>1. </p>')] })]) },

  // ----- ordering / grouping -----
  { group: 'Ordering', name: 'Arrange in order', hint: 'Jumbled items; answer order in the key', make: () => question('Sequence', 2, [text('<p>Arrange in the correct order:</p>'), box({ shuffle: true, children: ['', '', '', ''].map(() => ({ id: uid(), content: '', number: { format: 'A', pattern: '({n})', scope: 'local' } })) })]) },
  { group: 'Ordering', name: 'Classify into groups', hint: 'Sort items under headings', make: () => question('Classify', 3, [text(`<p>Classify the following: …</p>${table([['Group 1', 'Group 2', 'Group 3'], ['', '', ''], ['', '', '']])}`)]) },

  // ----- language -----
  { group: 'Language', name: 'Letter / essay / notice', hint: 'Prompt with word limit, "any one"', make: () => question('Writing', 5, [text('<p>Write a letter to … (100–120 words)</p>'), key('<p><strong>Format / value points:</strong> </p>')]) },
  { group: 'Language', name: 'Grammar (do as directed)', hint: 'Several short transformations', make: () => question('Grammar', 4, [text('<p>Do as directed:</p>'), box({ children: ['', '', '', ''].map(() => ({ id: uid(), content: '', number: { format: 'i', pattern: '({n})', scope: 'local' } })) })]) },
  { group: 'Language', name: 'Translate', hint: 'From one language to another', make: () => question('Translate', 2, [text('<p>Translate into ________:</p>'), lines(3)]) },
]

export const PRESET_GROUPS = [...new Set(PRESETS.map((p) => p.group))]
