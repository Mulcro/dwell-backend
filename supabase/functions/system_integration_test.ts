/**
 * The system-triggered functions against the real local database.
 *
 * These are never called by a client: pg_cron, a database trigger via pg_net, or another
 * function invokes them with the service role. Only OpenAI is faked.
 */
import { assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleGenerateGroupPulse } from "./generate-group-pulse/handler.ts";
import { handleEndOfChallengeSummary } from "./end-of-challenge-summary/handler.ts";
import { handleDailyCronAutoskip } from "./daily-cron-autoskip/handler.ts";
import { handleDailyCronNudge } from "./daily-cron-nudge/handler.ts";
import { handleDailyCronInactivityCheck } from "./daily-cron-inactivity-check/handler.ts";
import { handleWeeklyCronLeaderboard } from "./weekly-cron-leaderboard/handler.ts";
import { handleGroupChallengeAction } from "./group-challenge-action/handler.ts";
import {
  createTestUser,
  daytimeTimezone,
  deleteTestUsers,
  fakeAi,
  fakeDispatch,
  invoke,
  nighttimeTimezone,
  post,
  SEED_PLAN_ID,
  serviceClient,
  serviceRequest,
  serviceRoleKey,
  type TestUser,
} from "./_shared/test_helpers.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const key = () => serviceRoleKey();

interface Fixture {
  groupId: string;
  dayId: string;
}

/** Builds an isolated group so each step starts from a known state. */
async function makeGroup(
  db: SupabaseClient,
  members: TestUser[],
  options: {
    status?: string;
    thresholdPct?: number;
    autoSkipAfterDays?: number;
    dayIndex?: number;
    openedAgo?: number;
    dayStatus?: string;
    belowCount?: number;
    silentDays?: number;
    frequency?: string;
    timezone?: string;
  } = {},
): Promise<Fixture> {
  const { data: group } = await db
    .from("groups")
    .insert({
      name: "Sys Test",
      plan_challenge_id: SEED_PLAN_ID,
      created_by: members[0].id,
      challenge_status: options.status ?? "active",
      catch_up_threshold_pct: options.thresholdPct ?? 50,
      auto_skip_after_days: options.autoSkipAfterDays ?? 3,
      consecutive_silent_days: options.silentDays ?? 0,
      frequency: options.frequency ?? "daily",
      timezone: options.timezone ?? "UTC",
    })
    .select("id")
    .single();

  await db.from("group_members").insert(
    members.map((m) => ({
      group_id: group!.id,
      user_id: m.id,
      joined_at: ago(30 * DAY),
    })),
  );

  const { data: day } = await db
    .from("day_instances")
    .insert({
      group_id: group!.id,
      day_index: options.dayIndex ?? 1,
      date: new Date().toISOString().slice(0, 10),
      passage_ref: "PSA.34.18",
      opened_at: ago(options.openedAgo ?? HOUR),
      status: options.dayStatus ?? "open",
      consecutive_below_threshold_count: options.belowCount ?? 0,
    })
    .select("id")
    .single();

  return { groupId: group!.id, dayId: day!.id };
}

async function addReflection(
  db: SupabaseClient,
  dayId: string,
  user: TestUser,
  status: string,
  createdAgo = HOUR,
): Promise<void> {
  await db.from("reflections").insert({
    user_id: user.id,
    day_instance_id: dayId,
    media_type: "text",
    content: "a reflection",
    language: "en",
    moderation_status: status,
    created_at: ago(createdAgo),
  });
}

