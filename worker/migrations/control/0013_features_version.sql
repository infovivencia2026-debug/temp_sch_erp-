-- 0013_features_version (CONTROL).
-- A version number on each school that bumps whenever one of its feature
-- switches changes (any write to school_feature_overrides), so the Worker can
-- keep a school's switches in memory and still see a change on the very next
-- request: tenant.ts institutionById notes the version it read on every
-- request, and routes/seller/features.ts featureOverrides serves its cached
-- rows only while that version is the one they were loaded under.
--
-- Restores what the "D1 health" commit (614d5bd9, control 0010) had and the
-- renumbering lost. Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

ALTER TABLE institutions ADD COLUMN features_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER IF NOT EXISTS features_bump_i AFTER INSERT ON school_feature_overrides BEGIN UPDATE institutions SET features_version = features_version + 1 WHERE id = NEW.institution_id; END;
CREATE TRIGGER IF NOT EXISTS features_bump_u AFTER UPDATE ON school_feature_overrides BEGIN UPDATE institutions SET features_version = features_version + 1 WHERE id IN (OLD.institution_id, NEW.institution_id); END;
CREATE TRIGGER IF NOT EXISTS features_bump_d AFTER DELETE ON school_feature_overrides BEGIN UPDATE institutions SET features_version = features_version + 1 WHERE id = OLD.institution_id; END;
