import type { SQL } from "bun";

// One random salt per UTC day, shared through the database so restarts keep the same
// day's hashes. Creating a day's salt deletes everything older than yesterday.
export function createSaltSource(sql: SQL) {
  let cached: { day: string; salt: Uint8Array } | undefined;

  return async (now: Date): Promise<Uint8Array> => {
    const day = now.toISOString().slice(0, 10);
    if (cached?.day === day) return cached.salt;

    const fresh = crypto.getRandomValues(new Uint8Array(32));
    const [row] = await sql`
      with inserted as (
        insert into daily_salts (day, salt) values (${day}, ${fresh})
        on conflict (day) do nothing
        returning salt
      )
      select salt from inserted
      union all
      select salt from daily_salts where day = ${day}
      limit 1`;
    await sql`delete from daily_salts where day < ${day}::date - 1`;
    cached = { day, salt: new Uint8Array(row.salt) };
    return cached.salt;
  };
}

export function visitorHash(salt: Uint8Array, ip: string, userAgent: string): string {
  return new Bun.CryptoHasher("sha256").update(salt).update(`${ip}\n${userAgent}`).digest("hex");
}
