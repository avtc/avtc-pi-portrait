// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  reload lifecycle: the SQLite mutex (BEGIN IMMEDIATE) is held by an open connection on
 * globalThis state. globalThis state SURVIVES /reload. Under the old file-lock, /reload worked
 * via stale-reclaim; removed reclaim by construction, so `session_shutdown` MUST release
 * the held mutex — otherwise the leaked connection keeps the write lock and the reloaded
 * session's `acquireLock` opens a competing connection that is BUSY forever → startLockPoll
 * polls infinitely → the instance never profiles again (permanent deadlock after every /reload).
 */

// Mutable holder the config mock reads from. Hoisted so vi.doMock's factory can close over it.
const holder = vi.hoisted(() => ({ portraitDir: "" }));

describe("lock lifecycle across /reload (session_shutdown release)", () => {
  let tempHome: string;

  beforeEach(async () => {
    // Idempotent wiring guard (isolate:false shares globalThis): ensure this file can boot
    // the extension fresh regardless of suite ordering, otherwise the entry may no-op.
    delete (globalThis as { __avtcPiPortraitWired?: boolean }).__avtcPiPortraitWired;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "portrait-reload-"));
    holder.portraitDir = path.join(tempHome, "portrait");
    fs.mkdirSync(holder.portraitDir, { recursive: true });
    fs.writeFileSync(path.join(holder.portraitDir, "portrait.md"), "## Portrait");
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
    // NOTE: sqlite-mutex is NOT mocked — the real BEGIN IMMEDIATE mutex is exercised so two
    // connections genuinely contend.
    // Git audit layer is irrelevant here (the assertions are about mutex release, not commit
    // messages). Mock it to skip the `git` subprocesses initGit spawns on each boot.
    vi.doMock("../src/git.js", () => ({
      initGit: vi.fn(),
      commitPortrait: vi.fn(() => true),
      checkoutHead: vi.fn(() => false),
    }));
  });

  afterEach(async () => {
    // Release any held mutex from the (possibly leaked) globalThis state so Windows can delete
    // the temp lock DBs. Under the bug (session_shutdown doesn't release), the leaked
    // connection keeps the file open and rmSync throws EPERM without this.
    const leaked = (
      globalThis as { __piPortrait?: { mainMutex?: { release(): void }; collectMutex?: { release(): void } } }
    ).__piPortrait;
    try {
      leaked?.mainMutex?.release();
      leaked?.collectMutex?.release();
    } catch {
      // already released
    }
    try {
      const { clearAllTimers } = await import("../src/index.js");
      clearAllTimers();
    } catch {
      // module graph may already be torn down
    }
    vi.doUnmock("../src/config.js");
    vi.doUnmock("../src/settings-ui.js");
    vi.doUnmock("../src/git.js");
    vi.resetModules();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  async function bootExtension() {
    const mod = await import("../src/index.js");
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const fakePi = {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        handlers.set(event, handler);
      },
      registerCommand() {},
      // Fork-state propagation calls appendEntry at session_start; this test does not assert appends,
      // so a no-op keeps the existing reload-lifecycle assertions intact.
      appendEntry() {},
    } as unknown as ExtensionAPI;
    mod.default(fakePi);
    return handlers;
  }

  const fakeCtx = {
    ui: { notify() {}, select() {} },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: undefined,
    sessionManager: {
      getSessionId: () => "s1",
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;

  it("releases the instance lock on session_shutdown so /reload can re-acquire it", async () => {
    const handlers = await bootExtension();

    // First boot: acquireLock succeeds (no contention).
    await handlers.get("session_start")?.({ reason: "startup" }, fakeCtx);
    const state0 = (globalThis as { __piPortrait?: { lockPollTimer: NodeJS.Timeout | null } }).__piPortrait;
    expect(state0?.lockPollTimer).toBeNull(); // acquired — no lock poll running

    // /reload tears the session down — must release the held mutex.
    await handlers.get("session_shutdown")?.({}, fakeCtx);

    // Reloaded session must be able to re-acquire the SAME lock file. If session_shutdown did
    // NOT release the mutex, the leaked connection keeps the write lock and acquireLock returns
    // null → startLockPoll runs → lockPollTimer is set (permanent deadlock).
    await handlers.get("session_start")?.({ reason: "reload" }, fakeCtx);
    const state1 = (globalThis as { __piPortrait?: { lockPollTimer: NodeJS.Timeout | null } }).__piPortrait;
    expect(state1?.lockPollTimer).toBeNull(); // re-acquired on reload — no deadlock
  });
});
