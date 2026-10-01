-- A member joining has to arrive on its own.
--
-- Only ai_insights and day_instances were published, so nothing about a group's own
-- shape reached a subscriber: the invite screen could not see someone accept, and a
-- group going forming -> active when the second member joined never appeared. The
-- client was polling every 8 seconds to paper over it, which is both slow and wasteful
-- on exactly the screen people stare at during a demo.
--
-- Realtime still applies RLS per subscriber, so adding these publishes nothing that the
-- subscriber could not already read: group_members and groups both route their select
-- policies through is_group_member().

alter publication supabase_realtime add table public.groups;
alter publication supabase_realtime add table public.group_members;

-- Both need FULL replica identity, like the two tables already published: Realtime
-- re-checks RLS against the row it is about to send, and a key-only image is not enough
-- to do that. It also lets the client tell a status change from an unrelated edit.
alter table public.groups replica identity full;
alter table public.group_members replica identity full;
