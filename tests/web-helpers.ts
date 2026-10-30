import type { SQL } from "bun";
import { type AppDeps, createApp } from "../src/app";
import { testAdmin } from "./helpers";

export const ORIGIN = "https://yoy.fyi";
export const CLIENT_ID = "123-test.apps.googleusercontent.com";

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

// The cookies a response sets, as a Cookie header; cleared cookies are left out.
export const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");

// The app with Google sign-in for the personal pages, its token endpoint replaced, and requests
// as a browser on our own origin would send them.
export function webApp(sql: SQL, now: () => Date, deps: Partial<AppDeps> = {}) {
  const mail = testAdmin();
  let claims: Record<string, unknown> = {};
  const app = createApp({
    sql,
    publicOrigin: ORIGIN,
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    now,
    admin: {
      ...mail.admin,
      google: {
        clientId: CLIENT_ID,
        clientSecret: "s",
        exchange: async () => Response.json({ id_token: `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig` }),
      },
    },
    ...deps,
  });

  const get = (path: string, cookie = "") => app.request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
  const post = (path: string, fields: Record<string, string | string[]>, cookie = "", origin = ORIGIN) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
    return app.request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
      body: body.toString(),
    });
  };

  // Signs in through the real Google flow and returns the callback's response and session cookie.
  async function signIn(sub = "google-1", email = "ann@example.com", extra: Record<string, unknown> = {}) {
    const start = await get("/login/google");
    const to = new URL(start.headers.get("location")!);
    claims = {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub,
      email,
      email_verified: true,
      name: "Ann",
      nonce: to.searchParams.get("nonce"),
      exp: now().getTime() / 1000 + 3600,
      ...extra,
    };
    const res = await get(`/admin/login/google/callback?code=c&state=${to.searchParams.get("state")}`, cookies(start));
    return { res, cookie: cookies(res) };
  }

  return { app, mail, get, post, signIn };
}
