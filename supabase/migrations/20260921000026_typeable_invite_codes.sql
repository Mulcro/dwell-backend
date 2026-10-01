-- Invite codes a person can actually read out and type.
--
-- The original token was 12 base64url characters, chosen in the design doc because it
-- rides in a magic link. The redesigned join screen asks for a SIX character code typed
-- into six boxes, which that format cannot satisfy: twice too long, case-sensitive, and
-- containing - and _ . The client compensated by truncating and upper-casing, which
-- produces a code that can never match. Short wins, because the code is read aloud and
-- typed by hand; a share link carries a six-character code just as happily.

create or replace function public.generate_invite_code()
returns text
language plpgsql
set search_path = public, extensions
as $$
declare
  -- No vowels, so a code can never land on a real word -- this gets shown in a church
  -- small group. No 0/1/I/L/O either, which are the pairs people misread aloud.
  alphabet constant text := '23456789BCDFGHJKMNPQRSTVWXYZ';
  n constant int := length(alphabet);
  -- Largest multiple of n below 256. Bytes at or above it are discarded rather than
  -- folded, which would quietly make the first few letters more likely than the rest.
  ceiling constant int := 256 - (256 % n);
  code text;
  b int;
begin
  loop
    code := '';
    while length(code) < 6 loop
      b := get_byte(extensions.gen_random_bytes(1), 0);
      if b < ceiling then
        code := code || substr(alphabet, 1 + (b % n), 1);
      end if;
    end loop;
    -- 28^6 is ~482 million, so a collision is remote, but a duplicate would hand two
    -- groups the same code and send a joiner to the wrong one. Cheap to rule out.
    exit when not exists (select 1 from groups where invite_token = code);
  end loop;
  return code;
end;
$$;

-- Server-side only, like every other helper: a client has no reason to mint codes.
revoke all on function public.generate_invite_code() from public, anon, authenticated;

alter table groups alter column invite_token set default public.generate_invite_code();

-- Existing groups carry the old 12-character tokens. Their share links are already out
-- there, but nothing is live yet and a code the join screen cannot accept is worse.
update groups set invite_token = public.generate_invite_code();

alter table groups add constraint invite_token_is_typeable
  check (invite_token ~ '^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$');

-- Lookup forgives how the code was typed: lower case from a pasted link, and the spaces
-- or dashes people add when reading one out. Normalizing the ARGUMENT rather than the
-- column keeps the unique index usable.
create or replace function public.preview_group(token text)
returns table (name text, plan_title text)
language sql
security definer
stable
set search_path = public
as $$
  select g.name, pc.title
  from groups g
  join plan_challenges pc on pc.id = g.plan_challenge_id
  where g.invite_token = upper(regexp_replace(token, '[^0-9A-Za-z]', '', 'g'))
$$;

revoke all on function public.preview_group(text) from public;
grant execute on function public.preview_group(text) to anon, authenticated;
