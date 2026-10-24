import { describe, expect, it } from 'vitest'
import { computeNumbers, marksLabel, marksOf, moveBox, printOrder, type Box } from './box'
import { renderPaperHtml } from './renderHtml'
import { emptyDoc } from './doc'
import { PRESETS } from './presets'
import { legacyToHtml, paperToBox, questionToBox, type Question } from './legacy'
import { bankFields, paperFile, parseBundle, readBundle } from './bundle'
import { bankItemBox, sectionBox } from './bankbox'
import { richPlain, sanitizeRich } from './richdoc'

const Q = (id: string, m: number, extra: Partial<Box> = {}): Box => ({ id, number: { format: '1', pattern: '{n}.', scope: 'paper', counter: 'q' }, marks: { mode: 'fixed', value: m, show: true }, ...extra })
const school = { name: 'Test School', address: '1 Main Road', logo: '' }

describe('boxes', () => {
  it('numbers questions through the paper and options within each question', () => {
    const opt = (id: string): Box => ({ id, content: '<p>x</p>', number: { format: 'a', pattern: '({n})', scope: 'local' } })
    const root: Box = { id: 'r', children: [
      { id: 's1', children: [Q('q1', 1, { children: [opt('o1'), opt('o2')] }), Q('q2', 1)] },
      { id: 's2', children: [Q('q3', 1, { children: [opt('o3')] })] },
    ] }
    const n = computeNumbers(root)
    expect(['q1', 'q2', 'q3', 'o1', 'o2', 'o3'].map((id) => n.get(id))).toEqual(['1.', '2.', '3.', '(a)', '(b)', '(a)'])
  })

  it('counts the best N for an "answer any" group and prints k × e = m', () => {
    const group: Box = { id: 'g', marks: { mode: 'best', best: 2, show: true, pattern: '{k} × {e} = {m}' }, children: [Q('a', 5), Q('b', 5), Q('c', 5)] }
    expect(marksOf(group)).toBe(10)
    expect(marksLabel(group)).toBe('2 × 5 = 10')
  })

  it('an answer printed only in the key does not add to the marks', () => {
    const root: Box = { id: 'r', marks: { mode: 'sum', show: false }, children: [Q('a', 2), { ...Q('k', 3), visible: 'key' }] }
    expect(marksOf(root)).toBe(2)
  })

  it('will not move a box into itself', () => {
    const root: Box = { id: 'r', children: [{ id: 'a', children: [{ id: 'b' }] }] }
    expect(moveBox(root, 'a', 'b', 0)).toBe(root)
  })

  it('a shuffled column prints in a fixed shuffled order and in order in the key', () => {
    const col: Box = { id: 'col', shuffle: true, children: ['1', '2', '3', '4'].map((id) => ({ id })) }
    const paper = printOrder(col, false).map((b) => b.id)
    expect(paper).not.toEqual(['1', '2', '3', '4'])
    expect(printOrder(col, false).map((b) => b.id)).toEqual(paper)
    expect(printOrder(col, true).map((b) => b.id)).toEqual(['1', '2', '3', '4'])
  })

  it('every ready-made type makes a fresh box each time', () => {
    for (const p of PRESETS) expect(p.make().id).not.toBe(p.make().id)
  })
})

describe('printing', () => {
  const doc = emptyDoc({
    examName: 'Half yearly', className: 'VIII', subject: 'Science', duration: '2 hours',
    body: { id: 'r', children: [
      Q('q1', 2, { children: [{ id: 't', content: '<p>Name the gas.</p>' }, { id: 'k', visible: 'key', content: '<p><strong>Answer:</strong> Oxygen</p>' }] }),
      { id: 'or', choice: true, number: { format: '1', pattern: '{n}.', scope: 'paper', counter: 'q' }, marks: { mode: 'best', best: 1, show: true, pattern: '[{m}]' }, children: [Q('x', 5, { number: undefined }), Q('y', 5, { number: undefined })] },
    ] },
  })

  it('carries the school letterhead, the exam and the total', () => {
    const html = renderPaperHtml(doc, school, false)
    expect(html).toContain('Test School')
    expect(html).toContain('1 Main Road')
    expect(html).toContain('Half yearly')
    expect(html).toContain('Max. Marks: 7')
  })

  it('keeps the answer out of the paper and puts it in the key', () => {
    expect(renderPaperHtml(doc, school, false)).not.toContain('Oxygen')
    const key = renderPaperHtml(doc, school, true)
    expect(key).toContain('Oxygen')
    expect(key).toContain('ANSWER KEY')
  })

  it('prints OR between the choices, in the paper language', () => {
    expect(renderPaperHtml(doc, school, false)).toContain('<div class="or">OR</div>')
    expect(renderPaperHtml({ ...doc, labelLang: 'hi' }, school, false)).toContain('अथवा')
  })

  it('drops anything the editor would not produce', () => {
    expect(sanitizeRich('<p onclick="x()">Hi<script>alert(1)</script></p><iframe src="x"></iframe>')).toBe('<p>Hi</p>')
    expect(sanitizeRich('<img data-id="abc" src="javascript:x" onerror="y">')).toBe('<img data-id="abc">')
  })
})

