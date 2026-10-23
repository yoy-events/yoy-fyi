import type { SQL } from "bun";

// Runs `job` only if no other run of the same job holds its advisory lock. Session locks
// need one connection for lock and unlock, hence the reserved connection.
export async function exclusive(sql: SQL, name: string, job: () => Promise<unknown>): Promise<boolean> {
  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn`select pg_try_advisory_lock(hashtext(${name})) as locked`;
    if (!locked) return false;
    try {
      await job();
      return true;
    } finally {
      await conn`select pg_advisory_unlock(hashtext(${name}))`;
    }
  } finally {
    conn.release();
  }
}

// Runs a job now and then every `ms`, logging failures instead of crashing the server.
export function every(sql: SQL, name: string, ms: number, job: () => Promise<unknown>): void {
  const run = () => exclusive(sql, name, job).catch((err) => console.error(`${name} failed`, String(err)));
  run();
  setInterval(run, ms);
}
