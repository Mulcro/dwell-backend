import { assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "./http.ts";
import { ONGOING_GROUP_MESSAGE, requireNoOngoingGroup } from "./membership.ts";

const USER = "11111111-1111-1111-1111-111111111111";

function fakeDb(rows: Array<{ group_id: string; status: string }>, error: unknown = null) {
  // deno-lint-ignore no-explicit-any
  const api: any = {
    select: () => api,
    eq: () =>
      Promise.resolve({
        data: rows.map((r) => ({ group_id: r.group_id, groups: { challenge_status: r.status } })),
        error,
      }),
  };
  // deno-lint-ignore no-explicit-any
  return { from: () => api } as any;
}

Deno.test("someone in no group, or only in finished ones, may start or join", async () => {
  await requireNoOngoingGroup(fakeDb([]), USER);
  await requireNoOngoingGroup(
    fakeDb([
      { group_id: "a", status: "completed" },
      { group_id: "b", status: "abandoned" },
      { group_id: "c", status: "expired_incomplete" },
    ]),
    USER,
  );
});

for (const status of ["forming", "active", "paused"]) {
  Deno.test(`a ${status} group holds them back with the screen-ready message`, async () => {
    const err = await assertRejects(
      () => requireNoOngoingGroup(fakeDb([{ group_id: "a", status }]), USER),
      HttpError,
    );
    assertEquals(err.status, 409);
    assertEquals(err.message, ONGOING_GROUP_MESSAGE);
  });
}

Deno.test("the group being joined does not count against itself", async () => {
  // Re-tapping an invite to your own active group stays a no-op, not a 409.
  await requireNoOngoingGroup(fakeDb([{ group_id: "a", status: "active" }]), USER, "a");
});

Deno.test("a failed lookup is a failure, not a pass", async () => {
  const err = await assertRejects(
    () => requireNoOngoingGroup(fakeDb([], { message: "down" }), USER),
    HttpError,
  );
  assertEquals(err.status, 500);
});
