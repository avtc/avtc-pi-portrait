// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getCollectLockPath, getLockPath } from "../src/config.js";
import { type SqliteMutex, tryAcquireSqliteMutex } from "../src/snippets/vendored/sqlite-mutex.js";

// Mutual-exclusion tests use TEMP lock DBs (not the real ~/.pi/portrait/ paths) so they
// never contend with a live portrait instance that may be holding the real instance lock.
function tmpLockDb(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portrait-lock-"));
  return path.join(dir, name);
}

/** Assert a tryAcquire result is non-null and narrow its type (avoids `!` assertions). */
function must(mutex: SqliteMutex | null): SqliteMutex {
  if (!mutex) throw new Error("expected tryAcquire to return a mutex, got null");
  return mutex;
}

describe("lock paths (SQLite mutex)", () => {
  it("collect lock path ends with collect.lock.sqlite", () => {
    expect(getCollectLockPath().endsWith("collect.lock.sqlite")).toBe(true);
  });

  it("instance lock path ends with instance.lock.sqlite", () => {
    expect(getLockPath().endsWith("instance.lock.sqlite")).toBe(true);
  });

  it("collect and instance locks are distinct files (different keys)", () => {
    expect(getCollectLockPath()).not.toBe(getLockPath());
  });
});

describe("collect lock mutual exclusion", () => {
  it("a held collect lock blocks a second acquire (tryAcquire returns null)", async () => {
    // tryAcquireSqliteMutex is the primitive acquireCollectLock uses. Two tryAcquires on the
    // SAME path: first wins, second gets null. On DIFFERENT paths: both win (independent).
    const lock = tmpLockDb("collect.lock.sqlite");
    const a = must(await tryAcquireSqliteMutex(lock));
    try {
      const b = await tryAcquireSqliteMutex(lock);
      expect(b).toBeNull(); // contended — the whole point of the collect lock
    } finally {
      a.release();
    }
    // after release, a fresh acquire wins
    must(await tryAcquireSqliteMutex(lock)).release();
  });

  it("the collect lock and instance lock are independent (no cross-blocking)", async () => {
    const inst = must(await tryAcquireSqliteMutex(tmpLockDb("instance.lock.sqlite")));
    try {
      const coll = must(await tryAcquireSqliteMutex(tmpLockDb("collect.lock.sqlite")));
      expect(coll).toBeDefined(); // different DB → independent
      coll.release();
    } finally {
      inst.release();
    }
  });
});
