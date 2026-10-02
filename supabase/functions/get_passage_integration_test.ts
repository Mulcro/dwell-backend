/**
 * get-passage against the real local database, with YouVersion faked.
 *
 * The upstream call is stubbed so the suite neither depends on their availability nor
 * burns quota; the cache, validation and auth path are all real.
 */
import { assertEquals } from "@std/assert";
import { handleGetPassage, type PassageSource } from "./get-passage/handler.ts";
import {
  createTestUser,
  deleteTestUsers,
  invoke,
  post,
  serviceClient,
  type TestUser,
} from "./_shared/test_helpers.ts";

const CONFIG = { bibleId: 3034, translation: "BSB" };

function countingSource(): PassageSource & { calls: number } {
  const source = {
    calls: 0,
    fetch(_bibleId: number, ref: string) {
      source.calls++;
      return Promise.resolve({
        reference: `Ref for ${ref}`,
        content: `Text of ${ref}`,
      });
    },
  };
  return source;
}

Deno.test("get-passage", async (t) => {
  const db = serviceClient();
  const users: TestUser[] = [];
  const alice = await createTestUser(db, "alice");
  users.push(alice);
  const ref = `PSA.${Math.floor(Math.random() * 100000)}.1`;

  const call = (
    body: unknown,
    token: string | undefined,
    source: PassageSource,
  ) => invoke(() => handleGetPassage(post(body, token), db, source, CONFIG));

  try {
    await t.step("requires a signed-in caller", async () => {
      const res = await call({ ref: "PSA.34.18" }, undefined, countingSource());
      assertEquals(res.status, 401);
    });

    await t.step("rejects anything that is not a USFM id", async () => {
      const source = countingSource();
      for (
        const bad of [
          "",
          "not a ref",
          "../../etc/passwd",
          "PSA.34.18; drop table",
        ]
      ) {
        const res = await call({ ref: bad }, alice.token, source);
        assertEquals(res.status, 400);
      }
      // A malformed ref must never reach the upstream API.
      assertEquals(source.calls, 0);
    });

    await t.step("fetches once, then serves from cache", async () => {
      const source = countingSource();

      const first = await call({ ref }, alice.token, source);
      assertEquals(first.status, 200);
      const a = await first.json();
      assertEquals(a.content, `Text of ${ref}`);
      assertEquals(a.translation, "BSB");
      assertEquals(a.cached, false);
      assertEquals(source.calls, 1);

      const second = await call({ ref }, alice.token, source);
      const b = await second.json();
      assertEquals(b.content, `Text of ${ref}`);
      assertEquals(b.cached, true);
      // The whole point: the second read never touches YouVersion.
      assertEquals(source.calls, 1);
    });

    await t.step(
      "the cached row is readable by a signed-in client",
      async () => {
        const { data } = await db
          .from("passage_cache")
          .select("reference, translation")
          .eq("bible_id", CONFIG.bibleId)
          .eq("passage_ref", ref)
          .single();
        assertEquals(data!.translation, "BSB");
      },
    );
  } finally {
    await db.from("passage_cache").delete().eq("passage_ref", ref);
    await deleteTestUsers(db, users);
  }
});
