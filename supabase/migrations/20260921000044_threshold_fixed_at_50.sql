-- KAN-44: the unlock threshold is 50% for every group, existing ones included.
--
-- create-group no longer accepts a threshold, and this brings the groups made before
-- that rule into line. A day that was already past 50% but short of its old bar is
-- flipped the way the next approval would have flipped it; its pulse is written on that
-- next approval, since the dispatch belongs to the trigger. The column stays so the
-- threshold math is untouched; it simply always holds 50 from here on.

update groups set catch_up_threshold_pct = 50 where catch_up_threshold_pct <> 50;

update day_instances d
   set status = 'threshold_met'
  from groups g
 where g.id = d.group_id
   and d.status = 'open'
   and g.challenge_status = 'active'
   and d.participation_count * 100 >= 50 * (
     select count(*) from group_members gm
      where gm.group_id = g.id and gm.joined_at <= d.opened_at)
   and d.participation_count > 0;
