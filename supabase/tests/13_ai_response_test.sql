-- The personalized response has its own column (design doc 1.1) rather than being
-- smuggled into translated_text, which means translations only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

select has_column('public', 'reflections', 'ai_response',
  'reflections stores the personalized response');
select col_type_is('public', 'reflections', 'ai_response', 'text',
  'ai_response is plain text');

insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');
insert into groups (id, name, plan_challenge_id, created_by)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'G',
        '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111');
insert into day_instances (id, group_id, day_index, date, passage_ref)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        1, current_date, 'HEB.6.19');
insert into reflections (user_id, day_instance_id, media_type, content, language,
                         translated_text, ai_response)
values ('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        'text', 'hi', 'en', '{"es": "hola"}'::jsonb, 'Thank you for sharing.');

-- translated_text must hold translations and nothing else.
select is(
  (select translated_text from reflections
   where day_instance_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  '{"es": "hola"}'::jsonb,
  'translated_text carries only language-keyed translations');

select * from finish();
rollback;
