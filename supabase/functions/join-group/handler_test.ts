import { assertEquals } from "@std/assert";
import { normalizeInviteCode } from "./handler.ts";

Deno.test("normalizeInviteCode accepts a code however it was typed", () => {
  // A code is read aloud, pasted from a share link, and typed into six boxes. All three
  // must land on the value the database stores, which is upper-case and alphanumeric.
  assertEquals(normalizeInviteCode("bcd234"), "BCD234");
  assertEquals(normalizeInviteCode("BCD-234"), "BCD234");
  assertEquals(normalizeInviteCode(" bcd 234 "), "BCD234");
  assertEquals(normalizeInviteCode("BCD234"), "BCD234");
});

Deno.test("normalizeInviteCode leaves a wrong code wrong", () => {
  // Normalizing must not rescue a code that was never valid: stripping punctuation is
  // not the same as guessing what was meant.
  assertEquals(normalizeInviteCode("!!!"), "");
  assertEquals(normalizeInviteCode("TOOLONG9"), "TOOLONG9");
});
