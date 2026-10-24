/* Question maker: drafts written in the browser, sent for approval as a frozen
   copy, pictures named for the image store, and questions banked with the box
   they print as. Uses its own exams so the shared paper is left alone. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const EXAM = id(900), PAPER = id(901), OTHER_CLASS = id(902), OTHER_SECTION = id(903), OTHER_CS = id(904), OTHER_PAPER = id(905)
const IMAGE = id(906), PDF = id(907)

const doc = (text: string) => ({
  examName: 'Half yearly', className: 'Class 5', subject: 'Mathematics', duration: '2 hours', date: '',
  body: { id: 'root', children: [{ id: 'q1', number: { format: '1', pattern: '{n}.', scope: 'paper', counter: 'q' }, marks: { mode: 'fixed', value: 2, show: true }, content: `<p>${text}</p>` }] },
})

beforeAll(async () => {
  await seed()
  const T = E.TENANT_TEST
  const campus = (await T.prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  const t = new Date().toISOString()
  await T.batch([
    T.prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on) VALUES (?, ?, ?, ?, 'Maker term', 'term', '2026-01-01', '2026-01-05')`)
      .bind(EXAM, IDS.school, campus, IDS.year),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '80', '28')`)
      .bind(PAPER, IDS.school, EXAM, IDS.classSubject),
    // A class the test teacher neither teaches nor heads.
    T.prepare(`INSERT INTO classes (id, institution_id, campus_id, name, level) VALUES (?, ?, ?, 'Class 10', 10)`).bind(OTHER_CLASS, IDS.school, campus),
    T.prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) VALUES (?, ?, ?, ?, ?, 'C')`)
      .bind(OTHER_SECTION, IDS.school, campus, OTHER_CLASS, IDS.year),
    T.prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(OTHER_CS, IDS.school, OTHER_CLASS, IDS.subject),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '80', '28')`)
      .bind(OTHER_PAPER, IDS.school, EXAM, OTHER_CS),
    T.prepare(`INSERT INTO files (id, institution_id, object_key, original_name, content_type, size_bytes, checksum_sha256, purpose, uploaded_by, created_at)
        VALUES (?, ?, 'k/img', 'leaf.png', 'image/png', 10, 'x', 'question_paper', ?, ?)`).bind(IMAGE, IDS.school, IDS.teacher, t),
    T.prepare(`INSERT INTO files (id, institution_id, object_key, original_name, content_type, size_bytes, checksum_sha256, purpose, uploaded_by, created_at)
        VALUES (?, ?, 'k/pdf', 'paper.pdf', 'application/pdf', 10, 'x', 'question_paper', ?, ?)`).bind(PDF, IDS.school, IDS.teacher, t),
  ])
})

describe('drafts', () => {
  let draft = ''
  let stamp = ''

  it('a teacher starts a paper and finds it in their list', async () => {
    const r = await api('teacher', 'POST', '/exams/paper-drafts', { title: 'Maths half yearly', doc: doc('Add 2 and 3.') })
    expect(r.status).toBe(201)
    draft = r.body.id
    stamp = r.body.updated_at
    const list = await api('teacher', 'GET', '/exams/paper-drafts')
    expect(list.body.items.map((d: { id: string }) => d.id)).toContain(draft)
    const one = await api('teacher', 'GET', `/exams/paper-drafts/${draft}`)
    expect(one.body.doc.body.children[0].content).toBe('<p>Add 2 and 3.</p>')
  })

  it('nobody else can open, change or delete it', async () => {
    expect((await api('admin', 'GET', `/exams/paper-drafts/${draft}`)).status).toBe(404)
    expect((await api('admin', 'PUT', `/exams/paper-drafts/${draft}`, { doc: doc('x') })).status).toBe(404)
    expect((await api('admin', 'DELETE', `/exams/paper-drafts/${draft}`)).status).toBe(404)
    expect((await api('admin', 'GET', '/exams/paper-drafts')).body.items.map((d: { id: string }) => d.id)).not.toContain(draft)
  })

  it('a parent cannot reach the maker at all', async () => {
    expect((await api('parent', 'GET', '/exams/paper-drafts')).status).toBe(403)
    expect((await api('parent', 'POST', '/exams/paper-drafts', { doc: doc('x') })).status).toBe(403)
  })

  it('refuses what is not a paper, a picture pasted inline, and a paper too large to keep', async () => {
    expect((await api('teacher', 'POST', '/exams/paper-drafts', { doc: { body: 'nope' } })).status).toBe(400)
    const inline = doc('<img src="data:image/png;base64,AAAA">')
    expect((await api('teacher', 'POST', '/exams/paper-drafts', { doc: inline })).body.error).toMatch(/not uploaded/)
    const huge = doc('x'.repeat(1_600_000))
    expect((await api('teacher', 'POST', '/exams/paper-drafts', { doc: huge })).body.error).toMatch(/too large/)
  })

  it('saves, and refuses a save from a window that is behind', async () => {
    const r = await api('teacher', 'PUT', `/exams/paper-drafts/${draft}`, { doc: doc('Add 4 and 5.'), base_updated_at: stamp })
    expect(r.status).toBe(200)
    const stale = await api('teacher', 'PUT', `/exams/paper-drafts/${draft}`, { doc: doc('Old tab.'), base_updated_at: stamp })
    expect(stale.status).toBe(409)
    expect((await api('teacher', 'GET', `/exams/paper-drafts/${draft}`)).body.doc.body.children[0].content).toBe('<p>Add 4 and 5.</p>')
  })

  it('will not tie a draft to an exam of a class the teacher does not teach', async () => {
    expect((await api('teacher', 'PUT', `/exams/paper-drafts/${draft}`, { exam_subject_id: OTHER_PAPER })).status).toBe(403)
    expect((await api('teacher', 'POST', `/exams/paper-drafts/${draft}/send`, { exam_subject_id: OTHER_PAPER })).status).toBe(403)
    expect((await api('teacher', 'POST', `/exams/paper-drafts/${draft}/send`, {})).status).toBe(400)
  })

  it('sending freezes a copy: later edits to the draft do not change what was sent', async () => {
    const sent = await api('teacher', 'POST', `/exams/paper-drafts/${draft}/send`, { exam_subject_id: PAPER, notes: 'Units 1 to 4' })
    expect(sent.status).toBe(200)
    await api('teacher', 'PUT', `/exams/paper-drafts/${draft}`, { doc: doc('Changed after sending.') })
    const papers = await api('admin', 'GET', '/exams/question-papers')
    const row = papers.body.items.find((p: { exam_name: string; class: string }) => p.exam_name === 'Maker term' && p.class === 'Class 5')
    expect(row.status).toBe('submitted')
    expect(row.has_doc).toBe(true)
    expect(row.file_id).toBeNull()
    const read = await api('admin', 'GET', `/exams/question-papers/${row.id}/doc`)
    expect(read.body.doc.body.children[0].content).toBe('<p>Add 4 and 5.</p>')
    expect((await api('teacher', 'GET', `/exams/question-papers/${row.id}/doc`)).status).toBe(200)
    expect((await api('parent', 'GET', `/exams/question-papers/${row.id}/doc`)).status).toBe(403)
    const list = await api('teacher', 'GET', '/exams/paper-drafts')
    expect(list.body.items.find((d: { id: string }) => d.id === draft).sent_status).toBe('submitted')
  })

  it('an approved paper is not replaced by sending again', async () => {
    const papers = await api('admin', 'GET', '/exams/question-papers')
    const row = papers.body.items.find((p: { exam_name: string; class: string }) => p.exam_name === 'Maker term' && p.class === 'Class 5')
    expect((await api('admin', 'POST', `/exams/question-papers/${row.id}/decide`, { decision: 'approved' })).status).toBe(200)
    const again = await api('teacher', 'POST', `/exams/paper-drafts/${draft}/send`, { exam_subject_id: PAPER })
    expect(again.status).toBe(409)
    expect((await api('admin', 'GET', `/exams/question-papers/${row.id}/doc`)).body.doc.body.children[0].content).toBe('<p>Add 4 and 5.</p>')
  })

  it('deleting the draft keeps the sent copy', async () => {
    expect((await api('teacher', 'DELETE', `/exams/paper-drafts/${draft}`)).status).toBe(200)
    expect((await api('teacher', 'GET', `/exams/paper-drafts/${draft}`)).status).toBe(404)
    const papers = await api('admin', 'GET', '/exams/question-papers')
    const row = papers.body.items.find((p: { exam_name: string; class: string }) => p.exam_name === 'Maker term' && p.class === 'Class 5')
    expect((await api('admin', 'GET', `/exams/question-papers/${row.id}/doc`)).status).toBe(200)
  })
})

describe('pictures', () => {
  it('the uploader names a picture and anyone setting papers finds it by name', async () => {
    const r = await api('teacher', 'POST', '/exams/paper-images', { file_id: IMAGE, name: 'Leaf cross section', width: 800, height: 600 })
    expect(r.status).toBe(201)
    const found = await api('teacher', 'GET', '/exams/paper-images?q=leaf')
    expect(found.body.items[0]).toMatchObject({ file_id: IMAGE, name: 'Leaf cross section', width: 800, height: 600 })
    expect((await api('teacher', 'GET', '/exams/paper-images?q=volcano')).body.items).toHaveLength(0)
    const byId = await api('teacher', 'GET', `/exams/paper-images?ids=${IMAGE},${PDF}`)
    expect(byId.body.items.map((x: { file_id: string }) => x.file_id)).toEqual([IMAGE])
    expect((await api('teacher', 'GET', '/exams/paper-images?ids=not-an-id')).status).toBe(400)
  })

  it('refuses a file someone else uploaded, a file that is not a picture, and a picture with no size', async () => {
    expect((await api('admin', 'POST', '/exams/paper-images', { file_id: IMAGE, name: 'Mine now', width: 1, height: 1 })).status).toBe(404)
    expect((await api('teacher', 'POST', '/exams/paper-images', { file_id: PDF, name: 'A pdf', width: 1, height: 1 })).status).toBe(400)
    expect((await api('teacher', 'POST', '/exams/paper-images', { file_id: IMAGE, name: 'No size', width: 0, height: 0 })).status).toBe(400)
  })
})

describe('question bank with printed boxes', () => {
  const box = (text: string) => ({ id: crypto.randomUUID(), number: { format: '1', pattern: '{n}.', scope: 'paper' }, marks: { mode: 'fixed', value: 3, show: true }, content: `<p>${text}</p>` })

  it('a question keeps the box it prints as, through list, read and compose', async () => {
    const r = await api('teacher', 'POST', '/teaching/question-bank', {
      class_subject_id: IDS.classSubject, kind: 'short', difficulty: 'hard', stem: 'Prove the angle sum of a triangle.', default_marks: 3,
      body: box('Prove the <strong>angle sum</strong> of a triangle.'),
    })
    expect(r.status).toBe(200)
    const one = await api('teacher', 'GET', `/teaching/question-bank/${r.body.id}`)
    expect(one.body.body.content).toContain('<strong>angle sum</strong>')
    const list = await api('teacher', 'GET', `/teaching/question-bank?class_subject_id=${IDS.classSubject}&search=angle`)
    expect(list.body.items[0].body.content).toContain('angle sum')
    const drawn = await api('teacher', 'POST', '/teaching/question-bank/compose', {
      class_subject_id: IDS.classSubject, rows: [{ difficulty: 'hard', kind: 'short', marks: 3, count: 1 }],
    })
    expect(drawn.body.sections[0].questions[0].body.content).toContain('angle sum')
  })

  it('a drawn multiple-choice question says which option is correct', async () => {
    await api('teacher', 'POST', '/teaching/question-bank', {
      class_subject_id: IDS.classSubject, kind: 'mcq', difficulty: 'easy', stem: 'Which is even?', default_marks: 7,
      options: [{ body: 'Three', is_correct: false }, { body: 'Four', is_correct: true }],
    })
    const drawn = await api('teacher', 'POST', '/teaching/question-bank/compose', {
      class_subject_id: IDS.classSubject, rows: [{ kind: 'mcq', marks: 7, count: 1 }],
    })
    expect(drawn.body.sections[0].questions[0]).toMatchObject({ options: ['Three', 'Four'], correct: [false, true] })
  })

  it('refuses a box with a picture pasted inline', async () => {
    const bad = { ...box('x'), content: '<img src="data:image/png;base64,AAAA">' }
    const r = await api('teacher', 'POST', '/teaching/question-bank', { class_subject_id: IDS.classSubject, kind: 'short', stem: 'x', body: bad })
    expect(r.status).toBe(400)
  })

  it('imports many at once, all or nothing, and only into a subject the teacher teaches', async () => {
    const before = (await api('teacher', 'GET', `/teaching/question-bank?class_subject_id=${IDS.classSubject}`)).body.items.length
    const good = { kind: 'short', difficulty: 'easy', stem: 'Name a prime number.', default_marks: 1, body: box('Name a prime number.') }
    const broken = await api('teacher', 'POST', '/teaching/question-bank/import', { class_subject_id: IDS.classSubject, items: [good, { ...good, stem: '' }] })
    expect(broken.status).toBe(400)
    expect(broken.body.error).toMatch(/question 2/)
    expect((await api('teacher', 'GET', `/teaching/question-bank?class_subject_id=${IDS.classSubject}`)).body.items.length).toBe(before)
    const r = await api('teacher', 'POST', '/teaching/question-bank/import', { class_subject_id: IDS.classSubject, items: [good, { ...good, stem: 'Name an even prime.' }] })
    expect(r.body).toEqual({ added: 2 })
    expect((await api('teacher', 'GET', `/teaching/question-bank?class_subject_id=${IDS.classSubject}`)).body.items.length).toBe(before + 2)
    expect((await api('teacher', 'POST', '/teaching/question-bank/import', { class_subject_id: OTHER_CS, items: [good] })).status).toBe(403)
    expect((await api('parent', 'POST', '/teaching/question-bank/import', { class_subject_id: IDS.classSubject, items: [good] })).status).toBe(403)
  })
})
