// Link-in-bio pages (yoy.fyi/@handle): one per user, shared by the web form and the MCP tools.
import type { SQL } from "bun";
import type { Lang } from "./blog";
import { isUuid } from "./http";
import { MESSAGES } from "./messages";

export const HANDLE = /^[a-z0-9][a-z0-9_.-]{2,29}$/;
const RESERVED_HANDLES = new Set(["admin", "yoy", "yoyfyi", "support", "help", "api", "root", "account", "login"]);
export const MAX_BIO_LINKS = 30;

export type BioInput = { handle: string; title: string; description: string; link: string[] };
export type BioError =
  | { code: "handle" | "title" | "description" | "own_links" }
  | { code: "max_links" }
  | { code: "taken"; url: string };

export function bioErrorText(e: BioError, lang: Lang): string {
  const T = MESSAGES[lang].bio;
  if (e.code === "max_links") return T.maxLinks(MAX_BIO_LINKS);
  if (e.code === "taken") return T.taken(e.url);
  return { handle: T.handle, title: T.title, description: T.description, own_links: T.ownLinks }[e.code];
}

export type BioPage = { handle: string; title: string | null; description: string | null; link_ids: string[] };

export async function getBio(sql: SQL, userId: string): Promise<BioPage | null> {
  const [page] = await sql`select handle, title, description, link_ids::text[] as link_ids from bio_pages where user_id = ${userId}`;
  return page ?? null;
}

// Validates and saves; each error is a code the caller words in its language (bioErrorText).
export async function saveBio(
  sql: SQL,
  { userId, serviceId, publicOrigin, now }: { userId: string; serviceId: string; publicOrigin: string; now: Date },
  input: BioInput,
): Promise<{ errors: BioError[] } | { page: BioPage }> {
  const v = { ...input, handle: input.handle.trim().toLowerCase(), title: input.title.trim(), description: input.description.trim() };
  const errors: BioError[] = [];
  if (!HANDLE.test(v.handle)) errors.push({ code: "handle" });
  if (v.title.length > 100) errors.push({ code: "title" });
  if (v.description.length > 300) errors.push({ code: "description" });
  if (v.link.length > MAX_BIO_LINKS) errors.push({ code: "max_links" });
  else if (v.link.length) {
    const own = v.link.every(isUuid) ? await sql`select id from links where service_id = ${serviceId} and id in ${sql(v.link)}` : [];
    if (own.length !== new Set(v.link).size) errors.push({ code: "own_links" });
  }
  if (!errors.length && RESERVED_HANDLES.has(v.handle)) errors.push({ code: "taken", url: `${publicOrigin}/@${v.handle}` });
  if (!errors.length) {
    const [taken] = await sql`select 1 from bio_pages where handle = ${v.handle} and user_id <> ${userId}`;
    if (taken) errors.push({ code: "taken", url: `${publicOrigin}/@${v.handle}` });
  }
  if (errors.length) return { errors };
  const [page] = await sql`
    insert into bio_pages (user_id, handle, title, description, link_ids, updated_at)
    values (${userId}, ${v.handle}, ${v.title || null}, ${v.description || null}, ${sql.array([...new Set(v.link)], "uuid")}, ${now})
    on conflict (user_id) do update set handle = excluded.handle, title = excluded.title, description = excluded.description,
      link_ids = excluded.link_ids, updated_at = excluded.updated_at
    returning handle, title, description, link_ids::text[] as link_ids`;
  return { page };
}
