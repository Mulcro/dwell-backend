/**
 * The client-facing functions against the real local database.
 *
 * Only OpenAI is faked; every query, constraint, policy and trigger here is the real one.
 * Run with `supabase start` up: `deno task test:integration`.
 */
import { assertEquals } from "@std/assert";
import { handleCreateGroup } from "./create-group/handler.ts";
import { handleJoinGroup } from "./join-group/handler.ts";
import { handleSubmitReflection } from "./submit-reflection/handler.ts";
import {
  createTestUser,
  deleteTestUsers,
  fakeAi,
  invoke,
  post,
  SEED_PLAN_ID,
  serviceClient,
  type TestUser,
} from "./_shared/test_helpers.ts";

Deno.test("client-facing functions", async (t) => {
  const db = serviceClient();
  const users: TestUser[] = [];
  const groupIds: string[] = [];

  const alice = await createTestUser(db, "alice");
  const bob = await createTestUser(db, "bob");
  const carol = await createTestUser(db, "carol");
  users.push(alice, bob, carol);

  let groupId = "";
  let inviteToken = "";
  let dayInstanceId = "";

  const createGroup = (body: unknown, token?: string) =>
    invoke(() => handleCreateGroup(post(body, token), db));
  const joinGroup = (body: unknown, token?: string) =>
    invoke(() => handleJoinGroup(post(body, token), db));
  const submit = (body: unknown, token: string, ai = fakeAi()) =>
    invoke(() => handleSubmitReflection(post(body, token), db, ai));

  try {
    await t.step("create-group rejects an unauthenticated caller", async () => {
      const res = await createGroup({
        name: "Crew",
        plan_challenge_id: SEED_PLAN_ID,
      });
      assertEquals(res.status, 401);
    });

    await t.step("create-group validates its input", async () => {
      const missingName = await createGroup(
        { plan_challenge_id: SEED_PLAN_ID },
        alice.token,
      );
      assertEquals(missingName.status, 400);

      const unknownPlan = await createGroup(
        { name: "Crew", plan_challenge_id: crypto.randomUUID() },
        alice.token,
      );
      assertEquals(unknownPlan.status, 404);
    });

    await t.step("create-group refuses a plan with no day list", async () => {
      // A plan row without its days would produce an active group that can never open
      // Day 1, so it has to be caught before the group exists.
      const { data: brokenPlan } = await db
        .from("plan_challenges")
        .insert({ title: "Broken Plan", day_count: 3 })
        .select("id")
        .single();

      try {
        const res = await createGroup(
          { name: "Doomed Crew", plan_challenge_id: brokenPlan!.id },
          alice.token,
        );
        assertEquals(res.status, 422);

        const { count } = await db
          .from("groups")
          .select("id", { count: "exact", head: true })
          .eq("plan_challenge_id", brokenPlan!.id);
        assertEquals(count, 0);
      } finally {
        await db.from("plan_challenges").delete().eq("id", brokenPlan!.id);
      }
    });

    await t.step("create-group refuses a client-supplied threshold", async () => {
      const res = await createGroup(
        { name: "Strict Crew", plan_challenge_id: SEED_PLAN_ID, catch_up_threshold_pct: 100 },
        alice.token,
      );
      assertEquals(res.status, 400);
      assertEquals(
        (await res.json()).error,
        "catch_up_threshold_pct is no longer supported; the threshold is 50% for every group",
      );
    });

    await t.step(
      "create-group creates a forming group with its creator inside",
      async () => {
        const res = await createGroup(
          { name: "Morning Crew", plan_challenge_id: SEED_PLAN_ID },
          alice.token,
        );
        assertEquals(res.status, 201);

        const body = await res.json();
        groupId = body.group_id;
        inviteToken = body.invite_token;
        groupIds.push(groupId);

        const { data: group } = await db
          .from("groups")
          .select("challenge_status, created_by, catch_up_threshold_pct")
          .eq("id", groupId)
          .single();
        assertEquals(group!.challenge_status, "forming");
        assertEquals(group!.created_by, alice.id);
        // The only threshold there is.
        assertEquals(group!.catch_up_threshold_pct, 50);

        // A group whose creator is not a member would be invisible to everyone.
        const { count } = await db
          .from("group_members")
          .select("user_id", { count: "exact", head: true })
          .eq("group_id", groupId);
        assertEquals(count, 1);

        assertEquals(typeof inviteToken, "string");
        assertEquals(inviteToken.length > 0, true);
      },
    );

    await t.step("create-group records the reading rhythm", async () => {
      const bad = await createGroup(
        {
          name: "Bad Rhythm",
          plan_challenge_id: SEED_PLAN_ID,
          frequency: "hourly",
        },
        alice.token,
      );
      assertEquals(bad.status, 400);

      const badZone = await createGroup(
        {
          name: "Bad Zone",
          plan_challenge_id: SEED_PLAN_ID,
          timezone: "Mars/Olympus",
        },
        alice.token,
      );
      assertEquals(badZone.status, 400);

      const ok = await createGroup({
        name: "Weekday Crew",
        plan_challenge_id: SEED_PLAN_ID,
        frequency: "weekdays",
        timezone: "America/New_York",
      }, alice.token);
      assertEquals(ok.status, 201);

      const created = await ok.json();
      groupIds.push(created.group_id);

      const { data: group } = await db
        .from("groups")
        .select("frequency, timezone")
        .eq("id", created.group_id)
        .single();
      assertEquals(group!.frequency, "weekdays");
      assertEquals(group!.timezone, "America/New_York");
    });

    await t.step("create-group takes the redesign's rhythms", async () => {
      const four = await createGroup({
        name: "Four Crew",
        plan_challenge_id: SEED_PLAN_ID,
        frequency: "four_per_week",
        timezone: "UTC",
      }, alice.token);
      assertEquals(four.status, 201);
      groupIds.push((await four.json()).group_id);

      const custom = await createGroup({
        name: "Custom Crew",
        plan_challenge_id: SEED_PLAN_ID,
        frequency: "custom",
        timezone: "UTC",
        custom_days: [2, 4, 6],
      }, alice.token);
      assertEquals(custom.status, 201);
      const customId = (await custom.json()).group_id;
      groupIds.push(customId);

      const { data: group } = await db
        .from("groups").select("frequency, custom_days").eq("id", customId)
        .single();
      assertEquals(group!.frequency, "custom");
      assertEquals(group!.custom_days, [2, 4, 6]);

      // custom without days would never open another day; the other rhythms already
      // carry their own pattern, so a mask alongside them is a contradiction.
      const noDays = await createGroup(
        {
          name: "No Days",
          plan_challenge_id: SEED_PLAN_ID,
          frequency: "custom",
        },
        alice.token,
      );
      assertEquals(noDays.status, 400);

      const bothWays = await createGroup({
        name: "Both",
        plan_challenge_id: SEED_PLAN_ID,
        frequency: "daily",
        custom_days: [1],
      }, alice.token);
      assertEquals(bothWays.status, 400);

      const badDay = await createGroup({
        name: "Bad Day",
        plan_challenge_id: SEED_PLAN_ID,
        frequency: "custom",
        custom_days: [0, 9],
      }, alice.token);
      assertEquals(badDay.status, 400);
    });

    await t.step("join-group rejects an unknown invite", async () => {
      const res = await joinGroup({ invite_token: "nope" }, bob.token);
      assertEquals(res.status, 404);
    });

    await t.step(
      "the second member activates the group and opens Day 1",
      async () => {
        const res = await joinGroup({ invite_token: inviteToken }, bob.token);
        assertEquals(res.status, 200);
        assertEquals((await res.json()).challenge_status, "active");

        const { data: days } = await db
          .from("day_instances")
          .select("id, day_index, passage_ref, status")
          .eq("group_id", groupId);

        assertEquals(days!.length, 1);
        assertEquals(days![0].day_index, 1);
        // Day 1's passage comes from the plan, not from anything the client sent.
        assertEquals(days![0].passage_ref, "PSA.34.18");
        assertEquals(days![0].status, "open");
        dayInstanceId = days![0].id;
      },
    );

    await t.step("re-joining is a no-op rather than an error", async () => {
      const res = await joinGroup({ invite_token: inviteToken }, bob.token);
      assertEquals(res.status, 200);

      const { count } = await db
        .from("group_members")
        .select("user_id", { count: "exact", head: true })
        .eq("group_id", groupId);
      assertEquals(count, 2);

      // And it must not open a second Day 1.
      const { count: dayCount } = await db
        .from("day_instances")
        .select("id", { count: "exact", head: true })
        .eq("group_id", groupId);
      assertEquals(dayCount, 1);
    });

    await t.step("a group fills up at seven members", async () => {
      const extras: TestUser[] = [];
      try {
        // Alice and bob are already in; five more fill it, and the eighth is refused.
        for (let i = 0; i < 5; i++) {
          const u = await createTestUser(db, `filler${i}`);
          extras.push(u);
          users.push(u);
          const res = await joinGroup({ invite_token: inviteToken }, u.token);
          assertEquals(res.status, 200);
        }

        const eighth = await createTestUser(db, "eighth");
        extras.push(eighth);
        users.push(eighth);
        const full = await joinGroup(
          { invite_token: inviteToken },
          eighth.token,
        );
        assertEquals(full.status, 409);
        assertEquals((await full.json()).error, "This group is full");

        // A member already inside can still re-tap their invite link.
        const rejoin = await joinGroup(
          { invite_token: inviteToken },
          extras[0].token,
        );
        assertEquals(rejoin.status, 200);

        const { count } = await db
          .from("group_members")
          .select("user_id", { count: "exact", head: true })
          .eq("group_id", groupId);
        assertEquals(count, 7);
      } finally {
        for (const u of extras) {
          await db.from("group_members").delete().eq("user_id", u.id).eq(
            "group_id",
            groupId,
          );
        }
      }
    });

    await t.step("submit-reflection refuses a non-member", async () => {
      const res = await submit(
        {
          day_instance_id: dayInstanceId,
          media_type: "text",
          content: "hi",
          language: "en",
        },
        carol.token,
      );
      assertEquals(res.status, 403);
    });

    await t.step("submit-reflection requires actual words", async () => {
      const res = await submit(
        {
          day_instance_id: dayInstanceId,
          media_type: "text",
          content: "   ",
          language: "en",
        },
        alice.token,
      );
      assertEquals(res.status, 400);
    });

    await t.step(
      "flagged content is hidden and never reaches generation",
      async () => {
        const ai = fakeAi({ flagged: true });
        const res = await submit(
          {
            day_instance_id: dayInstanceId,
            media_type: "text",
            content: "bad",
            language: "en",
          },
          alice.token,
          ai,
        );

        assertEquals(res.status, 200);
        assertEquals((await res.json()).moderation_status, "flagged");
        // The expensive, content-handling call must not happen for flagged text.
        assertEquals(ai.generateCalls, 0);

        const { data: day } = await db
          .from("day_instances")
          .select("status, participation_count")
          .eq("id", dayInstanceId)
          .single();
        assertEquals(day!.status, "open");
        assertEquals(day!.participation_count, 0);
      },
    );

    await t.step(
      "a failed AI call leaves nothing behind, so the member can retry",
      async () => {
        // Without cleanup the pending row would answer every retry with 409 forever.
        const brokenAi = {
          moderate: () => Promise.reject(new Error("upstream blip")),
          moderateImage: () => Promise.reject(new Error("upstream blip")),
          generateJson: () => Promise.resolve({}),
          generateText: () => Promise.resolve(""),
        };

        const failed = await invoke(() =>
          handleSubmitReflection(
            post({
              day_instance_id: dayInstanceId,
              media_type: "text",
              content: "first attempt",
              language: "en",
            }, bob.token),
            db,
            brokenAi,
          )
        );
        assertEquals(failed.status, 500);

        const { count } = await db
          .from("reflections")
          .select("id", { count: "exact", head: true })
          .eq("day_instance_id", dayInstanceId)
          .eq("user_id", bob.id);
        assertEquals(count, 0);
      },
    );

    await t.step("a voice reflection carries its recording", async () => {
      // The upload itself is Supabase's code and is verified against the hosted project;
      // what matters here is that everything the client CLAIMS about the object is
      // checked before it is attached to a reflection.
      const path = `${bob.id}/${crypto.randomUUID()}.m4a`;
      const store = {
        exists: (p: string) => Promise.resolve(p === path),
        signedUrl: () => Promise.resolve("https://signed.test/a"),
      };
      const withMedia = {
        day_instance_id: dayInstanceId,
        media_type: "voice",
        transcript: "Bob speaking aloud.",
        language: "en",
        media_path: path,
        media_mime: "audio/mp4",
        media_duration_seconds: 42,
      };
      const send = (body: unknown, token: string) =>
        invoke(() => handleSubmitReflection(post(body, token), db, fakeAi(), store));

      // Claiming a group-mate's upload as your own must fail on ownership, not slip
      // through because the path merely looks plausible.
      assertEquals(
        (await send(
          { ...withMedia, media_path: `${alice.id}/not-mine.m4a` },
          bob.token,
        )).status,
        403,
      );
      // A path pointing at nothing would leave a permanently broken play button.
      assertEquals(
        (await send({
          ...withMedia,
          media_path: `${bob.id}/never-uploaded.m4a`,
        }, bob.token))
          .status,
        404,
      );
      // Audio with no transcript could not be moderated, translated or summarised.
      assertEquals(
        (await send({ ...withMedia, transcript: undefined }, bob.token)).status,
        400,
      );
      assertEquals(
        (await send({ ...withMedia, media_duration_seconds: 300 }, bob.token))
          .status,
        400,
      );
      assertEquals(
        (await send({ ...withMedia, media_mime: "video/mp4" }, bob.token))
          .status,
        400,
      );
      assertEquals(
        (await send(
          { ...withMedia, media_type: "text", content: "hi" },
          bob.token,
        )).status,
        400,
      );

      const ok = await send(withMedia, bob.token);
      assertEquals(ok.status, 200);
      const body = await ok.json();
      assertEquals(body.moderation_status, "approved");

      const { data: row } = await db
        .from("reflections")
        .select("media_path, media_mime, media_duration_seconds")
        .eq("id", body.reflection_id)
        .single();
      assertEquals(row!.media_path, path);
      assertEquals(row!.media_duration_seconds, 42);

      await db.from("reflections").delete().eq("id", body.reflection_id);
    });

    await t.step("one reflection per person per day", async () => {
      const res = await submit(
        {
          day_instance_id: dayInstanceId,
          media_type: "text",
          content: "again",
          language: "en",
        },
        alice.token,
      );
      assertEquals(res.status, 409);
    });

    await t.step(
      "an approved reflection carries the day over its threshold",
      async () => {
        // Alice reads Spanish, so bob's English reflection has a real translation target.
        // With everyone on the same language there is nobody to translate for, and
        // translated_text is correctly left null.
        await db.from("users").update({ preferred_language: "es" }).eq(
          "id",
          alice.id,
        );

        const ai = fakeAi();
        const res = await submit(
          {
            day_instance_id: dayInstanceId,
            media_type: "voice",
            transcript: "This passage anchored me today.",
            language: "en",
          },
          bob.token,
          ai,
        );

        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.moderation_status, "approved");
        // Returned inline so the client need not re-fetch just to show the late badge.
        assertEquals(body.is_late, false);
        assertEquals(ai.generateCalls, 1);

        const { data: reflection } = await db
          .from("reflections")
          .select("sentiment_tag, is_late, ai_response, translated_text")
          .eq("id", body.reflection_id)
          .single();
        assertEquals(reflection!.sentiment_tag, "hopeful");
        assertEquals(reflection!.is_late, false);
        // The personalized response has its own column, and translated_text holds only
        // language-keyed translations -- no smuggled "_response" key.
        assertEquals(reflection!.ai_response, "Thank you for sharing this.");
        assertEquals(reflection!.translated_text, { es: "texto traducido" });

        // 1 approved of 2 members = 50%, the default threshold: the trigger flips the day.
        const { data: day } = await db
          .from("day_instances")
          .select("status, participation_count")
          .eq("id", dayInstanceId)
          .single();
        assertEquals(day!.status, "threshold_met");
        assertEquals(day!.participation_count, 1);
      },
    );
  } finally {
    for (const id of groupIds) await db.from("groups").delete().eq("id", id);
    await deleteTestUsers(db, users);
  }
});
