-- One closing summary per challenge and one weekly recap per group per week, enforced
-- where it can actually hold: in the database. The functions check before they insert,
-- but two ends of a challenge or two overlapping cron runs can both pass that check, and
-- a check-then-insert in a function is a race, not a rule.

-- Keep the earliest of any duplicates that slipped through before the rule existed.
delete from ai_insights a
 using ai_insights b
 where a.group_id = b.group_id
   and a.type in ('end_summary', 'fallback_recap')
   and b.type in ('end_summary', 'fallback_recap')
   and a.created_at > b.created_at;

create unique index ai_insights_one_closing_summary
  on ai_insights (group_id)
  where type in ('end_summary', 'fallback_recap');

create unique index ai_insights_one_weekly_recap
  on ai_insights (group_id, (payload->>'week_start'))
  where type = 'weekly_recap';
