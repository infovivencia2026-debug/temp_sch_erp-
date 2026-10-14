-- PF for one person (Yajur, 2026-10-14: "PF should be by our choice per person").
-- 'default' follows the school-wide rule, so nothing changes until somebody
-- picks otherwise; 'none' takes no PF; 'basic' / 'basic_da' set the PF wage for
-- this person only. pf_percent, when set, replaces the employee PF % for them.
-- Forward-only: once applied anywhere this file must not change.
ALTER TABLE employees ADD COLUMN pf_mode TEXT NOT NULL DEFAULT 'default';
ALTER TABLE employees ADD COLUMN pf_percent REAL;
