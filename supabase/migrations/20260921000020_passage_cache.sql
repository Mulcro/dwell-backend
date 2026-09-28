-- Read-through cache for YouVersion passage text.
--
-- Every member of every group fetches the same seven passages over a challenge, and
-- scripture text does not change, so there is no TTL: a row is written once and read
-- forever. This also keeps YOUVERSION_APP_KEY server-side -- the client never holds it.

create table passage_cache (
  bible_id int not null,
  passage_ref text not null,
  reference text not null,          -- localized, e.g. "2 Corinthians 4:16-18"
  translation text not null,        -- abbreviation, e.g. "BSB"
  content text not null,
  audio_url text,
  fetched_at timestamptz not null default now(),
  primary key (bible_id, passage_ref)
);

alter table passage_cache enable row level security;

-- Public scripture text: any signed-in user may read it. Writes go through
-- /get-passage under the service role, so there is deliberately no insert policy.
create policy "read cached passages" on passage_cache
  for select to authenticated using (true);

revoke insert, update, delete on passage_cache from authenticated, anon;
