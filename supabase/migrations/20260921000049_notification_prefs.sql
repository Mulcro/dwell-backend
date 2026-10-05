-- KAN-22 ask 5: per-type notification preferences, honoured before anything is sent.
--
-- The Settings switches used to live only on the phone, so they governed nothing: a push
-- arrives on the lock screen whether or not the app agrees. The choice now lives on the
-- member's own row, and send-push -- the one place every sender goes through -- checks
-- it before calling Apple. Keys match the `type` each push carries. A missing key means
-- on, so the default is every type on and a new type is on until someone turns it off.
--
--   nudge              Reminder nudges
--   friends_posts      Friends' posts                    (no sender yet)
--   reply              Comments, reactions & mentions    (replies today)
--   returning_friends  Returning friends                 (no sender yet)
--   streaks_memories   Streaks & memories                (no sender yet)

alter table users
  add column notification_prefs jsonb not null default '{}'::jsonb;

-- Only known switches, only true or false. A function because a check constraint cannot
-- hold a subquery.
create or replace function public.valid_notification_prefs(prefs jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select jsonb_typeof(prefs) = 'object'
     and not exists (
       select 1 from jsonb_each(prefs) e
        where e.key not in ('nudge', 'friends_posts', 'reply', 'returning_friends', 'streaks_memories')
           or jsonb_typeof(e.value) <> 'boolean'
     )
$$;

alter table users add constraint notification_prefs_shape
  check (public.valid_notification_prefs(notification_prefs));

comment on column users.notification_prefs is
  'Per-type push switches, e.g. {"nudge": false}. A missing key is on. Checked by send-push '
  'before every push; the in-app record is unaffected.';

-- The owner writes it from Settings, through the existing "update own profile" policy.
grant update (notification_prefs) on users to authenticated;
