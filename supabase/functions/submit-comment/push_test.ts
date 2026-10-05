import { assertEquals } from "@std/assert";
import type { Dispatch } from "../_shared/dispatch.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { fakeAi } from "../_shared/test_helpers.ts";
import { handleSubmitComment, notifyAuthor, type ReplyPush } from "./handler.ts";

const AUTHOR = "aaaaaaaa-0000-0000-0000-000000000001";
const REPLIER = "11111111-1111-1111-1111-111111111111";
const REFLECTION = "eeeeeeee-1111-1111-1111-111111111111";
const DAY = "dddddddd-1111-1111-1111-111111111111";
const GROUP = "99999999-1111-1111-1111-111111111111";
const COMMENT = "cccccccc-1111-1111-1111-111111111111";

/** Answers by table and by which user is asked about. */
function fakeDb(opts: {
  author?: string;
  authorToken?: string | null;
  authorLanguage?: string;
  replierName?: string | null;
} = {}) {
  const author = opts.author ?? AUTHOR;
  const table = (name: string) => {
    let id = "";
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: (_col: string, value: string) => {
        id = value;
        return api;
      },
      maybeSingle: () => {
        if (name === "reflections") {
          return Promise.resolve({ data: { user_id: author, day_instance_id: DAY } });
        }
        if (name === "day_instances") return Promise.resolve({ data: { group_id: GROUP } });
        if (name === "users" && id === author) {
          return Promise.resolve({
            data: {
              preferred_language: opts.authorLanguage ?? "en",
              push_token: opts.authorToken === undefined ? "device" : opts.authorToken,
            },
          });
        }
        if (name === "users") {
          return Promise.resolve({
            data: {
              name: opts.replierName === undefined ? "Janet Okafor" : opts.replierName,
              preferred_language: "en",
            },
          });
        }
        return Promise.resolve({ data: null });
      },
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) => resolve({ data: [{ preferred_language: "en" }] }),
      insert: () => ({
        select: () => ({ single: () => Promise.resolve({ data: { id: COMMENT }, error: null }) }),
      }),
      upsert: () => Promise.resolve({ error: null }),
    };
    return api;
  };
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: REPLIER } }, error: null }) },
    from: table,
    // deno-lint-ignore no-explicit-any
  } as any;
}

function recorder(): Dispatch & { calls: Array<{ name: string; body: Record<string, unknown> }> } {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const fn = (name: string, body: unknown) => {
    calls.push({ name, body: body as Record<string, unknown> });
    return Promise.resolve();
  };
  return Object.assign(fn, { calls });
}

const reply = {
  reflectionId: REFLECTION,
  commentId: COMMENT,
  replierId: REPLIER,
  text: "This encouraged me",
  language: "en",
  translated: null,
};

Deno.test("a reply pushes the reflection's author with the ids to open it", async () => {
  const dispatch = recorder();
  await notifyAuthor(fakeDb(), dispatch, reply);

  assertEquals(dispatch.calls, [{
    name: "send-push",
    body: {
      user_id: AUTHOR,
      title: "Janet replied to your reflection",
      body: "This encouraged me",
      thread_id: REFLECTION,
      data: {
        type: "reply",
        group_id: GROUP,
        day_instance_id: DAY,
        reflection_id: REFLECTION,
        comment_id: COMMENT,
      },
    },
  }]);
});

Deno.test("replying to your own reflection pushes nobody", async () => {
  const dispatch = recorder();
  await notifyAuthor(fakeDb({ author: REPLIER }), dispatch, reply);
  assertEquals(dispatch.calls.length, 0);
});

Deno.test("an author with no device is skipped", async () => {
  const dispatch = recorder();
  await notifyAuthor(fakeDb({ authorToken: null }), dispatch, reply);
  assertEquals(dispatch.calls.length, 0);
});

Deno.test("the preview is in the author's language when a translation exists", async () => {
  const dispatch = recorder();
  await notifyAuthor(fakeDb({ authorLanguage: "fr" }), dispatch, {
    ...reply,
    translated: { fr: "Cela m'a encouragé" },
  });
  assertEquals(dispatch.calls[0].body.body, "Cela m'a encouragé");

  const none = recorder();
  await notifyAuthor(fakeDb({ authorLanguage: "fr" }), none, reply);
  assertEquals(none.calls[0].body.body, "This encouraged me");
});

Deno.test("a long reply is cut to about one line, at a word", async () => {
  const dispatch = recorder();
  const long = "word ".repeat(60).trim();
  await notifyAuthor(fakeDb(), dispatch, { ...reply, text: long });
  const body = dispatch.calls[0].body.body as string;
  assertEquals(body.length <= 100, true);
  assertEquals(body.endsWith("word…"), true);
});

Deno.test("a replier without a name still produces a title", async () => {
  const dispatch = recorder();
  await notifyAuthor(fakeDb({ replierName: null }), dispatch, reply);
  assertEquals(dispatch.calls[0].body.title, "Someone replied to your reflection");
});

Deno.test("a failing push never throws", async () => {
  const failing = (() => Promise.reject(new Error("down"))) as Dispatch;
  await notifyAuthor(fakeDb(), failing, reply);
});

const post = (body: unknown) =>
  new Request("http://x", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer good" },
    body: JSON.stringify(body),
  });
const visible = { canSee: () => Promise.resolve(true) };
const present = { exists: () => Promise.resolve(true), signedUrl: () => Promise.resolve("u") };

Deno.test("the reply is answered without waiting for the push", async () => {
  // A push that never finishes must not hold the response.
  const deferred: Array<Promise<unknown>> = [];
  const push: ReplyPush = {
    dispatch: () => new Promise(() => {}),
    defer: (work) => deferred.push(work),
  };
  const res = await handleSubmitComment(
    post({ reflection_id: REFLECTION, content: "well said" }),
    fakeDb(),
    fakeAi(),
    visible,
    present,
    push,
  );
  assertEquals(res.status, 201);
  assertEquals(deferred.length, 1);
});

Deno.test("a refused reply schedules no push", async () => {
  const deferred: Array<Promise<unknown>> = [];
  let res: Response;
  try {
    res = await handleSubmitComment(
      post({ reflection_id: REFLECTION, content: "awful words" }),
      fakeDb(),
      fakeAi({ flagged: true }),
      visible,
      present,
      { dispatch: recorder(), defer: (work) => deferred.push(work) },
    );
  } catch (err) {
    res = toErrorResponse(err);
  }
  assertEquals(res.status, 422);
  assertEquals(deferred.length, 0);
});
