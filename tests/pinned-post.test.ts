import { afterAll, beforeAll, expect, test } from "bun:test";
import { postPinned } from "../src/outbox";

let server: ReturnType<typeof Bun.serve>;
let received: { host: string | null; body: string; signature: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/slow") await Bun.sleep(500);
      if (path === "/moved") return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
      received.push({ host: req.headers.get("host"), body: await req.text(), signature: req.headers.get("yoy-signature") });
      return new Response("ok", { status: 204 });
    },
  });
});

afterAll(() => server.stop(true));

test("connects to the pinned address, not whatever the hostname resolves to", async () => {
  received = [];
  // hooks.invalid can never resolve, so reaching the server proves the address was pinned.
  const status = await postPinned(
    `http://hooks.invalid:${server.port}/hook`,
    { body: '{"a":1}', headers: { "Content-Type": "application/json", "Yoy-Signature": "t=1,v1=x" } },
    "127.0.0.1",
  );

  expect(status).toBe(204);
  expect(received).toEqual([{ host: `hooks.invalid:${server.port}`, body: '{"a":1}', signature: "t=1,v1=x" }]);
});

test("does not follow redirects", async () => {
  received = [];

  const status = await postPinned(`http://hooks.invalid:${server.port}/moved`, { body: "{}", headers: {} }, "127.0.0.1");

  expect(status).toBe(302);
  expect(received).toHaveLength(0);
});

test("gives up after the timeout", async () => {
  await expect(
    postPinned(`http://hooks.invalid:${server.port}/slow`, { body: "{}", headers: {} }, "127.0.0.1", 100),
  ).rejects.toThrow("timed out");
});
