-- The companion's reply needs translating too.
--
-- `ai_response` is written in the author's language, so in a bilingual group it is the
-- one part of the thread nobody else can read: the reflection is translated, the replies
-- are translated, and the companion's answer sitting between them is not.
--
-- Same shape and semantics as every other translation column, so the client reads it the
-- way it already reads the rest.

alter table reflections add column ai_response_translated jsonb;

comment on column reflections.ai_response_translated is
  'The companion''s reply, keyed by the language translated INTO. Null when every '
  'group-mate already reads the author''s language.';
