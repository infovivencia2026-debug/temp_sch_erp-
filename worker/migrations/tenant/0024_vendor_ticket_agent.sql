-- 0024_vendor_ticket_agent (tenant: every school database).
-- Who on the vendor's support desk has a ticket. support_tickets.assigned_to
-- references this school's own users, and a platform support account is not
-- one of them, so "Take" on the vendor's queue could change the status and
-- never say whose ticket it now was. The agent is recorded by name and by
-- platform account id; no foreign key, because platform_users live in
-- CONTROL and not in a school's database.
--
-- Additive. Forward-only. No BEGIN/COMMIT (D1 rejects them).

ALTER TABLE support_tickets ADD COLUMN vendor_agent_id TEXT;
ALTER TABLE support_tickets ADD COLUMN vendor_agent_name TEXT;
