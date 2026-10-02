-- Item 44: a reply reaches each reader in their own language, as a reflection does.
--
-- A group that needs translation to read each other's reflections needs it just as much
-- for the replies -- otherwise the conversation under a translated reflection is the one
-- part nobody can follow.
--
-- Same two columns and the same semantics as reflections, so there is nothing new on
-- either side.

alter table comments
  add column language text not null default 'en',
  add column translated_text jsonb;

comment on column comments.language is
  'What the reply was written in. For a voice reply, the recognizer''s locale.';
comment on column comments.translated_text is
  'Keyed by the language translated INTO. Null when every group-mate already reads the '
  'author''s language.';
