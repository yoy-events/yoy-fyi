// scripts/backup.sh with fake pg_dump and rclone on the PATH: what it uploads, when it refuses to,
// and that it does nothing without a bucket.
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/backup.sh", import.meta.url).pathname;
let dir: string;

const fake = (name: string, body: string) => {
  writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
};

beforeEach(() => {
  rmSync(dir ?? "/nonexistent", { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "backup-"));
  mkdirSync(join(dir, "bin"));
  // A dump big enough to pass the size check.
  fake("pg_dump", `head -c 4000 /dev/urandom | base64`);
  fake("rclone", `echo "$@" >> "${dir}/rclone.log"; if [ "$1" = copyto ]; then cp "$2" "${dir}/uploaded.gz"; fi`);
});

const run = async (env: Record<string, string>) => {
  const proc = Bun.spawn(["bash", SCRIPT], {
    env: { PATH: `${dir}/bin:${process.env.PATH}`, BACKUP_ONCE: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return { code, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
};
const R2 = { R2_BUCKET: "bk", R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" };
const rcloneLog = () => readFileSync(join(dir, "rclone.log"), "utf8");

describe("backup.sh", () => {
  test("uploads one gzip per UTC day to the bucket and prunes old files", async () => {
    const r = await run(R2);
    expect(r.code).toBe(0);
    const day = new Date().toISOString().slice(0, 10);
    expect(rcloneLog()).toContain(`r2:bk/yoy_fyi-${day}.sql.gz`);
    expect(rcloneLog()).toContain("delete r2:bk --min-age 30d --include yoy_fyi-*.sql.gz");
    expect(r.out).toContain(`uploaded yoy_fyi-${day}.sql.gz`);
    const gunzip = Bun.spawnSync(["gzip", "-t", join(dir, "uploaded.gz")]);
    expect(gunzip.exitCode).toBe(0);
  });

  test("BACKUP_KEEP_DAYS changes the retention", async () => {
    await run({ ...R2, BACKUP_KEEP_DAYS: "7" });
    expect(rcloneLog()).toContain("--min-age 7d");
  });

  test("without R2_BUCKET it only says backups are off", async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.out).toContain("backups are off");
    expect(() => rcloneLog()).toThrow();
  });

  test.each(["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])("a bucket without %s fails before dumping", async (missing) => {
    const env = { ...R2 } as Record<string, string>;
    delete env[missing];
    expect((await run(env)).code).not.toBe(0);
    expect(() => rcloneLog()).toThrow();
  });

  test("a failed pg_dump uploads nothing", async () => {
    fake("pg_dump", `echo partial; exit 1`);
    expect((await run(R2)).code).not.toBe(0);
    expect(() => rcloneLog()).toThrow();
  });

  test("a tiny dump is not uploaded", async () => {
    fake("pg_dump", `echo "-- empty"`);
    const r = await run(R2);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("suspiciously small");
    expect(() => rcloneLog()).toThrow();
  });

  test("a failed upload does not prune", async () => {
    fake("rclone", `echo "$@" >> "${dir}/rclone.log"; [ "$1" = copyto ] && exit 1; exit 0`);
    expect((await run(R2)).code).not.toBe(0);
    expect(rcloneLog()).not.toContain("delete");
  });
});
