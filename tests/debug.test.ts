// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDebug, openDebugDump } from "../src/debug.js";

/** Max debug files to keep (limit=1 prunes all but newest) */
const DEBUG_LIMIT_1 = 1;

let dir: string;

function tmpDir(): string {
  const d = path.join(os.tmpdir(), `portrait-debug-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("debug dump helpers", () => {
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("openDebugDump creates the debug dir and returns a timestamped path", () => {
    const p = openDebugDump(dir, "maintenance", 20) as string;
    expect(p).toContain(path.join("debug", "maintenance-"));
    expect(p).toMatch(/maintenance-\d{4}-\d{2}-\d{2}T.+\.txt$/);
    expect(fs.existsSync(path.join(dir, "debug"))).toBe(true);
  });

  it("appendDebug creates the file and flushes content synchronously", () => {
    const p = openDebugDump(dir, "maintenance", 20) as string;
    appendDebug(p, "=== Input ===\nhello\n");
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toBe("=== Input ===\nhello\n");
  });

  it("appendDebug appends across multiple calls", () => {
    const p = openDebugDump(dir, "maintenance", 20) as string;
    appendDebug(p, "a");
    appendDebug(p, "b");
    appendDebug(p, "c");
    expect(fs.readFileSync(p, "utf-8")).toBe("abc");
  });

  it("prunes oldest files to stay within the limit (per prefix)", () => {
    const paths: string[] = [];
    // Create 3 files with slightly increasing timestamps by writing immediately
    for (let i = 0; i < 3; i++) {
      const p = openDebugDump(dir, "maintenance", 2) as string;
      appendDebug(p, `file ${i}`);
      paths.push(p);
    }
    const files = fs.readdirSync(path.join(dir, "debug")).filter((f) => f.startsWith("maintenance-"));
    // limit=2 → only the 2 newest survive
    expect(files.length).toBe(2);
    // Oldest (first created) was pruned
    expect(fs.existsSync(paths[0])).toBe(false);
    expect(fs.existsSync(paths[1])).toBe(true);
    expect(fs.existsSync(paths[2])).toBe(true);
  });

  it("prunes per-prefix (maintenance and backfill tracked separately)", () => {
    for (let i = 0; i < 3; i++) {
      appendDebug(openDebugDump(dir, "maintenance", DEBUG_LIMIT_1), "m");
      appendDebug(openDebugDump(dir, "backfill", 5), "b");
    }
    const files = fs.readdirSync(path.join(dir, "debug"));
    const maint = files.filter((f) => f.startsWith("maintenance-"));
    const back = files.filter((f) => f.startsWith("backfill-"));
    expect(maint.length).toBe(1); // limit 1
    expect(back.length).toBe(3); // limit 5, only 3 created
  });

  it("appendDebug never throws on a bad path", () => {
    expect(() => appendDebug(path.join(dir, "nope", "deep", "x.txt"), "data")).not.toThrow();
  });

  it("openDebugDump returns null and creates no dir when limit <= 0 (dumps disabled)", () => {
    expect(openDebugDump(dir, "maintenance", 0)).toBeNull();
    expect(openDebugDump(dir, "maintenance", -1)).toBeNull();
    expect(fs.existsSync(path.join(dir, "debug"))).toBe(false);
  });

  it("appendDebug is a no-op on a null dumpPath (dumps disabled)", () => {
    appendDebug(null, "should be ignored");
    expect(fs.existsSync(path.join(dir, "debug"))).toBe(false);
  });
});
