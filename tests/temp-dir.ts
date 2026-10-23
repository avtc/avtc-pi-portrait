// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Temp dirs for tests, swept automatically after each test FILE.
 *
 * `tempDir(prefix)` is `mkdtempSync(join(tmpdir(), "<prefix>-"))` plus
 * registration; the sweep is registered once in tests/setup.ts's afterAll,
 * so every dir handed out in a file is removed when that file ends — no
 * leftover dirs accumulating in the OS temp folder across suite runs
 * (the sibling-repo convention — avtc-pi-bench-compact tests/temp-dirs.ts,
 * avtc-pi-session-owl tests/temp-dir.ts).
 *
 * The sweep is best-effort: a Windows lock that survives force + retries
 * is dropped, not failed — a leftover under %TEMP% (the OS's to reclaim)
 * beats a red suite over litter.
 *
 * Tests use `tempDir()` instead of calling mkdtemp directly; the
 * no-raw-tmpdir lint (in npm test) keeps new suites on the helper so
 * untracked dirs cannot start accumulating again.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

/** A fresh tracked dir under tmpdir(): `tempDir("portrait-lock")` → `.../portrait-lock-x7Qd2Z/`. */
export function tempDir(prefix: string): string {
  const normalized = prefix.endsWith("-") ? prefix : `${prefix}-`;
  const dir = mkdtempSync(join(tmpdir(), normalized));
  dirs.push(dir);
  return dir;
}

/** Remove every dir handed out so far. Registered per test file by tests/setup.ts. */
export function sweepTempDirs(): void {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // still locked after the retries — leave it; see header
    }
  }
}
