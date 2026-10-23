import { beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { exclusive } from "../src/jobs";
import { testDb } from "./helpers";

let sql: SQL;

beforeAll(async () => {
  sql = await testDb();
});

test("runs the job and reports true", async () => {
  let ran = false;

  expect(await exclusive(sql, "job-a", async () => void (ran = true))).toBe(true);
  expect(ran).toBe(true);
});

test("skips a run while another holds the same job's lock", async () => {
  let release!: () => void;
  const first = exclusive(sql, "job-b", () => new Promise<void>((r) => (release = r)));
  await Bun.sleep(50);

  const second = await exclusive(sql, "job-b", async () => {
    throw new Error("must not run");
  });

  expect(second).toBe(false);
  release();
  expect(await first).toBe(true);
});

test("releases the lock when the job throws", async () => {
  await expect(exclusive(sql, "job-c", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

  expect(await exclusive(sql, "job-c", async () => {})).toBe(true);
});
