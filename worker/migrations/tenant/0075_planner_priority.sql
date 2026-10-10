-- A planner item can be urgent (owner, 2026-10-10: the student planner design
-- has Normal / Urgent). Additive; every existing note is 'normal'.
-- Forward-only: once applied anywhere this file must not change.
ALTER TABLE student_diary_notes ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
