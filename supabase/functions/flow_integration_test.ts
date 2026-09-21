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
      const res = await createGroup({ name: "Crew", plan_challenge_id: SEED_PLAN_ID });
      assertEquals(res.status, 401);
    });

    await t.step("create-group validates its input", async () => {
      const missingName = await createGroup({ plan_challenge_id: SEED_PLAN_ID }, alice.token);
      assertEquals(missingName.status, 400);

      const unknownPlan = await createGroup(
        { name: "Crew", plan_challenge_id: crypto.randomUUID() },
        alice.token,
      );
      assertEquals(unknownPlan.status, 404);
    });

    await t.step("create-group creates a forming group with its creator inside", async () => {
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
        .select("challenge_status, created_by")
        .eq("id", groupId)
        .single();
      assertEquals(group!.challenge_status, "forming");
      assertEquals(group!.created_by, alice.id);

      // A group whose creator is not a member would be invisible to everyone.
      const { count } = await db
        .from("group_members")
        .select("user_id", { count: "exact", head: true })
        .eq("group_id", groupId);
      assertEquals(count, 1);

      assertEquals(typeof inviteToken, "string");
      assertEquals(inviteToken.length > 0, true);
    });

    await t.step("join-group rejects an unknown invite", async () => {
      const res = await joinGroup({ invite_token: "nope" }, bob.token);
      assertEquals(res.status, 404);
    });

    await t.step("the second member activates the group and opens Day 1", async () => {
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
      assertEquals(days![0].passage_ref, "HEB.6.19");
      assertEquals(days![0].status, "open");
      dayInstanceId = days![0].id;
    });

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

    await t.step("submit-reflection refuses a non-member", async () => {
      const res = await submit(
        { day_instance_id: dayInstanceId, media_type: "text", content: "hi", language: "en" },
        carol.token,
      );
      assertEquals(res.status, 403);
    });

    await t.step("submit-reflection requires actual words", async () => {
      const res = await submit(
        { day_instance_id: dayInstanceId, media_type: "text", content: "   ", language: "en" },
        alice.token,
      );
      assertEquals(res.status, 400);
    });

    await t.step("flagged content is hidden and never reaches generation", async () => {
      const ai = fakeAi({ flagged: true });
      const res = await submit(
        { day_instance_id: dayInstanceId, media_type: "text", content: "bad", language: "en" },
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
    });

    await t.step("one reflection per person per day", async () => {
      const res = await submit(
        { day_instance_id: dayInstanceId, media_type: "text", content: "again", language: "en" },
        alice.token,
      );
      assertEquals(res.status, 409);
    });

    await t.step("an approved reflection carries the day over its threshold", async () => {
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
      assertEquals(ai.generateCalls, 1);

      const { data: reflection } = await db
        .from("reflections")
        .select("sentiment_tag, is_late")
        .eq("id", body.reflection_id)
        .single();
      assertEquals(reflection!.sentiment_tag, "hopeful");
      assertEquals(reflection!.is_late, false);

      // 1 approved of 2 members = 50%, the default threshold: the trigger flips the day.
      const { data: day } = await db
        .from("day_instances")
        .select("status, participation_count")
        .eq("id", dayInstanceId)
        .single();
      assertEquals(day!.status, "threshold_met");
      assertEquals(day!.participation_count, 1);
    });
  } finally {
    for (const id of groupIds) await db.from("groups").delete().eq("id", id);
    await deleteTestUsers(db, users);
  }
});
