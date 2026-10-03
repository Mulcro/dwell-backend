import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import type { Dispatch } from "../_shared/dispatch.ts";
import { json } from "../_shared/http.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WAKING_START = 8;
const WAKING_END = 21;
/** How close to the end of someone's 24h window counts as "approaching". */
const APPROACHING_MS = 6 * 60 * 60 * 1000;

/**
 * pg_cron, every 15 minutes. Service role only.
 *
 * Decides who to nudge: members approaching or past their local day-window without an
 * approved reflection. Runs often so each person is reached during their own waking
 * hours; timezone is used for nothing else.
 *
 * A nudge is written as an ai_insights row, which is what the app shows, and the same
 * words are then handed to send-push for the member's phone (design doc 5.3). The row
 * is the record; the push is a courtesy that may or may not land.
 */
export async function handleDailyCronNudge(
  req: Request,
  db: SupabaseClient,
  dispatch: Dispatch,
  serviceRoleKey: string | string[],
): Promise<Response> {
  requireServiceRole(req, serviceRoleKey);

  const { data: days, error } = await db
    .from("day_instances")
    .select("id, group_id, opened_at, groups!inner(challenge_status, name)")
    .eq("status", "open")
    .eq("groups.challenge_status", "active");

  if (error) {
    console.error("daily-cron-nudge query failed", error);
    return json({ error: "Could not load days" }, 500);
  }

  let written = 0;
  const pushes: Array<{ user_id: string; title: string; body: string }> = [];

  for (const day of days ?? []) {
    const dayOpenedAt = new Date(day.opened_at).getTime();
    const windowEnds = dayOpenedAt + DAY_MS;

    const { data: members } = await db
      .from("group_members")
      .select("user_id, joined_at, users!inner(timezone)")
      .eq("group_id", day.group_id)
      .lte("joined_at", day.opened_at);

    const { data: posted } = await db
      .from("reflections")
      .select("user_id")
      .eq("day_instance_id", day.id)
      .eq("moderation_status", "approved");

    const postedIds = new Set(
      (posted ?? []).map((r: { user_id: string }) => r.user_id),
    );
    // Nobody at all has posted and the window has closed: this is the escalated case.
    const groupIsSilent = postedIds.size === 0 && Date.now() > windowEnds;

    for (const member of members ?? []) {
      if (postedIds.has(member.user_id)) continue;

      // A late joiner's own window starts when they joined, not when the day opened.
      const memberWindowEnds = Math.max(dayOpenedAt, new Date(member.joined_at).getTime()) + DAY_MS;
      // Nobody is nudged the moment a day opens; only as their own window closes in.
      if (Date.now() < memberWindowEnds - APPROACHING_MS) continue;

      const tz = (member.users as unknown as { timezone: string }).timezone;
      const hour = localHour(tz);
      if (hour === null || hour < WAKING_START || hour >= WAKING_END) continue;

      // One ordinary nudge per person per day, plus at most one escalated follow-up.
      const { count } = await db
        .from("ai_insights")
        .select("id", { count: "exact", head: true })
        .eq("day_instance_id", day.id)
        .eq("target_user_id", member.user_id)
        .eq("type", "nudge");

      const sent = count ?? 0;
      if (sent >= 2) continue;
      if (sent >= 1 && !groupIsSilent) continue;

      const content = groupIsSilent
        ? "Your group has gone quiet on this one. A few words from you would restart it."
        : "Today's passage is still waiting for you. Even one sentence counts.";

      const { error: insertError } = await db.from("ai_insights").insert({
        group_id: day.group_id,
        day_instance_id: day.id,
        target_user_id: member.user_id,
        scope: "day_instance",
        type: "nudge",
        content,
      });
      if (insertError) continue;
      written++;

      // The same words, on the phone. Titled with the group so a member of two groups
      // knows which one is waiting.
      pushes.push({
        user_id: member.user_id,
        title: (day.groups as unknown as { name: string }).name,
        body: content,
      });
    }
  }

  // Every row is written before any push goes out, and the pushes run together through
  // a bounded dispatch, so a slow round-trip to Apple can delay a notification but never
  // another member's in-app nudge.
  await Promise.allSettled(pushes.map((push) => dispatch("send-push", push)));

  return json({ nudges_written: written });
}

/** The member's current local hour, or null if their stored timezone is unusable. */
function localHour(timezone: string): number | null {
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(new Date());
    const hour = Number.parseInt(formatted, 10);
    return Number.isNaN(hour) ? null : hour % 24;
  } catch {
    // An invalid timezone must not stop the whole run; skip that person this tick.
    return null;
  }
}
