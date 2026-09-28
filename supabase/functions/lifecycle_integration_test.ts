/**
 * Phase 7: whole-challenge verification against the real local stack.
 *
 * The earlier integration tests each prove one function. These drive a challenge from
 * creation to its end through the real functions, triggers and advancement SQL, and
 * check the privacy property the Realtime design rests on.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { handleCreateGroup } from "./create-group/handler.ts";
import { handleJoinGroup } from "./join-group/handler.ts";
import { handleSubmitReflection } from "./submit-reflection/handler.ts";
import { handleGroupChallengeAction } from "./group-challenge-action/handler.ts";
import { handleDailyCronInactivityCheck } from "./daily-cron-inactivity-check/handler.ts";
import { handleEndOfChallengeSummary } from "./end-of-challenge-summary/handler.ts";
import {
  createTestUser,
  deleteTestUsers,
  fakeAi,
  fakeDispatch,
  invoke,
  post,
  SEED_PLAN_ID,
  serviceClient,
  serviceRequest,
  serviceRoleKey,
  waitForRealtime,
} from "./_shared/test_helpers.ts";

/** The seeded 7-day plan, in order. Advancement must follow exactly this. */
const PLAN_PASSAGES = [
  "PSA.34.18",
  "ISA.43.2",
  "ROM.8.28",
  "2CO.4.16-18",
  "PSA.23.4",
  "JAS.1.2-4",
  "REV.21.4",
];

const LOCAL_URL = "http://127.0.0.1:54321";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

