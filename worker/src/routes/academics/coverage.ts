/* SYLLABUS COVERAGE, ONE SOURCE (2026-11-13). Teachers record chapter progress
   in Lesson plan -> Chapters (chapter_progress); older schools ticked units off
   through delivered lesson plans (lesson_plans.delivered_on). Every coverage
   figure reads this view of both, so nothing recorded either way is lost.

   One row per (section_id, class_subject_id, unit_id) for top-level active
   chapters only, with w = 1 when completed and 0.5 when ongoing (the same
   weighting ChapterPlan uses for its progress bar). */
export const COVERED_SQL = `(
  SELECT section_id, class_subject_id, unit_id, max(w) AS w FROM (
    SELECT p.section_id, u.class_subject_id, u.id AS unit_id,
           CASE p.status WHEN 'completed' THEN 1.0 ELSE 0.5 END AS w
      FROM chapter_progress p JOIN syllabus_units u ON u.id = p.unit_id
     WHERE u.parent_unit_id IS NULL AND u.is_active = 1 AND p.status IN ('completed', 'ongoing')
    UNION ALL
    -- From its sub-topics: all completed = 1, any started = 0.5.
    SELECT p.section_id, ch.class_subject_id, ch.id,
           CASE WHEN sum(p.status = 'completed') = (SELECT count(*) FROM syllabus_units x WHERE x.parent_unit_id = ch.id AND x.is_active = 1) THEN 1.0 ELSE 0.5 END
      FROM chapter_progress p JOIN syllabus_units s ON s.id = p.unit_id AND s.is_active = 1
      JOIN syllabus_units ch ON ch.id = s.parent_unit_id
     WHERE ch.parent_unit_id IS NULL AND ch.is_active = 1 AND p.status IN ('completed', 'ongoing')
     GROUP BY p.section_id, ch.id
    UNION ALL
    SELECT lp.section_id, lp.class_subject_id, u.id, 1.0
      FROM lesson_plans lp JOIN lesson_plan_units lpu ON lpu.lesson_plan_id = lp.id
      JOIN syllabus_units u ON u.id = lpu.syllabus_unit_id
     WHERE lp.delivered_on IS NOT NULL AND u.parent_unit_id IS NULL AND u.is_active = 1
  ) GROUP BY section_id, class_subject_id, unit_id)`

/** Chapters (top-level active syllabus units) only. */
export const CHAPTER_WHERE = (u: string) => `${u}.is_active = 1 AND ${u}.parent_unit_id IS NULL`
