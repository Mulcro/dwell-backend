-- The recap screens (design 08). The end-of-challenge summary now carries the same
-- structure as the pulse -- a headline, a line per member, and how many days the group
-- showed up -- and a weekly recap of the same shape joins the insight types, written by
-- the Monday cron for the week just ended.

alter type insight_type add value if not exists 'weekly_recap';

comment on column ai_insights.payload is
  'Structured card. group_pulse: { headline, lede, members: [{ user_id, line }], '
  'reflection_count }. end_summary, fallback_recap and weekly_recap: { headline, members, '
  'days_showed_up, days_total, reflection_count }, and weekly_recap adds week_start. '
  'Null for prose-only types.';