Deno.test("system-triggered functions", async (t) => {
  const db = serviceClient();
  const users: TestUser[] = [];
  const groupIds: string[] = [];

  const alice = await createTestUser(db, "alice");
  const bob = await createTestUser(db, "bob");
  users.push(alice, bob);

  const track = (f: Fixture) => {
    groupIds.push(f.groupId);
    return f;
  };

  try {
    await t.step(
      "every system function refuses a caller without the service role",
      async () => {
        const unauthorized = post({});
        const results = await Promise.all([
          invoke(() => handleGenerateGroupPulse(unauthorized, db, fakeAi(), key())),
          invoke(() => handleEndOfChallengeSummary(unauthorized, db, fakeAi(), key())),
          invoke(() => handleDailyCronAutoskip(unauthorized, db, fakeDispatch(), key())),
          invoke(() => handleDailyCronNudge(unauthorized, db, key())),
          invoke(() =>
            handleDailyCronInactivityCheck(
              unauthorized,
              db,
              fakeDispatch(),
              key(),
            )
          ),
          invoke(() => handleWeeklyCronLeaderboard(unauthorized, db, key())),
        ]);
        assertEquals(results.map((r) => r.status), [
          401,
          401,
          401,
          401,
          401,
          401,
        ]);
      },
    );

    await t.step(
      "a user's own token is not enough for a system function",
      async () => {
        // The anon/authenticated JWT must never be mistaken for the service role.
        const res = await invoke(() =>
          handleDailyCronAutoskip(
            post({}, alice.token),
            db,
            fakeDispatch(),
            key(),
          )
        );
        assertEquals(res.status, 401);
      },
    );

    await t.step(
      "group pulse summarises approved reflections only, once",
      async () => {
        const f = track(await makeGroup(db, [alice, bob]));
        await addReflection(db, f.dayId, alice, "approved");
        await addReflection(db, f.dayId, bob, "flagged");

        const ai = fakeAi();
        const res = await invoke(() =>
          handleGenerateGroupPulse(
            serviceRequest({ day_instance_id: f.dayId }),
            db,
            ai,
            key(),
          )
        );
        assertEquals(res.status, 200);
        assertEquals((await res.json()).status, "generated");

        const { data: insights } = await db
          .from("ai_insights")
          .select("type, content")
          .eq("day_instance_id", f.dayId)
          .eq("type", "group_pulse");
        assertEquals(insights!.length, 1);

        // pg_net retries: a second delivery must not write a second pulse.
        const again = await invoke(() =>
          handleGenerateGroupPulse(
            serviceRequest({ day_instance_id: f.dayId }),
            db,
            ai,
            key(),
          )
        );
        assertEquals((await again.json()).status, "already_generated");
        assertEquals(ai.generateCalls, 1);
      },
    );

    await t.step(
      "group pulse writes nothing when only unmoderated content exists",
      async () => {
        const f = track(await makeGroup(db, [alice, bob]));
        await addReflection(db, f.dayId, alice, "pending");

        const ai = fakeAi();
        const res = await invoke(() =>
          handleGenerateGroupPulse(
            serviceRequest({ day_instance_id: f.dayId }),
            db,
            ai,
            key(),
          )
        );
        assertEquals((await res.json()).status, "nothing_to_summarize");
        assertEquals(ai.generateCalls, 0);
      },
    );

    await t.step(
      "a thin challenge gets the lighter recap, not a growth summary",
      async () => {
        const f = track(await makeGroup(db, [alice, bob]));
        await addReflection(db, f.dayId, alice, "approved");

        const res = await invoke(() =>
          handleEndOfChallengeSummary(
            serviceRequest({ group_id: f.groupId }),
            db,
            fakeAi(),
            key(),
          )
        );
        assertEquals((await res.json()).status, "fallback_recap");
      },
    );

    await t.step(
      "a challenge with enough material gets the full summary, once",
      async () => {
        const f = track(await makeGroup(db, [alice, bob]));
        await addReflection(db, f.dayId, alice, "approved");
        await addReflection(db, f.dayId, bob, "approved");
        const { data: day2 } = await db.from("day_instances").insert({
          group_id: f.groupId,
          day_index: 2,
          date: new Date().toISOString().slice(0, 10),
          passage_ref: "ISA.43.2",
        }).select("id").single();
        await addReflection(db, day2!.id, alice, "approved");

        const res = await invoke(() =>
          handleEndOfChallengeSummary(
            serviceRequest({ group_id: f.groupId }),
            db,
            fakeAi(),
            key(),
          )
        );
        assertEquals((await res.json()).status, "end_summary");

        const again = await invoke(() =>
          handleEndOfChallengeSummary(
            serviceRequest({ group_id: f.groupId }),
            db,
            fakeAi(),
            key(),
          )
        );
        assertEquals((await again.json()).status, "already_generated");
      },
    );

    await t.step(
      "autoskip counts a short day, and re-running the same day does not",
      async () => {
        const f = track(
          await makeGroup(db, [alice, bob], { openedAgo: 2 * DAY }),
        );

        await invoke(() => handleDailyCronAutoskip(serviceRequest(), db, fakeDispatch(), key()));
        const { data: first } = await db
          .from("day_instances")
          .select("consecutive_below_threshold_count, status")
          .eq("id", f.dayId).single();
        assertEquals(first!.consecutive_below_threshold_count, 1);
        assertEquals(first!.status, "open");

        // A retry on the same day must not advance the counter again.
        await invoke(() => handleDailyCronAutoskip(serviceRequest(), db, fakeDispatch(), key()));
        const { data: second } = await db
          .from("day_instances")
          .select("consecutive_below_threshold_count")
          .eq("id", f.dayId).single();
        assertEquals(second!.consecutive_below_threshold_count, 1);
      },
    );

    await t.step(
      "autoskip marks the day missed and opens the next one",
      async () => {
        const f = track(
          await makeGroup(db, [alice, bob], {
            openedAgo: 2 * DAY,
            belowCount: 2,
            autoSkipAfterDays: 3,
          }),
        );

        await invoke(() => handleDailyCronAutoskip(serviceRequest(), db, fakeDispatch(), key()));

        const { data: day } = await db
          .from("day_instances")
          .select("status, consecutive_below_threshold_count")
          .eq("id", f.dayId).single();
        assertEquals(day!.status, "missed");
        assertEquals(day!.consecutive_below_threshold_count, 0);

        const { data: next } = await db
          .from("day_instances")
          .select("day_index, passage_ref, status")
          .eq("group_id", f.groupId).eq("day_index", 2).single();
        assertEquals(next!.passage_ref, "ISA.43.2");
        assertEquals(next!.status, "open");
      },
    );

    await t.step(
      "skipping the final day still closes the challenge with a summary",
      async () => {
        // This group never clears a day, so it never passes through open_ready_next_days --
        // the only other place a completion dispatches the summary. Reaching the end by
        // auto-skip must not finish in silence.
        const f = track(
          await makeGroup(db, [alice, bob], {
            openedAgo: 2 * DAY,
            belowCount: 2,
            autoSkipAfterDays: 3,
            dayIndex: 7, // the seeded plan's last day
          }),
        );
        const dispatch = fakeDispatch();

        await invoke(() => handleDailyCronAutoskip(serviceRequest(), db, dispatch, key()));

        const { data: day } = await db
          .from("day_instances").select("status").eq("id", f.dayId).single();
        assertEquals(day!.status, "missed");

        const { data: group } = await db
          .from("groups").select("challenge_status").eq("id", f.groupId)
          .single();
        assertEquals(group!.challenge_status, "completed");

        assertEquals(dispatch.calls.length, 1);
        assertEquals(dispatch.calls[0].name, "end-of-challenge-summary");

        // No day 8 invented past the end of the plan.
        const { count } = await db
          .from("day_instances")
          .select("id", { count: "exact", head: true })
          .eq("group_id", f.groupId);
        assertEquals(count, 1);
      },
    );

    await t.step("a weekday group is left alone at the weekend", async () => {
      // A rest day is not a missed day: the counter must not move and nothing may be
      // skipped, or a group would be punished for a day they never had to post on.
      const f = track(
        await makeGroup(db, [alice, bob], {
          openedAgo: 2 * DAY,
          belowCount: 2,
          autoSkipAfterDays: 3,
          frequency: "weekdays",
        }),
      );

      const saturday = new Date("2026-09-26T10:00:00Z");
      // Anchor the day to the injected clock, not to real now: otherwise the fixture
      // drifts past the handler's 24h cutoff and the group is skipped over entirely --
      // which looks like a pass, because nothing happening is what this test asserts.
      await db.from("day_instances")
        .update({ opened_at: "2026-09-24T10:00:00Z" }).eq("id", f.dayId);

      await invoke(() =>
        handleDailyCronAutoskip(
          serviceRequest(),
          db,
          fakeDispatch(),
          key(),
          saturday,
        )
      );

      const { data: day } = await db
        .from("day_instances")
        .select("status, consecutive_below_threshold_count")
        .eq("id", f.dayId).single();
      assertEquals(day!.status, "open");
      assertEquals(day!.consecutive_below_threshold_count, 2);
      // Untouched because it was a rest day -- confirmed by the Monday test below, where
      // the identical fixture IS skipped.
    });

    await t.step("the same group is skipped on a Monday", async () => {
      const f = track(
        await makeGroup(db, [alice, bob], {
          openedAgo: 2 * DAY,
          belowCount: 2,
          autoSkipAfterDays: 3,
          frequency: "weekdays",
        }),
      );

      const monday = new Date("2026-09-28T10:00:00Z");
      await db.from("day_instances")
        .update({ opened_at: "2026-09-26T10:00:00Z" }).eq("id", f.dayId);

      await invoke(() =>
        handleDailyCronAutoskip(
          serviceRequest(),
          db,
          fakeDispatch(),
          key(),
          monday,
        )
      );

      const { data: day } = await db
        .from("day_instances").select("status").eq("id", f.dayId).single();
      assertEquals(day!.status, "missed");
    });

    await t.step(
      "nudges reach someone whose window is closing, during their day",
      async () => {
        await db.from("users").update({ timezone: daytimeTimezone() }).eq(
          "id",
          alice.id,
        );
        const f = track(await makeGroup(db, [alice], { openedAgo: 23 * HOUR }));

        await invoke(() => handleDailyCronNudge(serviceRequest(), db, key()));

        const { data: nudges } = await db
          .from("ai_insights")
          .select("id").eq("day_instance_id", f.dayId).eq("type", "nudge");
        assertEquals(nudges!.length, 1);

        // Runs every 15 minutes: it must not nudge the same person again.
        await invoke(() => handleDailyCronNudge(serviceRequest(), db, key()));
        const { count } = await db
          .from("ai_insights")
          .select("id", { count: "exact", head: true })
          .eq("day_instance_id", f.dayId).eq("type", "nudge");
        assertEquals(count, 1);
      },
    );

    await t.step("nobody is woken in the middle of their night", async () => {
      await db.from("users").update({ timezone: nighttimeTimezone() }).eq(
        "id",
        bob.id,
      );
      const f = track(await makeGroup(db, [bob], { openedAgo: 23 * HOUR }));

      await invoke(() => handleDailyCronNudge(serviceRequest(), db, key()));

      const { count } = await db
        .from("ai_insights")
        .select("id", { count: "exact", head: true })
        .eq("day_instance_id", f.dayId).eq("type", "nudge");
      assertEquals(count, 0);
    });

    await t.step("someone who already posted is not nudged", async () => {
      await db.from("users").update({ timezone: daytimeTimezone() }).eq(
        "id",
        alice.id,
      );
      const f = track(await makeGroup(db, [alice], { openedAgo: 23 * HOUR }));
      await addReflection(db, f.dayId, alice, "approved");

      await invoke(() => handleDailyCronNudge(serviceRequest(), db, key()));

      const { count } = await db
        .from("ai_insights")
        .select("id", { count: "exact", head: true })
        .eq("day_instance_id", f.dayId).eq("type", "nudge");
      assertEquals(count, 0);
    });

    await t.step(
      "the leaderboard counts approved reflections from the past week",
      async () => {
        const f = track(await makeGroup(db, [alice, bob]));
        await addReflection(db, f.dayId, alice, "approved", HOUR);
        await addReflection(db, f.dayId, bob, "pending", HOUR);

        await invoke(() => handleWeeklyCronLeaderboard(serviceRequest(), db, key()));

        const { data: entries } = await db
          .from("leaderboard_entries")
          .select("user_id, participation_score")
          .eq("group_id", f.groupId);

        const score = (id: string) =>
          entries!.find((e: { user_id: string }) => e.user_id === id)
            ?.participation_score;
        assertEquals(score(alice.id), 1);
        // Pending content earns nothing.
        assertEquals(score(bob.id), 0);

        // Re-running recomputes in place rather than duplicating.
        await invoke(() => handleWeeklyCronLeaderboard(serviceRequest(), db, key()));
        const { count } = await db
          .from("leaderboard_entries")
          .select("id", { count: "exact", head: true })
          .eq("group_id", f.groupId);
        assertEquals(count, 2);
      },
    );

    await t.step(
      "three silent days raise the prompt, exactly once",
      async () => {
        const f = track(await makeGroup(db, [alice, bob], { silentDays: 2 }));
        const dispatch = fakeDispatch();

        await invoke(() => handleDailyCronInactivityCheck(serviceRequest(), db, dispatch, key()));

        const { data: group } = await db
          .from("groups")
          .select("consecutive_silent_days, prompt_pending")
          .eq("id", f.groupId).single();
        assertEquals(group!.consecutive_silent_days, 3);
        assertEquals(group!.prompt_pending, true);

        // One prompt per member.
        const { count } = await db
          .from("ai_insights")
          .select("id", { count: "exact", head: true })
          .eq("group_id", f.groupId).eq("type", "inactivity_prompt");
        assertEquals(count, 2);

        // Same-day retry: no second measurement, no second prompt.
        await invoke(() => handleDailyCronInactivityCheck(serviceRequest(), db, dispatch, key()));
        const { data: after } = await db
          .from("groups").select("consecutive_silent_days").eq("id", f.groupId)
          .single();
        assertEquals(after!.consecutive_silent_days, 3);
      },
    );

    await t.step("recent activity resets the silence counter", async () => {
      const f = track(await makeGroup(db, [alice], { silentDays: 2 }));
      await addReflection(db, f.dayId, alice, "approved", HOUR);

      await invoke(() =>
        handleDailyCronInactivityCheck(
          serviceRequest(),
          db,
          fakeDispatch(),
          key(),
        )
      );

      const { data: group } = await db
        .from("groups").select("consecutive_silent_days, prompt_pending")
        .eq("id", f.groupId).single();
      assertEquals(group!.consecutive_silent_days, 0);
      assertEquals(group!.prompt_pending, false);
    });

    await t.step("a fortnight of silence expires the challenge", async () => {
      const f = track(await makeGroup(db, [alice], { silentDays: 13 }));
      const dispatch = fakeDispatch();

      await invoke(() => handleDailyCronInactivityCheck(serviceRequest(), db, dispatch, key()));

      const { data: group } = await db
        .from("groups").select("challenge_status").eq("id", f.groupId).single();
      assertEquals(group!.challenge_status, "expired_incomplete");
      assertEquals(dispatch.calls.length, 1);
      assertEquals(dispatch.calls[0].name, "end-of-challenge-summary");
    });

    await t.step("only a member may answer the inactivity prompt", async () => {
      const f = track(await makeGroup(db, [alice]));
      const res = await invoke(() =>
        handleGroupChallengeAction(
          post({ group_id: f.groupId, action: "pause" }, bob.token),
          db,
          fakeDispatch(),
        )
      );
      assertEquals(res.status, 403);
    });

    await t.step(
      "pause freezes the challenge and continue revives it",
      async () => {
        const f = track(await makeGroup(db, [alice], { silentDays: 3 }));
        await db.from("groups").update({ prompt_pending: true }).eq(
          "id",
          f.groupId,
        );

        const paused = await invoke(() =>
          handleGroupChallengeAction(
            post({ group_id: f.groupId, action: "pause" }, alice.token),
            db,
            fakeDispatch(),
          )
        );
        assertEquals((await paused.json()).challenge_status, "paused");

        const resumed = await invoke(() =>
          handleGroupChallengeAction(
            post({ group_id: f.groupId, action: "continue" }, alice.token),
            db,
            fakeDispatch(),
          )
        );
        assertEquals((await resumed.json()).challenge_status, "active");

        const { data: group } = await db
          .from("groups").select("consecutive_silent_days, prompt_pending")
          .eq("id", f.groupId).single();
        // Continuing forgives the silence, so the prompt does not immediately re-fire.
        assertEquals(group!.consecutive_silent_days, 0);
        assertEquals(group!.prompt_pending, false);
      },
    );

    await t.step(
      "ending the challenge closes it out with a summary",
      async () => {
        const f = track(await makeGroup(db, [alice]));
        const dispatch = fakeDispatch();

        const res = await invoke(() =>
          handleGroupChallengeAction(
            post({ group_id: f.groupId, action: "end" }, alice.token),
            db,
            dispatch,
          )
        );
        assertEquals((await res.json()).challenge_status, "abandoned");
        assertEquals(dispatch.calls[0].name, "end-of-challenge-summary");

        // A finished challenge cannot be restarted from the prompt.
        const again = await invoke(() =>
          handleGroupChallengeAction(
            post({ group_id: f.groupId, action: "continue" }, alice.token),
            db,
            dispatch,
          )
        );
        assertEquals(again.status, 409);
      },
    );
  } finally {
    for (const id of groupIds) await db.from("groups").delete().eq("id", id);
    await deleteTestUsers(db, users);
  }
});
