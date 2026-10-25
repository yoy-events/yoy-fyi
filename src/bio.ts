// Link-in-bio pages (yoy.fyi/@handle): one per user, shared by the web form and the MCP tools.
import type { SQL } from "bun";
import { isUuid } from "./http";

export const HANDLE = /^[a-z0-9][a-z0-9_.-]{2,29}$/;
const RESERVED_HANDLES = new Set(["admin", "yoy", "yoyfyi", "support", "help", "api", "root", "account", "login"]);
export const MAX_BIO_LINKS = 30;

export type BioInput = { handle: string; title: string; description: string; link: string[] };
export type BioPage = { handle: string; title: string | null; description: string | null; link_ids: string[] };

export async function getBio(sql: SQL, userId: string): Promise<BioPage | null> {
  const [page] = await sql`select handle, title, description, link_ids::text[] as link_ids from bio_pages where user_id = ${userId}`;
  return page ?? null;
}

// Validates and saves; the errors name the field in brackets so both the form and an agent can act on them.
export async function saveBio(
  sql: SQL,
  { userId, serviceId, publicOrigin, now }: { userId: string; serviceId: string; publicOrigin: string; now: Date },
  input: BioInput,
): Promise<{ errors: string[] } | { page: BioPage }> {
  const v = { ...input, handle: input.handle.trim().toLowerCase(), title: input.title.trim(), description: input.description.trim() };
  const errors: string[] = [];
  if (!HANDLE.test(v.handle)) errors.push("Адреса (handle): 3–30 символів a-z 0-9 _ . -, починається з літери чи цифри.");
  if (v.title.length > 100) errors.push("Заголовок (title): не більше 100 символів.");
  if (v.description.length > 300) errors.push("Опис (description): не більше 300 символів.");
  if (v.link.length > MAX_BIO_LINKS) errors.push(`Не більше ${MAX_BIO_LINKS} посилань.`);
  else if (v.link.length) {
    const own = v.link.every(isUuid) ? await sql`select id from links where service_id = ${serviceId} and id in ${sql(v.link)}` : [];
    if (own.length !== new Set(v.link).size) errors.push("Обирайте лише свої посилання (link_ids).");
  }
  if (!errors.length && RESERVED_HANDLES.has(v.handle)) errors.push(`${publicOrigin}/@${v.handle} уже зайнята (taken).`);
  if (!errors.length) {
    const [taken] = await sql`select 1 from bio_pages where handle = ${v.handle} and user_id <> ${userId}`;
    if (taken) errors.push(`${publicOrigin}/@${v.handle} уже зайнята (taken).`);
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
