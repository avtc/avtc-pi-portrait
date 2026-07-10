// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Idempotent wiring guard: portrait can be bundled into the avtc-pi umbrella AND installed
 * standalone — whichever copy loads first wires, the rest no-op. Driven by a globalThis flag
 * (`__avtcPiPortraitWired`). vitest runs with isolate:false (shared globalThis), so the flag
 * is deleted in beforeEach+afterEach to keep each case independent and avoid leaking into other
 * test files that boot the extension.
 *
 * The mock-pi shape + module mocks (config/settings-ui/sqlite-mutex) mirror cache-refresh.test.ts
 * so the first call wires against a temp dir without throwing.
 *
 * PERFORMANCE: the 4 tests only exercise the globalThis wiring guard and the registered handlers
 * — they do NOT need a freshly-re-evaluated module graph per test. Importing the (mocked) extension
 * ONCE in beforeAll and sharing it across tests avoids ~4 full graph evaluations
 * (maintenance-core → builder → llm-call → collector …), cutting this file from ~3.3s to ~1s.
 */

// Mutable holder the config mock reads from. Hoisted so vi.doMock's factory can close over it.
const holder = vi.hoisted(() => ({ portraitDir: "" }));

describe("extension entry idempotent wiring guard", () => {
  // Shared, mocked extension module — imported once in beforeAll (see below).
  let mod: typeof import("../src/index.js");
  let tempHome: string;

  beforeAll(async () => {
    // Ensure a clean wiring flag before the first import (isolate:false shares globalThis).
    delete (globalThis as { __avtcPiPortraitWired?: boolean }).__avtcPiPortraitWired;

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "portrait-idem-"));
    holder.portraitDir = path.join(tempHome, "portrait");
    fs.mkdirSync(holder.portraitDir, { recursive: true });
    fs.writeFileSync(path.join(holder.portraitDir, "portrait.md"), "## Portrait");
    // Pause the pipeline so session_start (if a handler were driven) does not schedule a timer.
    fs.writeFileSync(path.join(holder.portraitDir, "portrait-state.json"), '{"paused":true}');

    // Mock config/settings-ui/sqlite BEFORE importing so the graph is evaluated against the mocks.
    vi.resetModules();
    vi.doMock("../src/config.js", async (importOriginal) => {
      const orig = await importOriginal<typeof import("../src/config.js")>();
      return {
        ...orig,
        getPortraitDir: () => holder.portraitDir,
        getLockPath: () => path.join(holder.portraitDir, "instance.lock.sqlite"),
        getCollectLockPath: () => path.join(holder.portraitDir, "collect.lock.sqlite"),
      };
    });
    // Mock settings-ui so the extension reads schema-derived defaults (enabled) with no real
    // settings file and no command registration on the fake pi.
    vi.doMock("../src/settings-ui.js", async () => {
      const { PORTRAIT_SCHEMA } = await import("../src/schema.js");
      const defaults = Object.fromEntries(PORTRAIT_SCHEMA.settings.map((s) => [s.id, s.defaultValue]));
      return {
        initPortraitSettings: () => {},
        getPortraitSettings: () => ({ ...defaults, enabled: true }),
      };
    });
    // Mock the mutex to report contention so no SQLite handle is held open (which would block
    // Windows from deleting the temp dir in afterEach). startLockPoll's interval is cleared via
    // clearAllTimers in afterEach.
    vi.doMock("../src/snippets/vendored/sqlite-mutex.js", () => ({
      tryAcquireSqliteMutex: async () => null,
    }));

    mod = await import("../src/index.js");
  });

  beforeEach(() => {
    // Ensure a clean wiring flag for every case (vitest isolate:false shares globalThis).
    delete (globalThis as { __avtcPiPortraitWired?: boolean }).__avtcPiPortraitWired;
  });

  afterEach(() => {
    // Kill initFooter's status interval + any startLockPoll interval via the shared module.
    try {
      mod.clearAllTimers();
    } catch {
      // ignore — module graph may already be torn down
    }
    // Clear the wiring flag so it does not leak into other test files (isolate:false).
    delete (globalThis as { __avtcPiPortraitWired?: boolean }).__avtcPiPortraitWired;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /**
   * Minimal mock pi capturing pi.on handlers (same shape as cache-refresh.test.ts). Handlers
   * accumulate per event into an array, mirroring real pi's `list.push(handler)` (see
   * dist/core/extensions/loader.js) so multiple handlers for the same event all fire.
   */
  function makeMockPi(): {
    pi: ExtensionAPI;
    handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
  } {
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const pi = {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerCommand() {},
      appendEntry() {},
    } as unknown as ExtensionAPI;
    return { pi, handlers };
  }

  it("wires on the first call without throwing", () => {
    const { pi, handlers } = makeMockPi();
    expect(() => mod.default(pi)).not.toThrow();
    // Wiring registers the expected event handlers — proves the body actually ran.
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  it("no-ops on the second call without throwing and does not re-register", () => {
    // First call wires normally and registers handlers on its own pi.
    const { pi: firstPi, handlers: firstHandlers } = makeMockPi();
    mod.default(firstPi);
    expect(firstHandlers.has("session_start")).toBe(true);

    // Second call no-ops: a fresh pi must NOT receive any handlers (the body returned early).
    const { pi: secondPi, handlers: secondHandlers } = makeMockPi();
    expect(() => mod.default(secondPi)).not.toThrow();
    expect(secondHandlers.has("session_start")).toBe(false);
    expect(secondHandlers.has("session_shutdown")).toBe(false);
    expect(secondHandlers.size).toBe(0);
  });

  it("sets the globalThis wiring flag on first call", () => {
    const { pi } = makeMockPi();
    expect((globalThis as { __avtcPiPortraitWired?: boolean }).__avtcPiPortraitWired).toBeUndefined();
    mod.default(pi);
    expect((globalThis as { __avtcPiPortraitWired?: boolean }).__avtcPiPortraitWired).toBe(true);
  });

  it("resets the wiring flag on session_shutdown so /reload re-wires", async () => {
    // pi re-evaluates extension modules fresh on /reload (jiti moduleCache:false) but globalThis
    // persists. An un-reset guard flag short-circuits re-wiring, leaving the extension dead after
    // /reload. A session_shutdown handler must reset the flag so the next entry call re-wires.
    const g = globalThis as { __avtcPiPortraitWired?: boolean };

    // 1. Call entry once — wires and sets the flag.
    const { pi, handlers } = makeMockPi();
    mod.default(pi);
    expect(g.__avtcPiPortraitWired).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);

    // 2. Call entry again — no-op (flag still true); a fresh pi receives no handlers.
    const { pi: secondPi, handlers: secondHandlers } = makeMockPi();
    expect(() => mod.default(secondPi)).not.toThrow();
    expect(g.__avtcPiPortraitWired).toBe(true);
    expect(secondHandlers.size).toBe(0);

    // 3. Fire the session_shutdown handlers — the flag must reset to false (reload-safe).
    const shutdownHandlers = handlers.get("session_shutdown") ?? [];
    expect(shutdownHandlers.length).toBeGreaterThan(0);
    for (const handler of shutdownHandlers) {
      await handler({ reason: "reload" }, undefined as unknown as ExtensionContext);
    }
    expect(g.__avtcPiPortraitWired).toBe(false);

    // 4. Call entry a third time — re-wires because the flag was reset on shutdown.
    const { pi: thirdPi, handlers: thirdHandlers } = makeMockPi();
    mod.default(thirdPi);
    expect(g.__avtcPiPortraitWired).toBe(true);
    expect(thirdHandlers.has("session_start")).toBe(true);
  });
});
