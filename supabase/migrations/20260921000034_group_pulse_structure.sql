-- Group Pulse: the card needs structure, not one prose block.
--
-- ai_insights carried a single `content` string, which covers exactly one element of the
-- design (the standfirst). The headline, the lede and the per-member commitments are all
-- things only the model that read the reflections can produce, and none of them had
-- anywhere to live.
--
-- One jsonb column rather than a column each: the shape differs per pulse variant, and
-- the variants are prompt changes, not schema changes.

alter table ai_insights
  add column payload jsonb,
  add column language text not null default 'en',
  add column translated_text jsonb;

comment on column ai_insights.payload is
  'Structured pulse: { headline, lede, members: [{ user_id, line }] }. Null for insight '
  'types that are prose only.';
comment on column ai_insights.language is
  'What the insight was authored in. Everything the model writes is English today.';
comment on column ai_insights.translated_text is
  'Keyed by the language translated INTO, each holding the same shape as payload plus '
  'summary. Null when every group-mate already reads `language`.';
