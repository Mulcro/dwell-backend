import { assertEquals } from "@std/assert";
import { toErrorResponse } from "../_shared/http.ts";
import { ALREADY_NUDGED, handleNudgeGroup, NOBODY_REACHED, type NudgePush } from "./handler.ts";

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
  const state = {
    claims: [] as Array<Record<string, unknown>>,
    released: 0,
    updated: null as Record<string, unknown> | null,
  };
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
      delete: () => {
        state.released++;
        // deno-lint-ignore no-explicit-any
        const chain: any = { eq: () => chain, then: (r: any) => r({ error: null }) };
        return chain;
      },
      update: (row: Record<string, unknown>) => {
        state.updated = row;
        // deno-lint-ignore no-explicit-any
        const chain: any = { eq: () => chain, then: (r: any) => r({ error: null }) };
        return chain;
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

/** send-push's answer per recipient; delivered unless named in `fail`. */
function pushRecorder(fail: string[] = [], answer?: Record<string, unknown> | null) {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const push: NudgePush = {
    invoke: (name, body) => {
      const b = body as Record<string, unknown>;
      calls.push({ name, body: b });
      if (answer !== undefined) return Promise.resolve(answer);
      return Promise.resolve(
        fail.includes(b.user_id as string)
          ? { delivered: false, reason: "failed" }
          : { delivered: true },
      );
    },
  };
  return { calls, push };
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
  assertEquals(p.calls.length, 0);
});

Deno.test("sent counts pushes Apple accepted, not pushes attempted", async () => {
  const db = fakeDb();
  const res = await call(post({ group_id: GROUP }), db.client, pushRecorder(["e"]).push);
  assertEquals(await res.json(), { sent: 1 });
  // The record says how many were actually reached.
  assertEquals(db.state.updated, { recipients: 1 });
  assertEquals(db.state.released, 0);
});

Deno.test("if nobody could be reached, the nudge is not used up: 502 and the claim released", async () => {
  for (const p of [pushRecorder(["a", "e"]), pushRecorder([], null)]) {
    const db = fakeDb();
    const res = await call(post({ group_id: GROUP }), db.client, p.push);
    assertEquals(res.status, 502);
    assertEquals((await res.json()).error, NOBODY_REACHED);
    assertEquals(db.state.released, 1);
  }
});

Deno.test("nobody to nudge is not a failure: the nudge still counts for today", async () => {
  const db = fakeDb({ members: [{ id: SENDER, token: "s" }] });
  const res = await call(post({ group_id: GROUP }), db.client, pushRecorder().push);
  assertEquals(await res.json(), { sent: 0 });
  assertEquals(db.state.released, 0);
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
    assertEquals(p.calls.length, 0);
  }
});

Deno.test("it requires a session and a group id", async () => {
  assertEquals(
    (await call(post({ group_id: GROUP }, "bad"), fakeDb().client, pushRecorder().push)).status,
    401,
  );
  assertEquals((await call(post({}), fakeDb().client, pushRecorder().push)).status, 400);
});

Deno.test("a failed lookup is a 500, not a denial", async () => {
  const res = await call(
    post({ group_id: GROUP }),
    fakeDb({ membershipError: { message: "down" } }).client,
    pushRecorder().push,
  );
  assertEquals(res.status, 500);
});
