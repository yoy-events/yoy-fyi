import { expect, test } from "bun:test";
import { resendSender } from "../src/email";

test("sends through the Resend API with the key in the Authorization header", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"id":"x"}', { status: 200 });
  }) as unknown as typeof fetch;

  await resendSender("re_test", "yoy.fyi <login@yoy.fyi>", fakeFetch)({ to: "a@b.c", subject: "Hi", text: "Body" });

  expect(calls[0]!.url).toBe("https://api.resend.com/emails");
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer re_test");
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
    from: "yoy.fyi <login@yoy.fyi>",
    to: ["a@b.c"],
    subject: "Hi",
    text: "Body",
  });
});

test("throws on a non-2xx answer without echoing the key", async () => {
  const fakeFetch = (async () => new Response("bad", { status: 422 })) as unknown as typeof fetch;

  const send = resendSender("re_secret_value", "x@yoy.fyi", fakeFetch)({ to: "a@b.c", subject: "s", text: "t" });

  await expect(send).rejects.toThrow("Resend answered 422");
  await expect(send).rejects.not.toThrow("re_secret_value");
});
