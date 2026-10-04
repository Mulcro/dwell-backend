import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { json } from "../_shared/http.ts";
import { otherLanguages, translateCard } from "../_shared/insight_card.ts";
import type { Ai } from "../_shared/openai.ts";
import { writeRecap } from "../_shared/recap.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Fewer approved reflections than this and the recap closes the week gently. */
const THIN_WEEK = 3;
/** Recaps are AI round-trips; a few at a time keeps a long group list inside the clock. */
const RECAPS_AT_ONCE = 3;

interface Day {
  id: string;
  day_index: number;
  status: string;
  opened_at: string;
}

/**
 * pg_cron, Monday 00:00 UTC. Service role only.
 *
 * participation_score is the count of the member's own APPROVED reflections in the week
 * that just ended. It reads only that member's rows and never day_instances.status, so a
 * group-level skip, pause or expiry can never reduce an individual's score.
 *
 * The leaderboard is written first and on its own. Only then does the same pass write
 * each group's weekly recap -- the card the design shows under "Sunday Crew showed up 6
 * of the 7 days" -- which is optional: no AI configured means no recaps and a normal
 * leaderboard, and a recap failing or timing out costs nothing but that recap.
 */
export async function handleWeeklyCronLeaderboard(
  req: Request,
  db: SupabaseClient,
  ai: Ai | null,
  serviceRoleKey: string | string[],
): Promise<Response> {
  requireServiceRole(req, serviceRoleKey);

  const now = Date.now();
  const weekStartDate = new Date(now - WEEK_MS);
  const weekStart = weekStartDate.toISOString().slice(0, 10);

  const { data: groups, error } = await db
    .from("groups")
    .select("id")
    .in("challenge_status", ["active", "paused"]);

  if (error) {
    console.error("weekly-cron-leaderboard query failed", error);
    return json({ error: "Could not load groups" }, 500);
  }

  const rows: Array<Record<string, unknown>> = [];
  const groupDays = new Map<string, Day[]>();

  for (const group of groups ?? []) {
    const { data: days } = await db
      .from("day_instances")
      .select("id, day_index, status, opened_at")
      .eq("group_id", group.id);
    const dayList = (days ?? []) as Day[];
    groupDays.set(group.id, dayList);
    const dayIds = dayList.map((d) => d.id);

    const { data: members } = await db
      .from("group_members")
      .select("user_id")
      .eq("group_id", group.id);

    for (const member of members ?? []) {
      let score = 0;

      if (dayIds.length > 0) {
        const { count } = await db
          .from("reflections")
          .select("id", { count: "exact", head: true })
          .eq("user_id", member.user_id)
          .eq("moderation_status", "approved")
          .in("day_instance_id", dayIds)
          .gte("created_at", weekStartDate.toISOString());
        score = count ?? 0;
      }

      rows.push({
        group_id: group.id,
        week_start: weekStart,
        user_id: member.user_id,
        participation_score: score,
      });
    }
  }

  if (rows.length > 0) {
    // Upsert on the natural key, so a re-run recomputes rather than duplicating.
    const { error: upsertError } = await db
      .from("leaderboard_entries")
      .upsert(rows, { onConflict: "group_id,week_start,user_id" });

    if (upsertError) {
      console.error("weekly-cron-leaderboard upsert failed", upsertError);
      return json({ error: "Could not write leaderboard" }, 500);
    }
  }

  // The scores are safe. Everything from here is the optional part.
  let recaps = 0;
  if (!ai) {
    console.warn("weekly recaps skipped: OPENAI_API_KEY is not set");
  } else {
    const ids = [...groupDays.keys()];
    for (let i = 0; i < ids.length; i += RECAPS_AT_ONCE) {
      const batch = ids.slice(i, i + RECAPS_AT_ONCE).map((id) =>
        writeWeeklyRecap(db, ai, id, groupDays.get(id) ?? [], weekStart, weekStartDate)
      );
      for (const outcome of await Promise.allSettled(batch)) {
        if (outcome.status === "fulfilled" && outcome.value) recaps++;
        // The recap is a courtesy; a failure is logged and the next group still runs.
        if (outcome.status === "rejected") console.error("weekly recap failed", outcome.reason);
      }
    }
  }

  return json({ week_start: weekStart, entries: rows.length, recaps });
}

