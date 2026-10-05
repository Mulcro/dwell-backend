import { assertEquals } from "@std/assert";
import type { Apns, PushMessage, PushOutcome } from "../_shared/apns.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleSendPush } from "./handler.ts";

const KEY = "service-key";
const USER = "11111111-1111-1111-1111-111111111111";

function request(body: unknown, key = KEY): Request {
  return new Request("http://localhost/send-push", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeDb(pushToken: string | null, options: { clearError?: Error } = {}) {
  const state = {
    updated: null as Record<string, unknown> | null,
    filters: {} as Record<string, unknown>,
  };
  // deno-lint-ignore no-explicit-any
  const api: any = {
    select: () => api,
    eq: () => api,
    maybeSingle: () => Promise.resolve({ data: { push_token: pushToken }, error: null }),
    update: (row: Record<string, unknown>) => {
      state.updated = row;
      // A thenable filter chain, as supabase-js builders are, so every .eq() is seen.
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        eq: (column: string, value: unknown) => {
          state.filters[column] = value;
          return chain;
        },
        then: (resolve: (v: unknown) => void) => resolve({ error: options.clearError ?? null }),
      };
      return chain;
    },
  };
  // deno-lint-ignore no-explicit-any
  return { state, client: { from: () => api } as any };
}

function fakeApns(outcome: PushOutcome) {
  const sent: Array<{ token: string } & PushMessage> = [];
  const apns: Apns = {
    send: (token, message) => {
      sent.push({ token, ...message });
      return Promise.resolve(outcome);
    },
  };
  return { sent, apns };
}

async function call(req: Request, db: unknown, apns: Apns): Promise<Response> {
  try {
    // deno-lint-ignore no-explicit-any
    return await handleSendPush(req, db as any, apns, KEY);
  } catch (err) {
    return toErrorResponse(err);
  }
}

Deno.test("a client token cannot send pushes", async () => {
  const res = await call(
    request({ user_id: USER, title: "t", body: "b" }, "user-jwt"),
    fakeDb("tok").client,
    fakeApns("sent").apns,
  );
  assertEquals(res.status, 401);
});

Deno.test("the message is delivered to the member's registered device", async () => {
  const db = fakeDb("device-token");
  const apple = fakeApns("sent");

  const res = await call(
    request({ user_id: USER, title: "Morning Crew", body: "Still waiting." }),
    db.client,
    apple.apns,
  );

  assertEquals(await res.json(), { delivered: true });
  assertEquals(apple.sent, [{
    token: "device-token",
    title: "Morning Crew",
    body: "Still waiting.",
  }]);
  assertEquals(db.state.updated, null);
});

Deno.test("a member with no device is skipped, not an error", async () => {
  const apple = fakeApns("sent");
  const res = await call(
    request({ user_id: USER, title: "t", body: "b" }),
    fakeDb(null).client,
    apple.apns,
  );

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { delivered: false, reason: "no_token" });
  assertEquals(apple.sent.length, 0);
});

Deno.test("a device Apple no longer knows has its token cleared", async () => {
  const db = fakeDb("stale");
  const res = await call(
    request({ user_id: USER, title: "t", body: "b" }),
    db.client,
    fakeApns("unregistered").apns,
  );

  assertEquals(await res.json(), { delivered: false, reason: "unregistered" });
  assertEquals(db.state.updated, { push_token: null });
  // Only the token Apple rejected: a device that re-registered meanwhile keeps its new one.
  assertEquals(db.state.filters, { id: USER, push_token: "stale" });
});

Deno.test("a failed cleanup is still reported as a dead device, not as delivered", async () => {
  const db = fakeDb("stale", { clearError: new Error("db down") });
  const res = await call(
    request({ user_id: USER, title: "t", body: "b" }),
    db.client,
    fakeApns("unregistered").apns,
  );

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { delivered: false, reason: "unregistered" });
});

Deno.test("a transient refusal keeps the token for next time", async () => {
  const db = fakeDb("fine");
  const res = await call(
    request({ user_id: USER, title: "t", body: "b" }),
    db.client,
    fakeApns("failed").apns,
  );

  assertEquals(await res.json(), { delivered: false, reason: "failed" });
  assertEquals(db.state.updated, null);
});

Deno.test("the message needs a recipient and words", async () => {
  const res = await call(
    request({ user_id: USER, title: "t" }),
    fakeDb("tok").client,
    fakeApns("sent").apns,
  );
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "body is required" });
});

Deno.test("a thread id and tap data are passed through to Apple", async () => {
  const apple = fakeApns("sent");
  const res = await call(
    request({
      user_id: USER,
      title: "t",
      body: "b",
      thread_id: "reflection-1",
      data: { type: "reply", comment_id: "c1" },
    }),
    fakeDb("tok").client,
    apple.apns,
  );
  assertEquals(await res.json(), { delivered: true });
  assertEquals(apple.sent[0].threadId, "reflection-1");
  assertEquals(apple.sent[0].data, { type: "reply", comment_id: "c1" });
});

Deno.test("tap data must be flat strings and may not name aps", async () => {
  for (const data of [{ comment_id: 1 }, { aps: "x" }, ["c1"], "c1"]) {
    const res = await call(
      request({ user_id: USER, title: "t", body: "b", data }),
      fakeDb("tok").client,
      fakeApns("sent").apns,
    );
    assertEquals(res.status, 400);
  }
});
