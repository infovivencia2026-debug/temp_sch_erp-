-- 0105_question_maker (tenant: every school database).
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.
--
-- Question maker (owner, 2026-10-21: "the entire qmaker in the website").
-- A paper is written on an A4 page in the browser as a tree of boxes (JSON).
--
-- question_bank_questions.body   the question as printed: one box, JSON. stem
--                                stays its plain text, for search and online tests.
-- question_paper_drafts          a teacher's papers while they write them.
-- question_papers.doc            the paper as sent for approval, frozen, so the
--                                head of department approves exactly what was sent.
-- question_papers.draft_id       the draft it was sent from (no foreign key: the
--                                teacher may delete the draft, the sent copy stays).
-- question_maker_images          pictures used in papers and the bank, by name,
--                                so a teacher can find one again. Bytes are in files.

ALTER TABLE question_bank_questions ADD COLUMN body TEXT;

ALTER TABLE question_papers ADD COLUMN doc TEXT;
ALTER TABLE question_papers ADD COLUMN draft_id TEXT;

CREATE TABLE IF NOT EXISTS question_paper_drafts (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  exam_subject_id TEXT REFERENCES exam_subjects (id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  doc TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS question_paper_drafts_owner ON question_paper_drafts (created_by, updated_at);

CREATE TABLE IF NOT EXISTS question_maker_images (
  file_id TEXT NOT NULL PRIMARY KEY REFERENCES files (id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS question_maker_images_name ON question_maker_images (name COLLATE NOCASE);
