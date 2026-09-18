import { RequestError } from "./api";
import db, { assertInTransaction, retainTransactionLock } from "./db";

async function advisoryLock(key: string, shared: boolean): Promise<void> {
  assertInTransaction();
  const result = await db.one<{ acquired: boolean }>(
    `SELECT ${shared ? "pg_try_advisory_xact_lock_shared" : "pg_try_advisory_xact_lock"}(hashtextextended($1, 0)) AS acquired`,
    [key]
  );
  if (!result?.acquired) {
    throw new RequestError("Another operation is updating this dataset or item. Please retry in a moment.", 409);
  }
  await retainTransactionLock(key, shared);
}

export async function lockDataKey(key: string): Promise<void> {
  await advisoryLock(`dispatch:key:${key}`, false);
}

export async function withDataLock<T>(
  action: () => Promise<T>,
  options: { keys?: string[]; sharedKeys?: string[]; drivers?: "shared" | "exclusive" } = {}
): Promise<T> {
  return db.transaction(async () => {
    await db.query("SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', '30s', true)");
    await advisoryLock("dispatch:dataset", true);
    await advisoryLock("dispatch:drivers", options.drivers !== "exclusive");
    for (const key of Array.from(new Set(options.keys ?? [])).sort()) await lockDataKey(key);
    for (const key of Array.from(new Set(options.sharedKeys ?? [])).sort()) {
      if (!options.keys?.includes(key)) await advisoryLock(`dispatch:key:${key}`, true);
    }
    return db.transaction(async () => {
      const result = await action();
      await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      return result;
    });
  });
}
