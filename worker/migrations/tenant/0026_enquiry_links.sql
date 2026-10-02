-- 0026_enquiry_links (tenant: every school database).
-- A link a school hands to a family that wants to enquire: on the website,
-- in a WhatsApp reply, on a poster as a QR code. Whoever opens it fills in a
-- short form and lands in the enquiry list as a lead, with the link's name
-- as the campaign, so the school can see which channel brought whom.
-- A school keeps as many as it has channels. `ask` holds which optional
-- questions the form puts ('off' | 'optional' | 'required' per question);
-- the child's name, a parent's name and a phone number are always asked.
--
-- Additive. Forward-only. No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE enquiry_links (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  campus_id TEXT REFERENCES campuses (id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  -- what enquiries.source is set to: walk_in | phone | website | referral | campaign | other
  source TEXT NOT NULL DEFAULT 'website',
  is_open INTEGER NOT NULL DEFAULT 1,
  heading TEXT,
  intro TEXT,
  thanks TEXT,
  ask TEXT NOT NULL DEFAULT '{}',
  -- offer "Continue to the application" after the enquiry, on this form
  apply_form_id TEXT REFERENCES admission_forms (id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX enquiry_links_slug ON enquiry_links (slug);
CREATE UNIQUE INDEX enquiry_links_name ON enquiry_links (institution_id, lower(name));
CREATE INDEX enquiries_utm_campaign ON enquiries (utm_campaign) WHERE utm_campaign IS NOT NULL;
