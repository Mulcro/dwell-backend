import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { createApns } from "./apns.ts";

const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });

const config = {
  authKeyBase64: btoa(await exportPKCS8(privateKey)),
  keyId: "KEY1234567",
  teamId: "TEAM567890",
  bundleId: "com.example.dwell",
  host: "api.sandbox.push.apple.com",
};

function fakeApple(status: number, body = "") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { calls, impl };
}

function header(init: RequestInit, name: string): string {
  return (init.headers as Record<string, string>)[name];
}

Deno.test("a push goes to the device on the configured host, addressed to the app", async () => {
  const apple = fakeApple(200);
  const apns = createApns(config, apple.impl);

  const outcome = await apns.send("abc123", {
    title: "Dwell",
    body: "Today's passage is waiting.",
  });

  assertEquals(outcome, "sent");
  assertEquals(apple.calls[0].url, "https://api.sandbox.push.apple.com/3/device/abc123");
  assertEquals(header(apple.calls[0].init, "apns-topic"), "com.example.dwell");
  assertEquals(header(apple.calls[0].init, "apns-push-type"), "alert");
  assertEquals(JSON.parse(apple.calls[0].init.body as string), {
    aps: { alert: { title: "Dwell", body: "Today's passage is waiting." }, sound: "default" },
  });
});

Deno.test("the bearer is a provider token signed by our key, naming the key and the team", async () => {
  const apple = fakeApple(200);
  await createApns(config, apple.impl).send("abc123", { title: "t", body: "b" });

  const auth = header(apple.calls[0].init, "authorization");
  assert(auth.startsWith("bearer "));
  const jwt = auth.slice("bearer ".length);
  assertEquals(decodeProtectedHeader(jwt), { alg: "ES256", kid: "KEY1234567" });
  const { payload } = await jwtVerify(jwt, publicKey, { issuer: "TEAM567890" });
  assertEquals(typeof payload.iat, "number");
});

Deno.test("the token is reused within the hour and reissued once it is stale", async () => {
  let clock = 1_700_000_000_000;
  const apple = fakeApple(200);
  const apns = createApns(config, apple.impl, () => clock);

  await apns.send("a", { title: "t", body: "b" });
  clock += 10 * 60 * 1000;
  await apns.send("a", { title: "t", body: "b" });
  clock += 50 * 60 * 1000;
  await apns.send("a", { title: "t", body: "b" });

  const bearers = apple.calls.map((c) => header(c.init, "authorization"));
  assertEquals(bearers[0], bearers[1]);
  assertNotEquals(bearers[1], bearers[2]);
});

Deno.test("410 means Apple no longer knows the device", async () => {
  const apple = fakeApple(410, '{"reason":"Unregistered"}');
  assertEquals(
    await createApns(config, apple.impl).send("dead", { title: "t", body: "b" }),
    "unregistered",
  );
});

Deno.test("any other refusal is a failure, not a dead device", async () => {
  // BadDeviceToken is usually a sandbox token sent to production: the device is fine.
  const apple = fakeApple(400, '{"reason":"BadDeviceToken"}');
  assertEquals(await createApns(config, apple.impl).send("x", { title: "t", body: "b" }), "failed");
});

Deno.test("a pasted PEM works as well as the base64 form", async () => {
  const apple = fakeApple(200);
  const apns = createApns({ ...config, authKeyBase64: await exportPKCS8(privateKey) }, apple.impl);
  assertEquals(await apns.send("a", { title: "t", body: "b" }), "sent");
});

Deno.test("custom keys ride beside aps, the alert stays title and body, and aps can't be replaced", async () => {
  const apple = fakeApple(200);
  await createApns(config, apple.impl).send("abc123", {
    title: "Janet replied to your reflection",
    body: "This encouraged me",
    threadId: "reflection-1",
    data: { type: "reply", comment_id: "c1", aps: "hijack" },
  });

  assertEquals(JSON.parse(apple.calls[0].init.body as string), {
    type: "reply",
    comment_id: "c1",
    aps: {
      alert: { title: "Janet replied to your reflection", body: "This encouraged me" },
      sound: "default",
      "thread-id": "reflection-1",
    },
  });
});
