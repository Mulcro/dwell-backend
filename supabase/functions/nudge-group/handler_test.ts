import { assertEquals } from "@std/assert";
import type { Dispatch } from "../_shared/dispatch.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { ALREADY_NUDGED, handleNudgeGroup, type NudgePush } from "./handler.ts";

const SENDER = "11111111-1111-1111-1111-111111111111";
const GROUP = "99999999-0000-0000-0000-000000000001";
const DAY = "dddddddd-0000-0000-0000-000000000001";

interface Member {
  id: string;
  token?: string | null;
  prefs?: Record<string, boolean>;
  posted?: boolean;
}

function fakeDb(opts: {
  members?: Member[];
  isMember?: boolean;
  status?: string;
  claimError?: { code: string; message: string };
  membershipError?: { message: string };
} = {}) {
  const members: Member[] = opts.members ?? [
    { id: SENDER, token: "sender-device" },
    { id: "a", token: "device-a" },
    { id: "b", token: "device-b", posted: true },
    { id: "c", token: null },
    { id: "d", token: "device-d", prefs: { nudge: false } },
    { id: "e", token: "device-e", prefs: { reply: false } },
  ];
  const state = { claims: [] as Array<Record<string, unknown>> };
  const table = (name: string) => {
    let byUser = false;
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: (col: string) => {
        if (col === "user_id") byUser = true;
        return api;
      },
      order: () => api,
      limit: () => api,
      maybeSingle: () => {
        if (name === "group_members") {
          if (opts.membershipError) {
            return Promise.resolve({ data: null, error: opts.membershipError });
          }
          return Promise.resolve({
            data: opts.isMember === false ? null : { user_id: SENDER },
            error: null,
          });
        }
        if (name === "groups") {
          return Promise.resolve({
            data: { name: "Sunday Crew", challenge_status: opts.status ?? "active" },
            error: null,
          });
        }
        if (name === "day_instances") return Promise.resolve({ data: { id: DAY }, error: null });
        if (name === "users") return Promise.resolve({ data: { name: "Mulero Alamou" } });
        return Promise.resolve({ data: null, error: null });
      },
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) => {
        if (name === "group_members" && !byUser) {
          return resolve({
            data: members.map((m) => ({
              user_id: m.id,
              users: { push_token: m.token ?? null, notification_prefs: m.prefs ?? {} },
            })),
            error: null,
          });
        }
        if (name === "reflections") {
          return resolve({
            data: members.filter((m) => m.posted).map((m) => ({ user_id: m.id })),
            error: null,
          });
        }
        return resolve({ data: [], error: null });
      },
      insert: (row: Record<string, unknown>) => {
        state.claims.push(row);
        return Promise.resolve({ error: opts.claimError ?? null });
      },
    };
    return api;
  };
  return {
    state,
    client: {
      auth: {
        getUser: (token: string) =>
          Promise.resolve({
            data: { user: token === "good" ? { id: SENDER } : null },
            error: token === "good" ? null : new Error("bad"),
          }),
      },
      from: table,
      // deno-lint-ignore no-explicit-any
    } as any,
  };
}

function pushRecorder() {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const deferred: Array<Promise<unknown>> = [];
  const dispatch = ((name: string, body: unknown) => {
    calls.push({ name, body: body as Record<string, unknown> });
    return Promise.resolve();
  }) as Dispatch;
  const push: NudgePush = { dispatch, defer: (work) => deferred.push(work) };
  return { calls, deferred, push };
}

const post = (body: unknown, token = "good") =>
  new Request("http://x", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

async function call(req: Request, db: unknown, push: NudgePush) {
  try {
    // deno-lint-ignore no-explicit-any
    return await handleNudgeGroup(req, db as any, push);
  } catch (err) {
    return toErrorResponse(err);
  }
}

Deno.test("only group-mates who haven't posted, have a device and allow nudges get one", async () => {
  const db = fakeDb();
  const p = pushRecorder();
  const res = await call(post({ group_id: GROUP }), db.client, p.push);

  assertEquals(res.status, 200);
  // a and e: not the sender, b posted, c has no device, d switched nudges off.
  assertEquals(await res.json(), { sent: 2 });
  await Promise.all(p.deferred);
  assertEquals(p.calls.map((c) => c.body.user_id), ["a", "e"]);
  assertEquals(p.calls[0], {
    name: "send-push",
    body: {
      user_id: "a",
      title: "Sunday Crew",
      body: "Mulero is hoping you'll add your reflection today.",
      thread_id: GROUP,
      data: { type: "nudge", group_id: GROUP, day_instance_id: DAY },
    },
  });
  // Today's nudge is claimed with the day it belongs to.
  assertEquals(db.state.claims, [{
    group_id: GROUP,
    day_instance_id: DAY,
    sender_id: SENDER,
    recipients: 2,
  }]);
});

Deno.test("everyone has posted: a valid nudge that reaches nobody", async () => {
  const db = fakeDb({
    members: [{ id: SENDER, token: "s" }, { id: "a", token: "x", posted: true }],
  });
  const p = pushRecorder();
  const res = await call(post({ group_id: GROUP }), db.client, p.push);
  assertEquals(await res.json(), { sent: 0 });
});

Deno.test("a second nudge the same day is a 409 the app can show, and sends nothing", async () => {
  const db = fakeDb({ claimError: { code: "23505", message: "duplicate key" } });
  const p = pushRecorder();
  const res = await call(post({ group_id: GROUP }), db.client, p.push);
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, ALREADY_NUDGED);
  assertEquals(p.deferred.length, 0);
});

Deno.test("a non-member is refused", async () => {
  const res = await call(
    post({ group_id: GROUP }),
    fakeDb({ isMember: false }).client,
    pushRecorder().push,
  );
  assertEquals(res.status, 403);
});

Deno.test("a group that isn't active is refused", async () => {
  for (const status of ["forming", "paused", "completed", "abandoned", "expired_incomplete"]) {
    const p = pushRecorder();
    const res = await call(post({ group_id: GROUP }), fakeDb({ status }).client, p.push);
    assertEquals(res.status, 409);
    assertEquals(p.deferred.length, 0);
  }
});

Deno.test("it requires a session and a group id", async () => {
  assertEquals(
    (await call(post({ group_id: GROUP }, "bad"), fakeDb().client, pushRecorder().push)).status,
    401,
  );
  assertEquals((await call(post({}), fakeDb().client, pushRecorder().push)).status, 400);
});

Deno.test("the button gets its answer without waiting for Apple", async () => {
  const db = fakeDb();
  const deferred: Array<Promise<unknown>> = [];
  const res = await call(post({ group_id: GROUP }), db.client, {
    dispatch: () => new Promise(() => {}),
    defer: (work) => deferred.push(work),
  });
  assertEquals(res.status, 200);
  assertEquals(deferred.length, 1);
});

Deno.test("a failed lookup is a 500, not a denial", async () => {
  const res = await call(
    post({ group_id: GROUP }),
    fakeDb({ membershipError: { message: "down" } }).client,
    pushRecorder().push,
  );
  assertEquals(res.status, 500);
});
