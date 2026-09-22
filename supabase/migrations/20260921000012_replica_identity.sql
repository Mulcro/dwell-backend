-- Realtime evaluates RLS against the replicated row. With the default replica identity
-- an UPDATE only writes the primary key into the WAL, so the policy's is_group_member
-- (group_id) check has no group_id to work with and the message is silently dropped --
-- the subscriber stays connected and simply never hears anything.
--
-- FULL makes the whole row available to that check. Both published tables need it.
-- Cost is negligible here: day_instances rows are small, and ai_insights is insert-only
-- in practice, so no old tuple is written for it.

alter table day_instances replica identity full;
alter table ai_insights replica identity full;
