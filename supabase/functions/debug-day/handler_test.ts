import { assertEquals } from "@std/assert";
import { toErrorResponse } from "../_shared/http.ts";
import { handleDebugDay } from "./handler.ts";

const USER = "11111111-1111-1111-1111-111111111111";
const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function request(body: unknown): Request {
  return new Request("http://localhost/debug-day", {
    method: "POST",
    headers: { Authorization: "Bearer user-jwt", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeDb(
  options: { member?: boolean; rpcData?: unknown; rpcError?: { message: string } } = {},
) {
  const state = { rpcCalls: [] as Array<{ fn: string; args: unknown }> };
  // deno-lint-ignore no-explicit-any
  const api: any = {
    select: () => api,
    eq: () => api,
    maybeSingle: () =>
      Promise.resolve({
        data: options.member === false ? null : { user_id: USER },
        error: null,
      }),
  };
  const client = {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: USER } }, error: null }),
    },
    from: () => api,
    rpc: (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({
        data: options.rpcData ?? null,
        error: options.rpcError ?? null,
      });
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { state, client };
}

async function call(req: Request, db: unknown, enabled = true): Promise<Response> {
  try {
    // deno-lint-ignore no-explicit-any
    return await handleDebugDay(req, db as any, enabled);
  } catch (err) {
    return toErrorResponse(err);
  }
}

Deno.test("the endpoint does not exist unless the debug secret enables it", async () => {
  // A production project never sets DEBUG_DAY_ENABLED, so even a real member with a
  // valid body learns nothing about the pacing bypass.
  const res = await call(request({ group_id: GROUP, action: "advance" }), fakeDb().client, false);
  assertEquals(res.status, 404);
});

Deno.test("a non-member cannot move someone else's group", async () => {
  const res = await call(
    request({ group_id: GROUP, action: "advance" }),
    fakeDb({ member: false }).client,
  );
  assertEquals(res.status, 403);
});

Deno.test("an unknown action is rejected before touching the database", async () => {
  const db = fakeDb();
  const res = await call(request({ group_id: GROUP, action: "skip" }), db.client);
  assertEquals(res.status, 400);
  assertEquals(db.state.rpcCalls.length, 0);
});

Deno.test("advance runs the advance function and returns where the group landed", async () => {
  const db = fakeDb({ rpcData: { day_index: 4, challenge_status: "active" } });
  const res = await call(request({ group_id: GROUP, action: "advance" }), db.client);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { day_index: 4, challenge_status: "active" });
  assertEquals(db.state.rpcCalls, [{ fn: "debug_advance_day", args: { p_group_id: GROUP } }]);
});

Deno.test("rewind runs the rewind function", async () => {
  const db = fakeDb({ rpcData: { day_index: 2, challenge_status: "active" } });
  const res = await call(request({ group_id: GROUP, action: "rewind" }), db.client);
  assertEquals(res.status, 200);
  assertEquals(db.state.rpcCalls, [{ fn: "debug_rewind_day", args: { p_group_id: GROUP } }]);
});

Deno.test("a refusal from the database reaches the tester as a conflict", async () => {
  const db = fakeDb({ rpcError: { message: "already on day 1; nothing to rewind" } });
  const res = await call(request({ group_id: GROUP, action: "rewind" }), db.client);
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "already on day 1; nothing to rewind");
});
