// Prepares a fresh database for the Playwright run: a service with an API key and a known
// admin sign-in token (stored hashed, as the app does). Writes both to tests/e2e/.state.json.
import { SQL } from "bun";
import { issueKey } from "../../src/keys";
import { migrate } from "../../src/migrate";

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55433/postgres";
const admin = new SQL(adminUrl);
await admin.unsafe("drop database if exists yoy_fyi_e2e with (force)");
await admin.unsafe("create database yoy_fyi_e2e");
await admin.close();

const url = new URL(adminUrl);
url.pathname = "/yoy_fyi_e2e";
const sql = new SQL(url.toString());
await migrate(sql);
const { token: apiKey } = await issueKey(sql, { serviceSlug: "e2e", name: "e2e", scopes: ["links:write", "links:read"] });
const loginToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const hash = new Bun.CryptoHasher("sha256").update(loginToken).digest("hex");
await sql`insert into admin_login_tokens (token_hash, expires_at) values (${hash}, now() + interval '15 minutes')`;
await sql.close();

await Bun.write(new URL("./.state.json", import.meta.url), JSON.stringify({ apiKey, loginToken, databaseUrl: url.toString() }));
