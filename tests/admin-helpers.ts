import type { createApp } from "../src/app";
import { ADMIN_EMAIL, type testAdmin } from "./helpers";

type App = ReturnType<typeof createApp>;

export const adminPost = (app: App, path: string, fields: Record<string, string | string[]>, cookie = "") => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
  return app.request(`https://yoy.fyi${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://yoy.fyi", cookie },
    body: body.toString(),
  });
};

export const adminGet = (app: App, path: string, cookie: string) =>
  app.request(`https://yoy.fyi${path}`, { headers: { cookie } });

// Signs in through the real magic-link flow and returns the session cookie.
export async function adminSession(app: App, mail: ReturnType<typeof testAdmin>): Promise<string> {
  await adminPost(app, "/admin/login", { email: ADMIN_EMAIL });
  const token = new URL(/https:\/\/\S+/.exec(mail.sent.at(-1)!.text)![0]).searchParams.get("token")!;
  const res = await adminPost(app, "/admin/login/verify", { token });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
