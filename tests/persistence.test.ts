// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PORTRAIT_CACHE_TYPE, persistCacheSnapshot, restoreCacheSnapshot } from "../src/persistence.js";

// --- fake pi: captures appendEntry calls; a variant omits appendEntry (contract violation) ---

function fakePi(capture: Array<{ customType: string; data?: unknown }>): ExtensionAPI {
  return {
    appendEntry<T = unknown>(customType: string, data?: T) {
      capture.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
}

function fakePiNoAppendEntry(): ExtensionAPI {
  // Deliberately missing appendEntry — exercises the fail-loud contract check.
  return {} as unknown as ExtensionAPI;
}

// --- fake ctx: getBranch returns a seeded branch ---

function ctxWithBranch(branch: unknown[]): ExtensionContext {
  return {
    sessionManager: {
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
}

function ctxWithGetBranchThrowing(): ExtensionContext {
  return {
    sessionManager: {
      getBranch: () => {
        throw new Error("corrupt session (simulated I/O)");
      },
    },
  } as unknown as ExtensionContext;
}

function ctxNoSessionManager(): ExtensionContext {
  // Deliberately missing sessionManager.getBranch — exercises fail-loud.
  return { sessionManager: {} } as unknown as ExtensionContext;
}

function entry(customType: string, content: unknown): { type: string; customType: string; data: unknown } {
  return { type: "custom", customType, data: { content } };
}

describe("persistCacheSnapshot (portrait-cache)", () => {
  it("undefined/empty cache → no append (early return)", () => {
    const captured: Array<{ customType: string; data?: unknown }> = [];
    persistCacheSnapshot(fakePi(captured), undefined);
    persistCacheSnapshot(fakePi(captured), "");
    expect(captured).toHaveLength(0);
  });

  it("valid string → appends one 'portrait-cache' entry with { content }", () => {
    const captured: Array<{ customType: string; data?: unknown }> = [];
    persistCacheSnapshot(fakePi(captured), "## Portrait\n- trait A");
    expect(captured).toHaveLength(1);
    expect(captured[0].customType).toBe(PORTRAIT_CACHE_TYPE);
    expect(captured[0].data).toEqual({ content: "## Portrait\n- trait A" });
  });

  it("appendEntry throws (environmental) → swallowed, does NOT throw to caller (degrade gracefully)", () => {
    const pi = {
      appendEntry: () => {
        throw new Error("disk full (simulated)");
      },
    } as unknown as ExtensionAPI;
    // Behavioral assertion only (isolate:false — no vi.mock logger spy per convention).
    expect(() => persistCacheSnapshot(pi, "x")).not.toThrow();
  });

  it("pi missing appendEntry (programming error /) → THROWS (fail loud, not swallowed)", () => {
    expect(() => persistCacheSnapshot(fakePiNoAppendEntry(), "x")).toThrow(/appendEntry unavailable/);
  });
});

describe("restoreCacheSnapshot (portrait-cache)", () => {
  it("branch with a matching entry → returns { content }", () => {
    const ctx = ctxWithBranch([entry("portrait-cache", "snapshot-A")]);
    expect(restoreCacheSnapshot(ctx)).toEqual({ content: "snapshot-A" });
  });

  it("multiple matching entries → returns the LATEST (last in array, reverse-walk)", () => {
    const ctx = ctxWithBranch([entry("portrait-cache", "old"), entry("portrait-cache", "new")]);
    expect(restoreCacheSnapshot(ctx)).toEqual({ content: "new" });
  });

  it("matching entry but empty/non-string content → returns undefined (malformed → fallback)", () => {
    expect(restoreCacheSnapshot(ctxWithBranch([entry("portrait-cache", "")]))).toBeUndefined();
    expect(restoreCacheSnapshot(ctxWithBranch([entry("portrait-cache", 42)]))).toBeUndefined();
    expect(restoreCacheSnapshot(ctxWithBranch([entry("portrait-cache", null)]))).toBeUndefined();
  });

  it("matching customType but data.content missing entirely → returns undefined", () => {
    const ctx = ctxWithBranch([{ type: "custom", customType: "portrait-cache", data: {} }]);
    expect(restoreCacheSnapshot(ctx)).toBeUndefined();
  });

  it("matching customType but data itself is undefined → returns undefined (no TypeError)", () => {
    const ctx = ctxWithBranch([{ type: "custom", customType: "portrait-cache", data: undefined }]);
    expect(() => restoreCacheSnapshot(ctx)).not.toThrow();
    expect(restoreCacheSnapshot(ctx)).toBeUndefined();
  });

  it("non-matching customType entries → returns undefined", () => {
    const ctx = ctxWithBranch([entry("user-decisions-cache", "not mine"), entry("pi_todo", { items: [] })]);
    expect(restoreCacheSnapshot(ctx)).toBeUndefined();
  });

  it("realistic branch shape [snapshot, newer-non-matching entries] → returns the snapshot (reverse-walk skips newer non-matches)", () => {
    // createBranchedSession copies the full root→leaf path; the snapshot is appended at a refresh site
    // and is followed by newer message/tool_result entries. The reverse-walk must skip those newer
    // non-matching entries and still return the snapshot.
    const message = { type: "message", message: { role: "user", content: "hi" } };
    const toolResult = { type: "tool_result", tool: "x" };
    const ctx = ctxWithBranch([entry("portrait-cache", "SNAPSHOT-BYTES"), message, toolResult, message]);
    expect(restoreCacheSnapshot(ctx)).toEqual({ content: "SNAPSHOT-BYTES" });
  });

  it("[valid-old, malformed-new] → returns undefined; does NOT fall back to the older valid entry (guards)", () => {
    //  (known-issue): restore returns undefined IMMEDIATELY when the LATEST matching entry is
    // malformed (does NOT continue the reverse-walk to an older valid entry). This test guards that
    // intentional behavior — a refactor changing `return undefined` → `continue` must fail it.
    const validOld = entry("portrait-cache", "older-valid-snapshot");
    const malformedNew = { type: "custom", customType: "portrait-cache", data: { content: 42 } }; // newer, malformed content
    expect(restoreCacheSnapshot(ctxWithBranch([validOld, malformedNew]))).toBeUndefined();
  });

  it("empty branch → returns undefined", () => {
    expect(restoreCacheSnapshot(ctxWithBranch([]))).toBeUndefined();
  });

  it("getBranch throws (environmental) → returns undefined, does not throw (degrade to file read)", () => {
    const ctx = ctxWithGetBranchThrowing();
    expect(() => restoreCacheSnapshot(ctx)).not.toThrow();
    expect(restoreCacheSnapshot(ctx)).toBeUndefined();
  });

  it("ctx.sessionManager missing getBranch (programming error /) → THROWS (fail loud)", () => {
    expect(() => restoreCacheSnapshot(ctxNoSessionManager())).toThrow(/getBranch unavailable/);
  });
});
