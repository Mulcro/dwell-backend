/**
 * The client-facing functions against the real local database.
 *
 * Only OpenAI is faked; every query, constraint, policy and trigger here is the real one.
 * Run with `supabase start` up: `deno task test:integration`.
 */
import { assertEquals } from "@std/assert";
import { handleCreateGroup } from "./create-group/handler.ts";
import { ALREADY_NUDGED, handleNudgeGroup } from "./nudge-group/handler.ts";
import { ONGOING_GROUP_MESSAGE } from "./_shared/membership.ts";
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

  // Someone who belongs to no group yet. Alice is in Morning Crew from early on, and one
  // challenge at a time means she cannot also create the rhythm groups below.
  const newcomer = async (name: string) => {
    const u = await createTestUser(db, name);
    users.push(u);
    return u;
  };

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

    await t.step("create-group accepts a client-supplied threshold and stores 50", async () => {
      // Every build shipped before KAN-43 sends the slider's value; refusing it broke
      // group creation for all of them (KAN-49).
      const res = await createGroup(
        { name: "Old Build Crew", plan_challenge_id: SEED_PLAN_ID, catch_up_threshold_pct: 100 },
        (await newcomer("oldbuild")).token,
      );
      assertEquals(res.status, 201);
      const { group_id } = await res.json();
      groupIds.push(group_id);

      const { data: group } = await db
        .from("groups").select("catch_up_threshold_pct").eq("id", group_id).single();
      assertEquals(group!.catch_up_threshold_pct, 50);
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
      }, (await newcomer("weekday")).token);
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
      }, (await newcomer("four")).token);
      assertEquals(four.status, 201);
      groupIds.push((await four.json()).group_id);

      const custom = await createGroup({
        name: "Custom Crew",
        plan_challenge_id: SEED_PLAN_ID,
        frequency: "custom",
        timezone: "UTC",
        custom_days: [2, 4, 6],
      }, (await newcomer("custom")).token);
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

    let hostInvite = "";
    let hostGroup = "";

    await t.step(
      "someone whose challenge is still going can neither start nor join another",
      async () => {
        // Alice and bob are both in Morning Crew, which is active.
        const another = await createGroup(
          { name: "Second Crew", plan_challenge_id: SEED_PLAN_ID },
          alice.token,
        );
        assertEquals(another.status, 409);
        assertEquals((await another.json()).error, ONGOING_GROUP_MESSAGE);

        const host = await newcomer("host");
        const hosted = await createGroup(
          { name: "Host Crew", plan_challenge_id: SEED_PLAN_ID },
          host.token,
        );
        assertEquals(hosted.status, 201);
        const created = await hosted.json();
        hostGroup = created.group_id;
        hostInvite = created.invite_token;
        groupIds.push(hostGroup);

        const join = await joinGroup({ invite_token: hostInvite }, bob.token);
        assertEquals(join.status, 409);
        assertEquals((await join.json()).error, ONGOING_GROUP_MESSAGE);
        const { count } = await db
          .from("group_members")
          .select("user_id", { count: "exact", head: true })
          .eq("group_id", hostGroup)
          .eq("user_id", bob.id);
        assertEquals(count, 0);
      },
    );

    await t.step("once that challenge has finished, they can do both", async () => {
      await db.from("groups").update({ challenge_status: "completed" }).eq("id", groupId);

      // Same crew, new plan is a new group: the old one stays theirs, finished.
      const next = await createGroup(
        { name: "Morning Crew", plan_challenge_id: SEED_PLAN_ID },
        alice.token,
      );
      assertEquals(next.status, 201);
      groupIds.push((await next.json()).group_id);

      const join = await joinGroup({ invite_token: hostInvite }, bob.token);
      assertEquals(join.status, 200);
      assertEquals((await join.json()).challenge_status, "active");
    });

    await t.step("same crew, new plan: the old crew joins by id, nobody else can", async () => {
      // A crew of three finishes a challenge.
      const [lead, mate, third, stranger] = await Promise.all(
        ["lead", "mate", "third", "stranger"].map(newcomer),
      );
      const old = await (await createGroup(
        { name: "Old Crew", plan_challenge_id: SEED_PLAN_ID },
        lead.token,
      )).json();
      groupIds.push(old.group_id);
      await joinGroup({ invite_token: old.invite_token }, mate.token);
      await joinGroup({ invite_token: old.invite_token }, third.token);

      // Continuing a group that is still going is refused...
      const early = await createGroup(
        { name: "Too Soon", plan_challenge_id: SEED_PLAN_ID, continues_group_id: old.group_id },
        lead.token,
      );
      assertEquals(early.status, 409);
      assertEquals((await early.json()).error, "That group's challenge hasn't ended yet");

      await db.from("groups").update({ challenge_status: "completed" }).eq("id", old.group_id);

      // ...and so is continuing a group you were never in, which reads as not found.
      const outsider = await createGroup(
        { name: "Not Mine", plan_challenge_id: SEED_PLAN_ID, continues_group_id: old.group_id },
        stranger.token,
      );
      assertEquals(outsider.status, 404);

      const next = await createGroup(
        { name: "Old Crew", plan_challenge_id: SEED_PLAN_ID, continues_group_id: old.group_id },
        lead.token,
      );
      assertEquals(next.status, 201);
      const created = await next.json();
      groupIds.push(created.group_id);
      const { data: stored } = await db
        .from("groups").select("continues_group_id").eq("id", created.group_id).single();
      assertEquals(stored!.continues_group_id, old.group_id);

      // Someone from outside the old crew cannot join by id: it reads as an unknown invite.
      const probe = await joinGroup({ group_id: created.group_id }, stranger.token);
      assertEquals(probe.status, 404);

      // A previous member accepts with one tap and the group activates.
      const accepted = await joinGroup({ group_id: created.group_id }, mate.token);
      assertEquals(accepted.status, 200);
      assertEquals((await accepted.json()).challenge_status, "active");

      // The same one-challenge rule as joining by code.
      const busy = await (await createGroup(
        { name: "Elsewhere", plan_challenge_id: SEED_PLAN_ID },
        stranger.token,
      )).json();
      groupIds.push(busy.group_id);
      await joinGroup({ invite_token: busy.invite_token }, third.token);
      const blocked = await joinGroup({ group_id: created.group_id }, third.token);
      assertEquals(blocked.status, 409);
      assertEquals((await blocked.json()).error, ONGOING_GROUP_MESSAGE);

      const neither = await joinGroup({}, mate.token);
      assertEquals(neither.status, 400);

      // A stale code alongside the invitation the user tapped must not pick for them.
      const both = await joinGroup(
        { invite_token: busy.invite_token, group_id: created.group_id },
        mate.token,
      );
      assertEquals(both.status, 400);
      assertEquals((await both.json()).error, "Send invite_token or group_id, not both");
    });

    await t.step("nudge the group: only those who haven't posted, once a day", async () => {
      const [sender, quiet, poster, muted, outsider] = await Promise.all(
        ["sender", "quiet", "poster", "muted", "outsider"].map(newcomer),
      );
      const crew = await (await createGroup(
        { name: "Nudge Crew", plan_challenge_id: SEED_PLAN_ID },
        sender.token,
      )).json();
      groupIds.push(crew.group_id);
      for (const u of [quiet, poster, muted]) {
        await joinGroup({ invite_token: crew.invite_token }, u.token);
      }
      for (const u of [sender, quiet, poster, muted]) {
        await db.from("users").update({ push_token: `device-${u.id}` }).eq("id", u.id);
      }
      await db.from("users").update({ notification_prefs: { nudge: false } }).eq("id", muted.id);

      const { data: day } = await db
        .from("day_instances").select("id").eq("group_id", crew.group_id).single();
      const posted = await submit(
        { day_instance_id: day!.id, media_type: "text", content: "Here today.", language: "en" },
        poster.token,
      );
      assertEquals(posted.status, 200);

      const calls: Array<Record<string, unknown>> = [];
      const push = {
        invoke: (_name: string, body: unknown) => {
          calls.push(body as Record<string, unknown>);
          return Promise.resolve({ delivered: true });
        },
      };
      const nudge = (token: string) =>
        invoke(() => handleNudgeGroup(post({ group_id: crew.group_id }, token), db, push));

      const first = await nudge(sender.token);
      assertEquals(first.status, 200);
      assertEquals(await first.json(), { sent: 1 });
      // Not the sender, not the one who posted, not the one who switched nudges off.
      assertEquals(calls.map((c) => c.user_id), [quiet.id]);

      const again = await nudge(sender.token);
      assertEquals(again.status, 409);
      assertEquals((await again.json()).error, ALREADY_NUDGED);

      // Each member has their own nudge for the day.
      assertEquals((await nudge(quiet.token)).status, 200);

      assertEquals((await nudge(outsider.token)).status, 403);
    });
  } finally {
    for (const id of groupIds) await db.from("groups").delete().eq("id", id);
    await deleteTestUsers(db, users);
  }
});
