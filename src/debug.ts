// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Debug dump helpers for the portrait pipeline.
 *
 * One timestamped file per call under <portraitDir>/debug/, pruned to the last N.
 * Gated by the `debugDumpLimit` setting (0 = disabled, default). Writes are synchronous
 * (appendFileSync) so output is flushed to disk immediately — nothing is lost if the
 * process dies mid-generation.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEBUG_DIR_NAME = "debug";

/** Monotonic counter for same-millisecond dump ordering (deterministic prune order).
 * Zero-padded so filename sort = creation order within a process. */
let dumpCounter = 0;

/** Ensure <portraitDir>/debug exists and return its path. */
function ensureDebugDir(portraitDir: string): string {
  const dir = path.join(portraitDir, DEBUG_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a new timestamped debug dump file `<prefix>-<timestamp>.txt` in the debug dir,
 * prune older files with the same prefix to keep at most `limit`, and return the new path.
 * The file is not created here — the first appendDebug call creates it.
 * Returns `null` when `limit <= 0` (debug dumps disabled) — no dir is created, nothing pruned,
 * and callers' appendDebug calls become no-ops.
 */
export function openDebugDump(portraitDir: string, prefix: string, limit: number): string | null {
  if (limit <= 0) return null; // debug dumps disabled (debugDumpLimit = 0)
  const dir = ensureDebugDir(portraitDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Filename = <prefix>-<isoTs>-<paddedCounter>-<nonce>.txt:
  //  - isoTs: ms-resolution, human-readable, primary chronological sort key
  //  - paddedCounter: process-monotonic, zero-padded → deterministic order for same-ms files
  //    (fixes the mtime-tie flakiness: pruning sorts by filename, not mtime)
  //  - nonce: short random → cross-process/restart collision safety (collect lock serializes
  //    real dumping, so this is belt-and-suspenders)
  const seq = dumpCounter++;
  const nonce = Math.random().toString(16).slice(2, 8);
  const dumpPath = path.join(dir, `${prefix}-${timestamp}-${seq.toString().padStart(6, "0")}-${nonce}.txt`);
  // Prune oldest first by sorting on filename: isoTs is chronological, and the padded
  // counter breaks same-ms ties deterministically (unlike mtime, which is also ms-resolution
  // and made the oldest pick non-deterministic in a tight loop).
  const existing = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".txt"))
    .sort()
    .map((f) => path.join(dir, f));
  while (existing.length >= limit) {
    const oldest = existing.shift();
    if (!oldest) break;
    try {
      fs.unlinkSync(oldest);
    } catch {
      /* best-effort */
    }
  }
  return dumpPath;
}

/** Append content to a debug dump file (synchronously flushed). Never throws.
 * No-op when `dumpPath` is null/falsy (debug dumps disabled) — call sites can pass the
 * openDebugDump result through unconditionally. */
export function appendDebug(dumpPath: string | null, content: string): void {
  if (!dumpPath) return; // disabled — no-op
  try {
    fs.appendFileSync(dumpPath, content);
  } catch {
    // best-effort — logging must not break the pipeline
  }
}
