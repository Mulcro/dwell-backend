-- open_ready_next_days(p_now, p_group_id): a targeted sweep touches only that group.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');

-- Two groups, both due. Only the first is named.
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Named',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Bystander',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active');

insert into day_instances (group_id, day_index, date, passage_ref, opened_at, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, current_date, 'PSA.34.18', now() - interval '25 hours', 'threshold_met'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, current_date, 'PSA.34.18', now() - interval '25 hours', 'threshold_met');

select public.open_ready_next_days(now(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

select is((select count(*)::int from day_instances where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  2, 'the named group advances');
select is((select count(*)::int from day_instances where group_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1, 'a group that was not named is left alone, even though it is due');
select is((select status::text from day_instances
           where group_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and day_index = 1),
  'threshold_met', 'and its cleared day is still waiting for the real sweep');

-- No group: the cron's call, which sweeps everyone as before.
select public.open_ready_next_days();
select is((select count(*)::int from day_instances where group_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  2, 'the unfiltered sweep still advances every due group');

select * from finish();
rollback;
