import { afterAll, beforeAll, expect, test } from "bun:test";
import { postWebhook } from "../src/outbox";

let server: ReturnType<typeof Bun.serve>;
let received: { body: string; signature: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/slow") await Bun.sleep(500);
      if (path === "/moved") return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
      received.push({ body: await req.text(), signature: req.headers.get("yoy-signature") });
      return new Response("ok", { status: 204 });
    },
  });
});

afterAll(() => server.stop(true));

const url = (path: string) => `http://localhost:${server.port}${path}`;

test("POSTs the body and headers and returns the status", async () => {
  received = [];

  const status = await postWebhook(url("/hook"), { body: '{"a":1}', headers: { "Yoy-Signature": "t=1,v1=x" } });

  expect(status).toBe(204);
  expect(received).toEqual([{ body: '{"a":1}', signature: "t=1,v1=x" }]);
});

test("does not follow redirects", async () => {
  received = [];

  expect(await postWebhook(url("/moved"), { body: "{}", headers: {} })).toBe(302);
  expect(received).toHaveLength(0);
});

test("gives up after the timeout", async () => {
  await expect(postWebhook(url("/slow"), { body: "{}", headers: {} }, 100)).rejects.toThrow("timed out");
});