/**
 * One recap for the week just ended. Returns whether a row was written.
 *
 * "This week" means the same thing the leaderboard means: reflections POSTED in the
 * window, whichever day they were for -- so a late post on last week's day counts in
 * both places or neither. The days counts are the days that OPENED in the window.
 */
async function writeWeeklyRecap(
  db: SupabaseClient,
  ai: Ai,
  groupId: string,
  dayList: Day[],
  weekStart: string,
  weekStartDate: Date,
): Promise<boolean> {
  if (dayList.length === 0) return false;

  // Cheap pre-check so a re-run does not pay for AI it will throw away. The unique index
  // behind the insert is what actually enforces one card per week.
  const { count: already } = await db
    .from("ai_insights")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .eq("type", "weekly_recap")
    .eq("payload->>week_start", weekStart);
  if ((already ?? 0) > 0) return false;

  const dayIndex = new Map(dayList.map((d) => [d.id, d.day_index]));
  const { data: reflections } = await db
    .from("reflections")
    .select("user_id, day_instance_id, content, transcript")
    .in("day_instance_id", dayList.map((d) => d.id))
    .eq("moderation_status", "approved")
    .gte("created_at", weekStartDate.toISOString());

  const authored = (reflections ?? [])
    .map((
      r: {
        user_id: string;
        day_instance_id: string;
        content: string | null;
        transcript: string | null;
      },
    ) => ({
      user_id: r.user_id,
      day_index: dayIndex.get(r.day_instance_id) ?? 0,
      text: (r.content ?? r.transcript ?? "").trim(),
    }))
    .filter((r: { text: string }) => r.text !== "")
    .sort((a: { day_index: number }, b: { day_index: number }) => a.day_index - b.day_index);
  if (authored.length === 0) return false;

  const { data: group } = await db
    .from("groups")
    .select("plan_challenges(title)")
    .eq("id", groupId)
    .maybeSingle();
  const title = (group?.plan_challenges as { title?: string } | null)?.title ?? "the plan";

  const { count: memberCount } = await db
    .from("group_members")
    .select("user_id", { count: "exact", head: true })
    .eq("group_id", groupId);

  const week = dayList.filter((d) => new Date(d.opened_at).getTime() >= weekStartDate.getTime());
  const daysTotal = week.length > 0 ? week.length : null;
  const daysShowedUp = week.length > 0
    ? week.filter((d) => d.status === "complete" || d.status === "threshold_met").length
    : null;

  const recap = await writeRecap(ai, {
    title,
    span: "this week",
    reflections: authored,
    memberCount: memberCount ?? null,
    daysShowedUp,
    daysTotal,
    thin: authored.length < THIN_WEEK,
  });

  const card = { headline: recap.headline, summary: recap.summary, members: recap.members };
  const targets = await otherLanguages(db, groupId);
  const translated = targets.length > 0 ? await translateCard(ai, card, targets) : null;

  const { error } = await db.from("ai_insights").insert({
    group_id: groupId,
    scope: "group_challenge",
    type: "weekly_recap",
    content: recap.summary,
    payload: {
      headline: recap.headline,
      members: recap.members,
      days_showed_up: daysShowedUp,
      days_total: daysTotal,
      reflection_count: authored.length,
      week_start: weekStart,
    },
    language: "en",
    translated_text: translated,
  });
  if (error) {
    // Another run got there first; the unique index makes that a non-event.
    if (error.code === "23505") return false;
    console.error("weekly recap insert failed", error);
    return false;
  }
  return true;
}
