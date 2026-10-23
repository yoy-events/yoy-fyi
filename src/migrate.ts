import type { SQL } from "bun";

const dir = new URL("../migrations/", import.meta.url).pathname;

export async function migrate(sql: SQL): Promise<void> {
  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('yoy-fyi:migrate'))`;
    const applied = new Set((await tx`select name from schema_migrations`).map((r: { name: string }) => r.name));
    const files = Array.from(new Bun.Glob("*.sql").scanSync(dir)).sort();
    for (const name of files) {
      if (applied.has(name)) continue;
      await tx.unsafe(await Bun.file(dir + name).text());
      await tx`insert into schema_migrations (name) values (${name})`;
    }
  });
}