describe('files from the desktop QMaker', () => {
  const old: Question = { id: 'q1', templateId: 'mcq', subject: 'Science', chapter: 'Light', difficulty: 'easy', marks: 1, updatedAt: 1,
    data: { stem: 'Which is a source of light?', options: { items: ['Moon', 'Sun', 'Mirror', 'Book'], correct: 1 } } }

  it('turns an older multiple-choice question into a numbered box with its correct option', () => {
    const b = questionToBox(old, [])!
    expect(b.marks?.value).toBe(1)
    const opts = b.children!.find((c) => c.name === 'Options')!
    expect(opts.children!.map((c) => !!c.correct)).toEqual([false, true, false, false])
  })

  it('turns an older paper of sections into headed sections with "k × e = m"', () => {
    const q2: Question = { ...old, id: 'q2' }
    const body = paperToBox({ id: 'p', examName: '', subject: '', className: '', duration: '', date: '', instructions: '', answerSpace: true,
      sections: [{ id: 's', title: 'Section A', instruction: '', questionIds: ['q1', 'q2'] }] }, [old, q2], [])
    const sec = body.children![0]
    expect(sec.style?.rule).toBe(true)
    expect(marksLabel(sec)).toBe('2 × 1 = 2')
  })

  it('turns picture tokens into editor pictures', () => {
    expect(legacyToHtml('See [[img:abc-1|40|center]] below')).toBe('<p>See </p><p><img data-id="abc-1" data-width="40" data-align="center"></p><p> below</p>')
  })

  it('refuses a file that is not a QMaker file, and one from a newer version', () => {
    expect(() => parseBundle('{"hello":1}')).toThrow(/not a QMaker file/)
    expect(() => parseBundle('not json')).toThrow(/damaged/)
    expect(() => parseBundle(JSON.stringify({ format: 'qmaker', version: 2, questions: [], templates: [], papers: [] }))).toThrow(/newer/)
  })

  it('a paper saved here opens again with the same boxes', async () => {
    const doc = emptyDoc({ examName: 'Unit test', body: { id: 'r', children: [Q('q1', 4, { content: '<p>Explain.</p>' })] } })
    const back = readBundle(parseBundle(await paperFile(doc)))
    expect(back.kind).toBe('paper')
    expect(back.papers[0].examName).toBe('Unit test')
    expect(back.papers[0].body.children![0].content).toBe('<p>Explain.</p>')
  })

  it('reads a desktop bank file: its library and its older questions', () => {
    const file = JSON.stringify({ format: 'qmaker', kind: 'bank', version: 1, exportedAt: 0, templates: [], questions: [old], papers: [], library: [Q('lib1', 3, { content: '<p>Define refraction.</p>' })] })
    expect(readBundle(parseBundle(file)).questions.map((b) => b.id)).toEqual(['lib1', 'lib~q1'])
  })
})

describe('the bank', () => {
  it('files a box with marked options as multiple choice, with the options', () => {
    const f = bankFields(questionToBox({ id: 'q', templateId: 'mcq', subject: '', chapter: 'Light', difficulty: 'hard', marks: 1, updatedAt: 0,
      data: { stem: 'Pick one', options: { items: ['A', 'B'], correct: 0 } } }, [])!)
    expect(f).toMatchObject({ kind: 'mcq', stem: 'Pick one', options: [{ body: 'A', is_correct: true }, { body: 'B', is_correct: false }], difficulty: 'hard', chapter: 'Light' })
  })

  it('files a written answer as short up to 3 marks and long above, without the key text', () => {
    const box = (m: number) => Q('q', m, { children: [{ id: 't', content: '<p>Explain photosynthesis.</p>' }, { id: 'k', visible: 'key', content: '<p>Secret</p>' }] })
    expect(bankFields(box(3))).toMatchObject({ kind: 'short', stem: 'Explain photosynthesis.', default_marks: 3 })
    expect(bankFields(box(5)).kind).toBe('long')
  })

  it('draws a plain banked question the way the built-in types print', () => {
    const b = bankItemBox({ id: 'x', stem: 'Which is even?', kind: 'mcq', difficulty: 'easy', options: ['Three', 'Four'], correct: [false, true], default_marks: 2 })
    expect(b.marks?.value).toBe(2)
    expect(b.children![1].children!.map((c) => !!c.correct)).toEqual([false, true])
    expect(b.meta?.difficulty).toBe('easy')
  })

  it('a section adds up what is inside it', () => {
    const s = sectionBox('Section A', [Q('a', 2), Q('b', 2), Q('c', 2)])
    expect(marksLabel(s)).toBe('3 × 2 = 6')
  })

  it('plain text of a box keeps the words and marks pictures', () => {
    expect(richPlain('<p>See <img data-id="a"> the <strong>leaf</strong></p>')).toBe('See [picture] the leaf')
  })
})