Deno.test("a challenge runs from creation to completion", async () => {
  const db = serviceClient();
  const alice = await createTestUser(db, "alice");
  const bob = await createTestUser(db, "bob");
  let groupId = "";

  try {
    const created = await invoke(() =>
      handleCreateGroup(
        post({ name: "Lifecycle Crew", plan_challenge_id: SEED_PLAN_ID }, alice.token),
        db,
      )
    );
    const { group_id, invite_token } = await created.json();
    groupId = group_id;

    const joined = await invoke(() => handleJoinGroup(post({ invite_token }, bob.token), db));
    assertEquals((await joined.json()).challenge_status, "active");

    // Walk all seven days. One of two members is 50%, which meets the default threshold.
    for (let dayIndex = 1; dayIndex <= PLAN_PASSAGES.length; dayIndex++) {
      const { data: day } = await db
        .from("day_instances")
        .select("id, passage_ref, status")
        .eq("group_id", groupId)
        .eq("day_index", dayIndex)
        .single();

      assertEquals(day!.passage_ref, PLAN_PASSAGES[dayIndex - 1]);
      assertEquals(day!.status, "open");

      const submitted = await invoke(() =>
        handleSubmitReflection(
          post({
            day_instance_id: day!.id,
            media_type: "text",
            content: `Day ${dayIndex} reflection`,
            language: "en",
          }, alice.token),
          db,
          fakeAi(),
        )
      );
      assertEquals((await submitted.json()).moderation_status, "approved");

      const { data: met } = await db
        .from("day_instances").select("status").eq("id", day!.id).single();
      assertEquals(met!.status, "threshold_met");

      // Pacing is the only thing left holding the day: pretend its 24 hours elapsed.
      await db
        .from("day_instances")
        .update({ opened_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
        .eq("id", day!.id);

      await db.rpc("open_ready_next_days");

      const { data: after } = await db
        .from("day_instances").select("status").eq("id", day!.id).single();
      assertEquals(after!.status, "complete");
    }

    // The plan is exhausted, so no day 8 is invented and the challenge closes itself.
    const { count: dayCount } = await db
      .from("day_instances")
      .select("id", { count: "exact", head: true })
      .eq("group_id", groupId);
    assertEquals(dayCount, PLAN_PASSAGES.length);

    const { data: group } = await db
      .from("groups").select("challenge_status").eq("id", groupId).single();
    assertEquals(group!.challenge_status, "completed");

    // Completion dispatches the summary; run what that dispatch would have invoked.
    const summary = await invoke(() =>
      handleEndOfChallengeSummary(
        serviceRequest({ group_id: groupId }),
        db,
        fakeAi(),
        serviceRoleKey(),
      )
    );
    assertEquals((await summary.json()).status, "end_summary");
  } finally {
    if (groupId) await db.from("groups").delete().eq("id", groupId);
    await deleteTestUsers(db, [alice, bob]);
  }
});

Deno.test("a challenge that goes quiet is prompted, then ended", async () => {
  const db = serviceClient();
  const alice = await createTestUser(db, "alice");
  const bob = await createTestUser(db, "bob");
  let groupId = "";

  try {
    const created = await invoke(() =>
      handleCreateGroup(
        post({ name: "Quiet Crew", plan_challenge_id: SEED_PLAN_ID }, alice.token),
        db,
      )
    );
    const body = await created.json();
    groupId = body.group_id;
    await invoke(() => handleJoinGroup(post({ invite_token: body.invite_token }, bob.token), db));

    // Two days of silence already behind them; today's sweep is the third.
    await db.from("groups").update({ consecutive_silent_days: 2 }).eq("id", groupId);

    const dispatch = fakeDispatch();
    await invoke(() =>
      handleDailyCronInactivityCheck(serviceRequest(), db, dispatch, serviceRoleKey())
    );

    const { data: prompted } = await db
      .from("groups").select("consecutive_silent_days, prompt_pending")
      .eq("id", groupId).single();
    assertEquals(prompted!.consecutive_silent_days, 3);
    assertEquals(prompted!.prompt_pending, true);

    // Both members see the prompt, and either may answer it.
    const { count: prompts } = await db
      .from("ai_insights")
      .select("id", { count: "exact", head: true })
      .eq("group_id", groupId).eq("type", "inactivity_prompt");
    assertEquals(prompts, 2);

    const endDispatch = fakeDispatch();
    const ended = await invoke(() =>
      handleGroupChallengeAction(
        post({ group_id: groupId, action: "end" }, bob.token),
        db,
        endDispatch,
      )
    );
    assertEquals((await ended.json()).challenge_status, "abandoned");
    assertEquals(endDispatch.calls[0].name, "end-of-challenge-summary");

    // Barely any content, so they get the gentler recap rather than a growth summary.
    const summary = await invoke(() =>
      handleEndOfChallengeSummary(
        serviceRequest({ group_id: groupId }),
        db,
        fakeAi(),
        serviceRoleKey(),
      )
    );
    assertEquals((await summary.json()).status, "fallback_recap");
  } finally {
    if (groupId) await db.from("groups").delete().eq("id", groupId);
    await deleteTestUsers(db, [alice, bob]);
  }
});

Deno.test({
  name: "Realtime reveals that someone posted without revealing what",
  // A live websocket plus its timers outlive the assertions; cleanup is explicit below.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = serviceClient();
    const alice = await createTestUser(db, "alice");
    const bob = await createTestUser(db, "bob");
    let groupId = "";
    const watcher = createClient(LOCAL_URL, LOCAL_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    try {
      // Prove the pipeline is live before relying on it for an assertion.
      await waitForRealtime();

      const created = await invoke(() =>
        handleCreateGroup(
          post({ name: "Realtime Crew", plan_challenge_id: SEED_PLAN_ID }, alice.token),
          db,
        )
      );
      const body = await created.json();
      groupId = body.group_id;
      await invoke(() => handleJoinGroup(post({ invite_token: body.invite_token }, bob.token), db));

      const { data: day } = await db
        .from("day_instances").select("id").eq("group_id", groupId).single();

      // Alice watches the day. She has posted nothing, so she has unlocked nothing.
      await watcher.realtime.setAuth(alice.token);

      let onUpdate: (row: Record<string, unknown>) => void = () => {};
      let onFailure: (err: Error) => void = () => {};
      const update = new Promise<Record<string, unknown>>((resolve, reject) => {
        onUpdate = resolve;
        onFailure = reject;
      });

      // Wait for the subscription to actually be live rather than sleeping and hoping:
      // the first websocket connect can be slow, and a fixed delay makes this flaky.
      const subscribed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("subscribe timed out")), 20_000);
        watcher
          .channel(`day-${groupId}`)
          .on("postgres_changes", {
            event: "UPDATE",
            schema: "public",
            table: "day_instances",
            filter: `group_id=eq.${groupId}`,
          }, (payload) => onUpdate(payload.new as Record<string, unknown>))
          .subscribe((status, err) => {
            if (status === "SUBSCRIBED") {
              clearTimeout(timer);
              resolve();
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              clearTimeout(timer);
              const failure = new Error(`subscribe failed: ${status} ${err?.message ?? ""}`);
              reject(failure);
              onFailure(failure);
            }
          });
      });
      await subscribed;

      const updateTimer = setTimeout(
        () => onFailure(new Error("no realtime update within 20s of the reflection")),
        20_000,
      );

      await invoke(() =>
        handleSubmitReflection(
          post({
            day_instance_id: day!.id,
            media_type: "text",
            content: "something private",
            language: "en",
          }, bob.token),
          db,
          fakeAi(),
        )
      );

      const row = await update;
      clearTimeout(updateTimer);
      // The count moves, which is what drives the "X of Y posted" indicator...
      assertEquals(row.participation_count, 1);
      assertNotEquals(row.id, undefined);
      // ...and no reflection content rides along on this channel.
      assertEquals("content" in row, false);

      // Meanwhile Alice still cannot read the reflection itself: she has not posted.
      const asAlice = createClient(LOCAL_URL, LOCAL_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${alice.token}` } },
      });
      const { data: visible } = await asAlice.from("reflections").select("id, content");
      assertEquals(visible!.length, 0);
    } finally {
      await watcher.removeAllChannels();
      watcher.realtime.disconnect();
      if (groupId) await db.from("groups").delete().eq("id", groupId);
      await deleteTestUsers(db, [alice, bob]);
    }
  },
});
