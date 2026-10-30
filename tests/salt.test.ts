// The daily salt for visitor hashes: one per UTC day, shared through the database.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createSaltSource } from "../src/salt";
import { reset, testDb } from "./helpers";

let sql: SQL;
const NOW = new Date("2026-10-24T00:00:01Z");

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
});

test("creates the day's salt once and returns it again", async () => {
  const first = await createSaltSource(sql)(NOW);
  const again = await createSaltSource(sql)(NOW);

  expect(first).toHaveLength(32);
  expect(again).toEqual(first);
  expect(await sql`select 1 from daily_salts`).toHaveLength(1);
});

test("a different day gets a different salt", async () => {
  const source = createSaltSource(sql);
  const day1 = await source(NOW);
  const day2 = await source(new Date("2026-10-25T00:00:01Z"));

  expect(day2).not.toEqual(day1);
});

// Just after midnight several clicks ask for the new salt at once. One that waits on another's
// uncommitted insert used to find no row (its snapshot predates the commit) and lose the click.
test("waiting on a concurrent insert of the same day returns that salt", async () => {
  const theirs = new Uint8Array(32).fill(7);
  let mine: Promise<Uint8Array> | undefined;
  await sql.begin(async (tx) => {
    await tx`insert into daily_salts (day, salt) values ('2026-10-24', ${theirs})`;
    mine = createSaltSource(sql)(NOW);
    await Bun.sleep(200);
  });

  expect(await mine!).toEqual(theirs);
});
