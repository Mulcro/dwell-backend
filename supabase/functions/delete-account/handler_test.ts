import { assertEquals } from "@std/assert";
import { handleDeleteAccount } from "./handler.ts";
import { toErrorResponse } from "../_shared/http.ts";

const USER = "11111111-1111-1111-1111-111111111111";

interface Calls {
  deleted: string[];
  queued: string[];
}

/** A database stub: records what would have been deleted, touches nothing. */
function fakeDb(calls: Calls, options: { listError?: boolean } = {}) {
  return {
    auth: {
      getUser: (token: string) =>
        Promise.resolve({
          data: { user: token === "good" ? { id: USER } : null },
          error: token === "good" ? null : new Error("bad token"),
        }),
      admin: {
        deleteUser: (id: string) => {
          calls.deleted.push(id);
          return Promise.resolve({ error: null });
        },
      },
    },
    storage: {
      from: () => ({
        list: () =>
          Promise.resolve(
            options.listError
              ? { data: null, error: new Error("storage down") }
              : { data: [{ name: "a.m4a" }, { name: "b.m4a" }], error: null },
          ),
      }),
    },
    from: () => ({
      upsert: (rows: Array<{ path: string }>) => {
        calls.queued.push(...rows.map((r) => r.path));
        return Promise.resolve({ error: null });
      },
    }),
    // deno-lint-ignore no-explicit-any
  } as any;
}

const req = (body: unknown, token = "good") =>
  new Request("http://x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

const run = async (fn: () => Promise<Response>) => {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err);
  }
};

Deno.test("delete-account erases the caller and sweeps their recordings", async () => {
  const calls: Calls = { deleted: [], queued: [] };
  const res = await run(() => handleDeleteAccount(req({ confirm: "DELETE" }), fakeDb(calls)));

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true });
  assertEquals(calls.deleted, [USER]);
  // Both recordings go to the queue, including any never attached to a reflection --
  // the reflections trigger never learns about those.
  assertEquals(calls.queued, [`${USER}/a.m4a`, `${USER}/b.m4a`]);
});

Deno.test("delete-account refuses without the confirmation", async () => {
  // A mis-wired client calling this route must not be able to erase an account.
  const calls: Calls = { deleted: [], queued: [] };
  const res = await run(() => handleDeleteAccount(req({}), fakeDb(calls)));

  assertEquals(res.status, 400);
  assertEquals(calls.deleted, []);
  assertEquals(calls.queued, []);
});

Deno.test("delete-account requires a session", async () => {
  // There is no way to name another user, so an unauthenticated call deletes nobody.
  const calls: Calls = { deleted: [], queued: [] };
  const res = await run(() =>
    handleDeleteAccount(req({ confirm: "DELETE" }, "bad"), fakeDb(calls))
  );

  assertEquals(res.status, 401);
  assertEquals(calls.deleted, []);
});

Deno.test("delete-account still erases the account when Storage is unreachable", async () => {
  // Someone asking to be erased should not be told to come back later; the recordings
  // stay queued for the cron rather than blocking the deletion.
  const calls: Calls = { deleted: [], queued: [] };
  const res = await run(() =>
    handleDeleteAccount(
      req({ confirm: "DELETE" }),
      fakeDb(calls, { listError: true }),
    )
  );

  assertEquals(res.status, 200);
  assertEquals(calls.deleted, [USER]);
});
