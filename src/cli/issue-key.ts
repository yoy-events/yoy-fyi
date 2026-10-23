// Issues an API key for a service, creating the service on first use. Prints the key once.
// Usage: bun run key:issue <service-slug> <key-name> <scope> [scope...]
import { SQL } from "bun";
import { SCOPES, type Scope, issueKey } from "../keys";
import { migrate } from "../migrate";

const [serviceSlug, name, ...scopes] = process.argv.slice(2);
const invalid = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
if (!serviceSlug || !name || scopes.length === 0 || invalid.length) {
  console.error(`Usage: bun run key:issue <service-slug> <key-name> <scope...>\nScopes: ${SCOPES.join(" ")}`);
  if (invalid.length) console.error(`Unknown scopes: ${invalid.join(" ")}`);
  process.exit(1);
}

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const { token, key } = await issueKey(sql, { serviceSlug, name, scopes: scopes as Scope[] });
console.log(`service: ${serviceSlug}\nkey:     ${key.prefix} (${key.scopes.join(", ")})\nsecret:  ${token}\nShown once. Store it now.`);
await sql.close();
