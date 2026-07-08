// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * SQLite cross-process mutex — drop-in vendored snippet.
 *
 * A tiny `.lock.sqlite` DB used purely as a cross-process mutex sentinel (no data in it).
 * `acquire` = `BEGIN IMMEDIATE` (SQLite's reserved→exclusive write lock; exactly one
 * holder process-wide, correct on every platform). `release` = `ROLLBACK` + close. On
 * process death, SQLite hot-journal recovery rolls the open transaction back → the lock
 * auto-releases — no reclaim step, no heartbeat, no staleness, no race.
 *
 * Two acquire modes, both async:
 * - `acquireSqliteMutex(path, signal)` — BLOCKING (busy-retry until obtained or aborted).
 *   Use for critical sections that must complete (e.g. a read-modify-write under the lock).
 * - `tryAcquireSqliteMutex(path)` — NON-BLOCKING (resolves within a microtask: mutex if
 *   free, `null` if contended). Use for "skip if busy" patterns (e.g. a profiling cycle
 *   that should skip when another is already running).
 *
 * `node:sqlite` ships a synchronous `DatabaseSync` only. The blocking acquire uses a short
 * `busy_timeout` + an async retry loop that yields (`await sleep`) between attempts and
 * checks an optional `AbortSignal` so a waiting acquire can be cancelled (e.g. on
 * `session_shutdown`). The non-blocking try uses `busy_timeout = 0` so `BEGIN IMMEDIATE`
 * throws BUSY immediately on contention (no retry, no waiting).
 *
 * Copy this file into your extension's src/snippets/vendored/ directory, byte-for-byte
 * identical across repos. Do NOT add repo-specific imports/types — keep it copyable.
 */

import { DatabaseSync } from "node:sqlite";

/** A held mutex — call `release()` (idempotent) when done. */
export interface SqliteMutex {
  release: () => void;
}

const DEFAULT_BUSY_TIMEOUT_MS = 75;
const RETRY_DELAY_MS = 50;

function isBusy(e: unknown): boolean {
  // node:sqlite throws with code="ERR_SQLITE_ERROR" and a numeric `errcode` = the raw SQLite
  // result code. SQLITE_BUSY = 5 (another connection holds a lock that blocks us);
  // SQLITE_LOCKED = 6 (a lock conflict within the same connection). Both are retryable.
  const err = e as { code?: string; errcode?: number } | null;
  return err?.code === "ERR_SQLITE_ERROR" && (err.errcode === 5 || err.errcode === 6);
}

/** Build the idempotent release closure around an already-locked connection (shared by both acquires). */
function makeMutex(db: DatabaseSync): SqliteMutex {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        db.exec("ROLLBACK");
      } catch {
        // transaction may already be rolled back (e.g. process crash mid-hold); safe to ignore
      }
      db.close();
    },
  };
}

function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("sqlite-mutex: acquire aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Acquire the cross-process mutex at `lockDbPath`, BLOCKING (busy-retry) until obtained or
 * `signal` aborts. The caller MUST call the returned `release()` exactly once (wrap in
 * try/finally). Throws if aborted, or on a non-busy SQLite error.
 */
export async function acquireSqliteMutex(lockDbPath: string, signal: AbortSignal | null): Promise<SqliteMutex> {
  const db = new DatabaseSync(lockDbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) throw new Error("sqlite-mutex: acquire aborted");
      try {
        db.exec("BEGIN IMMEDIATE");
        break; // acquired the write lock
      } catch (e) {
        if (!isBusy(e)) throw e; // unexpected error — propagate (db closed in finally)
        await sleep(RETRY_DELAY_MS, signal); // busy → yield + retry (may reject on abort)
      }
    }
  } catch (e) {
    db.close();
    throw e;
  }
  return makeMutex(db);
}

/**
 * Try to acquire the cross-process mutex at `lockDbPath`, NON-BLOCKING. Resolves within a
 * microtask: the mutex if it was free, or `null` if contended (another process holds it).
 * Never throws on contention (only on a genuinely unexpected error). Use for "skip if busy"
 * patterns. The caller MUST call `release()` exactly once on a non-null result (try/finally).
 */
export async function tryAcquireSqliteMutex(lockDbPath: string): Promise<SqliteMutex | null> {
  const db = new DatabaseSync(lockDbPath);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    db.close();
    if (isBusy(e)) return null; // contended — non-blocking try returns null
    throw e; // unexpected error — propagate
  }
  return makeMutex(db);
}
