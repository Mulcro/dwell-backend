-- Item 42: faces, and the waveform that goes with a stored recording.
--
-- users carried name, language and timezone only, so every member rendered as a
-- monogram -- in the sealed-day avatar row, the Start-or-Join cluster, the feed, Group
-- Pulse and the weekly recap. The client kept its own picture in device-local storage,
-- where nobody else could ever see it.

alter table users add column avatar_url text;

comment on column users.avatar_url is
  'Profile picture. Seeded from the identity provider, editable by the owner.';

-- Google and Apple both put it in the same metadata the trigger already reads for name;
-- they just disagree on the key.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, name, preferred_language, timezone, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', 'Friend'),
    'en',
    'UTC',
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Everyone who signed in before today already has a picture sitting unread in their
-- provider metadata. No reason to make them sign in again to pick it up.
update public.users u
set avatar_url = coalesce(a.raw_user_meta_data->>'avatar_url', a.raw_user_meta_data->>'picture')
from auth.users a
where a.id = u.id and u.avatar_url is null;

-- Waveform for the feed's player, computed on-device while recording. Stored so the
-- feed can draw it without downloading and decoding the audio first. Values are
-- normalized 0-100, which is all a drawn waveform needs and keeps the row small.
alter table reflections add column media_peaks smallint[];

comment on column reflections.media_peaks is
  'Waveform amplitudes, normalized 0-100, at most 512 samples.';

alter table reflections add constraint media_peaks_is_drawable
  check (
    media_peaks is null
    -- coalesce, because array_length of an empty array is NULL, and a CHECK whose
    -- expression evaluates to NULL PASSES. Without it '{}' is quietly accepted.
    or (coalesce(array_length(media_peaks, 1), 0) between 1 and 512
        and 0 <= all (media_peaks)
        and 100 >= all (media_peaks))
  );
