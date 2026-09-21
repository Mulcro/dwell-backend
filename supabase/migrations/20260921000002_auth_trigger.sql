-- Seeds a public.users profile the moment Supabase Auth creates the auth user.
-- Provider-agnostic: works for Apple/Google today and YouVersion OIDC later.
-- timezone/preferred_language are placeholders; the client overwrites them post-login.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, name, preferred_language, timezone)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', 'Friend'), 'en', 'UTC')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
