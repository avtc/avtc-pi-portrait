// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * : portrait refreshes cachedPortrait only at session_start, so it goes stale mid-session
 * when portrait.md changes without a /reload. The session_compact handler must re-read it.
 *
 * Strategy: mock src/config.js so getPortraitDir resolves to a fresh temp dir (and settings-ui
 * reports enabled). vi.resetModules + a plain dynamic import re-evaluates src/index.js against
 * the mock, so the default export's module-level getPortraitDir calls land in
 * temp. A mock pi captures the pi.on handlers; the test drives them in sequence and asserts
 * on before_agent_start.
 */

const OLD_RULE = "## Anticipation Rules\n- old rule";
const NEW_RULE = "## Anticipation Rules\n- NEW rule after start";

// Mutable holder the config mock reads from. Hoisted so vi.doMock's factory can close over it.
const holder = vi.hoisted(() => ({ portraitDir: "", enabled: true, branch: [] as unknown[] }));

describe("portrait cache refresh on session_compact", () => {
  let tempHome: string;
  let portraitPath: string;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "portrait-d12-"));
    holder.portraitDir = path.join(tempHome, "portrait");
    holder.enabled = true;
    holder.branch = []; // reset fork-state seeded branch between tests
    portraitPath = path.join(holder.portraitDir, "portrait.md");
    fs.mkdirSync(holder.portraitDir, { recursive: true });
    fs.writeFileSync(portraitPath, OLD_RULE);
    // Pause the pipeline so session_start does not schedule a profiling timer.
    fs.writeFileSync(path.join(holder.portraitDir, "portrait-state.json"), '{"paused":true}');

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
    // Mock settings-ui so the extension reads schema-derived defaults with the holder's `enabled`
    // flag (no real settings file, no command registration on the fake pi).
    vi.doMock("../src/settings-ui.js", async () => {
      const { PORTRAIT_SCHEMA } = await import("../src/schema.js");
      const defaults = Object.fromEntries(PORTRAIT_SCHEMA.settings.map((s) => [s.id, s.defaultValue]));
      return {
        initPortraitSettings: () => {},
        getPortraitSettings: () => ({ ...defaults, enabled: holder.enabled }),
      };
    });
    // session_start's acquireLock is irrelevant to (the handler only re-reads the cache).
    // Mock the mutex to report contention so no SQLite handle is held open (which would block
    // Windows from deleting the temp dir in afterEach). startLockPoll's 60s interval is cleared
    // in afterEach via clearAllTimers.
    vi.doMock("../src/snippets/vendored/sqlite-mutex.js", () => ({
      tryAcquireSqliteMutex: async () => null,
    }));
  });

  afterEach(async () => {
    // Kill startLockPoll's interval (acquireLock is mocked to fail → poll started).
    try {
      const { clearAllTimers } = await import("../src/index.js");
      clearAllTimers();
    } catch {
      // ignore — module graph may already be torn down
    }
    vi.doUnmock("../src/config.js");
    vi.doUnmock("../src/settings-ui.js");
    vi.doUnmock("../src/snippets/vendored/sqlite-mutex.js");
    vi.resetModules();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Shared boot core: builds a fake pi whose `appendEntry` is the given function, imports the
   *  extension, and returns the captured handlers + appendedEntries. (The throwing variant's
   *  appendEntry throws before the capture push, so always-capturing is safe and uniform.) */
  async function bootWithAppend(appendEntry: (customType: string, data?: unknown) => void): Promise<{
    handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
    appendedEntries: Array<{ customType: string; data?: unknown }>;
  }> {
    // Idempotent wiring guard (isolate:false shares globalThis): every boot in this file must
    // wire fresh so a new fake pi captures its own handlers (some tests boot several times).
    delete (globalThis as { __avtcPiPortraitWired?: boolean }).__avtcPiPortraitWired;
    const mod = await import("../src/index.js");
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    // Fork-state propagation: capture appendEntry calls so tests can assert CustomEntry appends.
    const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
    const fakePi = {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        handlers.set(event, handler);
      },
      registerCommand() {},
      appendEntry<T = unknown>(customType: string, data?: T) {
        appendEntry(customType, data);
        appendedEntries.push({ customType, data });
      },
    } as unknown as ExtensionAPI;
    mod.default(fakePi);
    return { handlers, appendedEntries };
  }

  /** Build a fresh mock pi that records the registered handlers + appends. */
  async function bootExtension() {
    return bootWithAppend(() => {});
  }

  /** Like bootExtension, but `appendEntry` THROWS — for degradation tests (persist-side
   *  failure: the cache must still be injected; the session must not crash). */
  async function bootExtensionThrowingAppend() {
    return bootWithAppend(() => {
      throw new Error("disk full (simulated)");
    });
  }

  /** Minimal ExtensionContext for session_start/before_agent_start. */
  const fakeCtx = {
    ui: { notify() {}, select() {} },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: undefined,
    sessionManager: {
      getSessionId: () => "s1",
      getBranch: () => holder.branch,
    },
  } as unknown as ExtensionContext;

  it("re-reads cachedPortrait when session_compact fires after portrait.md changes", async () => {
    const { handlers } = await bootExtension();

    // session_start reads the initial (old) cache.
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);

    // Mutate portrait.md WITHOUT a /reload — the mid-session staleness gap fixes.
    fs.writeFileSync(portraitPath, NEW_RULE);

    // Fire session_compact → refresh.
    await handlers.get("session_compact")?.({}, fakeCtx);

    // before_agent_start now reflects the NEW content.
    expect(await inject(handlers)).toContain("NEW rule after start");
  });

  it("stays stale when portrait.md changes but session_compact does NOT fire", async () => {
    const { handlers } = await bootExtension();

    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);

    // Mutate portrait.md but do NOT fire session_compact.
    fs.writeFileSync(portraitPath, NEW_RULE);

    const sp = await inject(handlers);
    // Without the session_compact refresh, before_agent_start still serves the OLD cache.
    expect(sp).toContain("old rule");
    expect(sp).not.toContain("NEW rule after start");
  });

  it("does not refresh when portrait is disabled (gated on enabled)", async () => {
    holder.enabled = false;
    const { handlers } = await bootExtension();

    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    fs.writeFileSync(portraitPath, NEW_RULE);

    // session_compact must NOT refresh the cache when disabled.
    await handlers.get("session_compact")?.({}, fakeCtx);

    // Load time unchanged is the observable signal; assert via re-enabling + before_agent_start.
    // After re-enabling, before_agent_start injects the (stale, un-refreshed) old cache.
    holder.enabled = true;
    const sp = await inject(handlers);
    expect(sp).toContain("old rule");
    expect(sp).not.toContain("NEW rule after start");
  });

  // -------------------------------------------------------------------------
  // Fork-state cache propagation — CustomEntry handoff so a
  // forked subagent child injects the parent's frozen portrait snapshot.
  // -------------------------------------------------------------------------

  function portraitEntry(content: string): { type: string; customType: string; data: unknown } {
    return { type: "custom", customType: "portrait-cache", data: { content } };
  }

  type HandlersMap = Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;

  /** Drive before_agent_start against fakeCtx and return the resulting systemPrompt (or undefined). */
  async function inject(handlers: HandlersMap): Promise<string | undefined> {
    const res = (await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, fakeCtx)) as
      | { systemPrompt?: string }
      | undefined;
    return res?.systemPrompt;
  }

  /** The appendedEntries filtered to portrait-cache snapshots. */
  function portraitAppends(
    appendedEntries: Array<{ customType: string; data?: unknown }>,
  ): Array<{ customType: string; data?: unknown }> {
    return appendedEntries.filter((e) => e.customType === "portrait-cache");
  }

  it("startup with seeded snapshot injects the snapshot, NOT the current file (prefix-cache alignment)", async () => {
    // Seed the branch with a snapshot that differs from the on-disk portrait.md.
    holder.branch = [portraitEntry("## Portrait\n- SNAPSHOT-VALUE-FROM-PARENT")];
    // The on-disk file has DIFFERENT content (OLD_RULE written in beforeEach).
    const { handlers } = await bootExtension();
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    const sp = await inject(handlers);
    expect(sp).toContain("SNAPSHOT-VALUE-FROM-PARENT");
    expect(sp).not.toContain("old rule");
  });

  it("parent startup (empty branch) → appends ONE 'portrait-cache' entry", async () => {
    const { handlers, appendedEntries } = await bootExtension();
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    const portraits = portraitAppends(appendedEntries);
    expect(portraits).toHaveLength(1);
    expect(typeof (portraits[0].data as { content?: string }).content).toBe("string");
  });

  it("child startup (branch seeded with parent snapshot) → restores, does NOT append again", async () => {
    holder.branch = [portraitEntry("## Portrait\n- inherited snapshot")];
    const { handlers, appendedEntries } = await bootExtension();
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    expect(portraitAppends(appendedEntries)).toHaveLength(0);
  });

  it("reason 'new'/'reload'/'resume' → reads fresh from file (not snapshot) + appends", async () => {
    for (const reason of ["new", "reload", "resume"] as const) {
      holder.branch = [portraitEntry("## Portrait\n- SNAPSHOT-ONLY")];
      const { handlers, appendedEntries } = await bootExtension();
      await handlers.get("session_start")?.({ reason }, fakeCtx);
      const sp = await inject(handlers);
      // Fresh file read → injects the file (old rule), NOT the snapshot.
      expect(sp).toContain("old rule");
      expect(sp).not.toContain("SNAPSHOT-ONLY");
      expect(portraitAppends(appendedEntries)).toHaveLength(1);
    }
  });

  it("reason 'fork' → does NOT read the file, does NOT append (reuses in-memory;)", async () => {
    // Seed the in-memory cache with a known value via a startup, then fork.
    holder.branch = [];
    const { handlers, appendedEntries } = await bootExtension();
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    const afterStartup = portraitAppends(appendedEntries).length;

    // Mutate the file AFTER startup so a fresh read on fork would pick up new content.
    fs.writeFileSync(portraitPath, NEW_RULE);

    // Fork: globalThis survives, so cachedPortrait is reused. No file read → still the startup value.
    await handlers.get("session_start")?.({ reason: "fork" }, fakeCtx);
    expect(portraitAppends(appendedEntries).length).toBe(afterStartup); // no append on fork
    const sp = await inject(handlers);
    // Reused in-memory cache: still the OLD content (fork did not read the mutated file).
    expect(sp).toContain("old rule");
    expect(sp).not.toContain("NEW rule after start");
  });

  it("session_compact → appends a fresh 'portrait-cache' entry on top of any startup append", async () => {
    holder.branch = [];
    const { handlers, appendedEntries } = await bootExtension();
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    const afterStartup = portraitAppends(appendedEntries).length;
    // Mutate then compact → refresh + fork-state append.
    fs.writeFileSync(portraitPath, NEW_RULE);
    await handlers.get("session_compact")?.({}, fakeCtx);
    const portraits = portraitAppends(appendedEntries);
    expect(portraits.length).toBe(afterStartup + 1); // compact always appends
    // And before_agent_start now reflects the refreshed (mutated) content.
    expect(await inject(handlers)).toContain("NEW rule after start");
  });

  it("multiple session_compact refreshes each append; child restore returns the LATEST", async () => {
    // : multiple refreshes → each appends; restore (reverse-walk) returns the latest.
    holder.branch = [];
    const { handlers, appendedEntries } = await bootExtension();
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    const afterStartup = portraitAppends(appendedEntries).length;
    // Two distinct portrait contents → two distinct compacts → two distinct snapshots.
    fs.writeFileSync(portraitPath, "## Anticipation Rules\n- compact-one");
    await handlers.get("session_compact")?.({}, fakeCtx);
    fs.writeFileSync(portraitPath, "## Anticipation Rules\n- compact-two");
    await handlers.get("session_compact")?.({}, fakeCtx);
    const portraits = portraitAppends(appendedEntries);
    expect(portraits.length).toBe(afterStartup + 2); // TWO compacts → TWO new appends
    // The last appended snapshot is the latest (compact-two).
    expect((portraits[portraits.length - 1].data as { content: string }).content).toContain("compact-two");
    // A child restoring from this multi-entry branch gets the LATEST (reverse-walk).
    holder.branch = portraits.map((e) => ({ type: "custom", customType: "portrait-cache", data: e.data }));
    const child = await bootExtension();
    await child.handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    expect(await inject(child.handlers)).toContain("compact-two"); // latest snapshot, not compact-one
  });

  it("a throwing appendEntry does NOT crash session_start and the portrait is still injected (degrade)", async () => {
    // Persist-side environmental failure: appendEntry throws (disk full). The session must survive
    // and before_agent_start must still inject the cached portrait — the load-bearing guarantee.
    const { handlers } = await bootExtensionThrowingAppend();
    await expect(handlers.get("session_start")?.({ reason: "startup" }, fakeCtx)).resolves.not.toThrow();
    expect(await inject(handlers)).toContain("old rule"); // cached portrait survived in memory
  });

  it("a throwing getBranch (restore side) does NOT crash session_start and injects the FILE-read fallback", async () => {
    // Restore-side environmental failure (2): getBranch throws → restoreCacheSnapshot
    // degrades to undefined → handler falls back to readPortrait (the file). The session must survive
    // and before_agent_start must still inject (the FILE content, not the unreachable snapshot).
    holder.branch = [
      { type: "custom", customType: "portrait-cache", data: { content: "## Portrait\n- SNAPSHOT-ONLY" } },
    ];
    const throwingCtx = {
      ...fakeCtx,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => {
          throw new Error("corrupt session (simulated I/O)");
        },
      },
    } as unknown as ExtensionContext;
    const { handlers } = await bootExtension();
    await expect(handlers.get("session_start")?.({ reason: "startup" }, throwingCtx)).resolves.not.toThrow();
    const res = (await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, throwingCtx)) as
      | { systemPrompt?: string }
      | undefined;
    expect(res?.systemPrompt).toContain("old rule"); // file-read fallback, not the snapshot
    expect(res?.systemPrompt).not.toContain("SNAPSHOT-ONLY");
  });

  it("child startup restores the snapshot even when portrait is disabled (before_agent_start bails, but the cache IS restored)", async () => {
    // Portrait's restore runs unconditionally on startup (not gated on enabled). With enabled:false,
    // the snapshot is still restored into cachedPortrait, but before_agent_start bails on !enabled.
    // To prove restore actually ran (not just that injection was skipped), RE-ENABLE and fire
    // before_agent_start — it must inject the SNAPSHOT (not the file), proving the disabled-startup
    // restored the snapshot into the cache.
    holder.enabled = false;
    holder.branch = [
      { type: "custom", customType: "portrait-cache", data: { content: "## Portrait\n- DISABLED-SNAPSHOT" } },
    ];
    const { handlers } = await bootExtension();
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    // Injection disabled at startup → before_agent_start returns undefined (restore ran, but gated).
    expect(await inject(handlers)).toBeUndefined();
    // Re-enable → the restored snapshot now injects (proves restore populated cachedPortrait despite enabled:false).
    holder.enabled = true;
    const sp = await inject(handlers);
    expect(sp).toContain("DISABLED-SNAPSHOT");
    expect(sp).not.toContain("old rule"); // file content NOT used — snapshot won
  });

  it("empty/missing portrait cache → session_start startup appends NOTHING (early-return)", async () => {
    // No portrait.md → readPortrait returns undefined → persistCacheSnapshot early-returns (no append).
    holder.branch = [];
    fs.rmSync(portraitPath, { force: true }); // no portrait on disk → cachedPortrait stays undefined
    const { handlers, appendedEntries } = await bootExtension();
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    expect(portraitAppends(appendedEntries)).toHaveLength(0);
  });
});
