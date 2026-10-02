-- A photo reflection must be accompanied by words.
--
-- Two reasons this is a constraint and not only a check in the function. The first is the
-- product rule: a photo posted into a group with nothing said about it is not a
-- reflection. The second is that the existing media_matches_type constraint demanded a
-- TRANSCRIPT for any non-text reflection carrying media -- written when voice was the
-- only kind there was. A photo has no transcript, so every photo reflection would have
-- been refused at insert. The handler never saw it because its tests stub the database.

alter table reflections drop constraint media_matches_type;

alter table reflections add constraint media_matches_type check (
  -- text: words, and nothing attached.
  (media_type = 'text' and media_path is null)
  -- voice: a transcript, because that is what moderation and translation read.
  or (media_type = 'voice' and (media_path is null or transcript is not null))
  -- photo: an image, and something said about it.
  or (media_type = 'photo' and media_path is not null
      and content is not null and btrim(content) <> '')
);
