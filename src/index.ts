// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "./globals.js";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collect } from "./commands/collect.js";
import { maintenance } from "./commands/maintenance.js";
import { pauseProfiling } from "./commands/pause.js";
import { resumeProfiling } from "./commands/resume.js";
import { getStatus } from "./commands/status.js";
import { getCollectLockPath, getLockPath, getPortraitDir } from "./config.js";
import { clearFooterCtx, initFooter, setCachedPipelineState, setFooterCtx } from "./footer.js";
import { initGit } from "./git.js";
import type { PortraitUiSelect } from "./globals.js";
import { setCapturedModel } from "./llm-call.js";
import { persistCacheSnapshot, restoreCacheSnapshot } from "./persistence.js";
import { runPipelineLoop } from "./pipeline.js";
import { getPortraitSettings, initPortraitSettings } from "./settings-ui.js";
import { tryAcquireSqliteMutex } from "./snippets/vendored/sqlite-mutex.js";
import { subscribeToDialogCoordinator } from "./snippets/vendored/subscribe-to-dialog-coordinator.js";
import { loadPortraitState, readPortrait, savePortraitState } from "./storage.js";
import type { PortraitState } from "./types.js";
import { getErrorMessage } from "./utils.js";

// Idempotent wiring guard. portrait can be bundled into the avtc-pi umbrella
// AND installed standalone — whichever copy loads first wires, the rest no-op.
const WIRED_KEY = "__avtcPiPortraitWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

// globalThis state (survives /reload)
function getState(): PortraitState {
  const existing = globalThis.__piPortrait;
  if (existing) return existing;
  const state: PortraitState = {
    lockHeld: false,
    mainMutex: null,
    timer: null,
    lockPollTimer: null,
    cachedPortrait: undefined,
    cachedPortraitLoadTime: undefined,
    collectCancelled: false,
    bgScanCancelled: false,
    collectLockHeld: false,
    collectMutex: null,
    uiNotify: null,
    uiSelect: null,
    cachedPipelineState: null,
    startProfilingTimer: null,
    runProfilingCycle: null,
    reportError: null,
  };
  globalThis.__piPortrait = state;
  return state;
}

/** Report a profiling error: log to state file + notify user via ui */
function reportProfilingError(errorMsg: string, source: string): void {
  const portraitDir = getPortraitDir();
  try {
    const pipelineState = loadPortraitState(portraitDir);
    pipelineState.lastError = `[${new Date().toISOString()}] ${errorMsg}`;
    savePortraitState(portraitDir, pipelineState);
    setCachedPipelineState(pipelineState);
  } catch {
    // State file may be corrupted/unwritable
  }
  const state = getState();
  if (state.uiNotify) {
    state.uiNotify(`Portrait ${source}: ${errorMsg}`, "error");
  }
}

/**
 * Acquire the MAIN instance lock — non-blocking try. Exactly one session/process holds
 * this for the whole profiling lifetime; losers fall back to `startLockPoll`. Uses the
 * vendored SQLite mutex: `tryAcquireSqliteMutex` resolves within a microtask (mutex if free,
 * null if contended). Crash auto-releases via hot-journal rollback — no heartbeat, no
 * staleness, no PID, no reclaim (the file-lock model's irreducible reclaim race is gone).
 * The held mutex is released at `cleanupOnExit` / `session_shutdown`.
 */
async function acquireLock(): Promise<boolean> {
  const state = getState();
  const mutex = await tryAcquireSqliteMutex(getLockPath());
  if (!mutex) return false; // contended — another process holds the instance lock
  state.mainMutex = mutex;
  state.lockHeld = true;
  return true;
}

/** Release the main instance lock (ROLLBACK + close). Idempotent. */
function releaseLock(): void {
  const state = getState();
  state.mainMutex?.release();
  state.mainMutex = null;
  state.lockHeld = false;
}

/**
 * Acquire the COLLECT lock — non-blocking try. Guards the collection pipeline so only
 * one collection runs at a time (timer or manual `/portrait:collect` / `/portrait:maintenance`).
 * Async (`tryAcquireSqliteMutex`): resolves within a microtask. Returns false when a
 * collection is already running → the caller skips this cycle / reports "already in progress".
 * `releaseCollectLock` releases the mutex when the collection ends. Crash auto-releases.
 */
async function acquireCollectLock(): Promise<boolean> {
  const state = getState();
  if (state.collectLockHeld) return false; // don't double-acquire within this process
  const mutex = await tryAcquireSqliteMutex(getCollectLockPath());
  if (!mutex) return false; // another collection is running
  state.collectMutex = mutex;
  state.collectLockHeld = true;
  return true;
}

/** Release the collect lock (ROLLBACK + close). Idempotent. */
function releaseCollectLock(): void {
  const state = getState();
  state.collectMutex?.release();
  state.collectMutex = null;
  state.collectLockHeld = false;
}

function startLockPoll(portraitDir: string): void {
  const state = getState();
  state.lockPollTimer = setInterval(async () => {
    try {
      // Non-blocking try-acquire: if the instance lock is still held by another process,
      // tryAcquireSqliteMutex returns null and we poll again next tick. When the holder dies,
      // SQLite hot-journal recovery auto-releases → our next try wins. No staleness check.
      const acquired = await acquireLock();
      if (acquired) {
        if (state.lockPollTimer) {
          clearInterval(state.lockPollTimer);
          state.lockPollTimer = null;
        }
        // Read pause state and enabled setting
        const settings = getPortraitSettings();
        const pipelineState = loadPortraitState(portraitDir);
        if (settings.enabled && !pipelineState.paused) {
          startProfilingTimer();
        }
      }
    } catch (error) {
      reportProfilingError(getErrorMessage(error), "lock poll error");
    }
  }, 60_000);
}

async function runProfilingCycle(): Promise<void> {
  const settings = getPortraitSettings();

  // Check if portrait is still enabled
  if (!settings.enabled) return;

  // Check pause state — may have been set by another instance's manual collect
  const portraitDir = getPortraitDir();
  const pipelineState = loadPortraitState(portraitDir);
  if (pipelineState.paused) {
    const state = getState();
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    return;
  }

  // Try to acquire collect lock — skip if another collection is running
  if (!(await acquireCollectLock())) return;

  // Safe to reset cancel flags — we own the lock
  const state = getState();
  state.collectCancelled = false;
  state.bgScanCancelled = false;

  try {
    // : SQLite mutex crash-releases on process death — no heartbeat/lease to keep alive.
    await runPipelineLoop(settings, Infinity, () => false);
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    if (errorMsg === "PAUSED") {
      // User chose to pause from LLM retry dialog
      if (state.uiNotify) state.uiNotify(pauseProfiling(), "info");
      return;
    }
    // Reset phase to idle before reporting — prevents footer from showing stale phase
    const ps = loadPortraitState(getPortraitDir());
    ps.pipelinePhase = "idle";
    savePortraitState(getPortraitDir(), ps);
    setCachedPipelineState(ps);
    reportProfilingError(errorMsg, "profiling error");
  } finally {
    releaseCollectLock();
  }
}

export function startProfilingTimer(): void {
  const state = getState();
  const settings = getPortraitSettings();

  // null interval = manual-only mode (collect via /portrait:collect, no background timer).
  if (settings.intervalMs === null) return;
  const intervalMs = settings.intervalMs;

  state.timer = setInterval(async () => {
    try {
      await runProfilingCycle();
    } catch (error) {
      reportProfilingError(getErrorMessage(error), "profiling error");
    }
  }, intervalMs);
}

// Export on globalThis so resume.ts can call it without circular import
globalThis.__piPortraitStartProfilingTimer = startProfilingTimer;
globalThis.__piPortraitRunProfilingCycle = runProfilingCycle;
globalThis.__piPortraitReportError = reportProfilingError;
globalThis.__piPortraitAcquireCollectLock = acquireCollectLock;
globalThis.__piPortraitReleaseCollectLock = releaseCollectLock;

/** Clear all timers — used by session_shutdown and tests. */
export function clearAllTimers(): void {
  const state = getState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.lockPollTimer) {
    clearInterval(state.lockPollTimer);
    state.lockPollTimer = null;
  }
  // No heartbeat timers under (SQLite mutex crash-releases on process death).
}

function cleanupOnExit(): void {
  const state = getState();
  clearAllTimers();

  // Release held mutexes (ROLLBACK + close). MUST run before deleting globalThis state
  // releaseLock/releaseCollectLock read getState, which returns a fresh (mutex-less)
  // state if __piPortrait is already deleted, making the release a silent no-op.
  // (SQLite also auto-releases on process exit via hot-journal rollback, but this keeps
  // /reload — which does NOT exit the process — clean.)
  if (state.lockHeld) {
    releaseLock();
  }
  if (state.collectLockHeld) {
    releaseCollectLock();
  }
  delete globalThis.__piPortrait;
}

export default function (pi: ExtensionAPI) {
  // Idempotent guard: if any copy of portrait already wired this process, no-op. Whichever
  // load (umbrella bundle or standalone install) runs first wins; the rest return immediately.
  const g = globalThis as GlobalWithWired;
  if (g[WIRED_KEY]) return;
  g[WIRED_KEY] = true;
  // Register the /portrait:settings command + modal and create the settings handle (global-only;
  // reads fresh from ~/.pi/agent/avtc-pi-portrait-settings.json). Must run before any getPortraitSettings().
  initPortraitSettings(pi);
  // Subscribe to the cross-extension dialog coordinator so retry/reset dialogs queue behind
  // any open modal (e.g. /portrait:settings) instead of stealing focus. No-op if avtc-pi-ui-components
  // is not installed.
  subscribeToDialogCoordinator(pi);
  const settings = getPortraitSettings();
  const portraitDir = getPortraitDir();

  // Ensure directory exists
  fs.mkdirSync(portraitDir, { recursive: true });
  initGit(portraitDir);

  // Store pi reference on state for timer/callback access
  const _state = getState();

  // Initialize footer widget
  initFooter();

  // Capture model for LLM calls (kanban pattern)
  // Capture model for LLM calls (kanban pattern) — single listener for all events
  const captureModel = (ctx: ExtensionContext) => {
    if (ctx.model && ctx.modelRegistry) {
      setCapturedModel(ctx.model, ctx.modelRegistry);
    }
  };
  pi.on("turn_end", async (_event, ctx) => captureModel(ctx));
  pi.on("model_select", async (_event, ctx) => captureModel(ctx));

  // session_start hook — capture model, refresh UI refs, re-read portrait, acquire lock
  pi.on("session_start", async (event, ctx) => {
    captureModel(ctx);
    // Store UI methods for timer/footer access (refreshed on every session_start)
    const sessionState = getState();
    sessionState.uiNotify = ctx.ui.notify.bind(ctx.ui);
    sessionState.uiSelect = ctx.ui.select.bind(ctx.ui) as PortraitUiSelect;
    setFooterCtx(ctx);

    // Re-read portrait cache — fork-state propagation.
    // : restore from CustomEntry only on startup (subagent child) / fork (in-process).
    //   - fork: globalThis survives; existing cachedPortrait is already correct. Reuse (no append).
    //   - startup: subagent child restores the parent's snapshot; parent first start reads file.
    //   - new/reload/resume/other: fresh from file.
    // : append only when freshly read from file (did NOT restore/reuse).
    let restored = false;
    if (event.reason === "fork") {
      restored = true; // in-process fork reuses the in-memory cache; no read, no append
    } else if (event.reason === "startup") {
      const snapshot = restoreCacheSnapshot(ctx);
      if (snapshot) {
        sessionState.cachedPortrait = snapshot.content;
        sessionState.cachedPortraitLoadTime = new Date();
        restored = true;
      }
    }
    if (!restored) {
      // startup-no-snapshot (parent first start) / new / reload / resume / other → fresh from file.
      sessionState.cachedPortrait = readPortrait(portraitDir);
      sessionState.cachedPortraitLoadTime = new Date();
      persistCacheSnapshot(pi, sessionState.cachedPortrait);
    }

    // Skip background collector in subagent mode — portrait is system-wide, not session-wide.
    // Subagent still needs cache restoration above (for before_agent_start injection).
    if (ctx.mode !== "tui" || process.env.PI_SUBAGENT_PARENT_PID) return;

    // Skip if already running (reload/new/resume)
    if (sessionState.timer) return;

    // Try to acquire lock
    const acquired = await acquireLock();
    if (acquired) {
      // Lock acquired (SQLite mutex) — no heartbeat to start (crash auto-releases).

      // Check pause state and enabled setting
      const pipelineState = loadPortraitState(portraitDir);
      if (settings.enabled && !pipelineState.paused) {
        const delayMs = settings.startupDelayMs;
        setTimeout(() => startProfilingTimer(), delayMs);
      }
    } else {
      // Start lock poll
      startLockPoll(portraitDir);
    }
  });

  // session_compact hook — refresh cachedPortrait. session_start only re-reads on
  // /reload, so the cache goes stale mid-session when portrait.md changes. Compaction is the
  // natural mid-session moment to refresh (mirrors the cache-read block in session_start).
  pi.on("session_compact", async () => {
    if (getPortraitSettings().enabled) {
      const state = getState();
      state.cachedPortrait = readPortrait(portraitDir);
      state.cachedPortraitLoadTime = new Date();
      persistCacheSnapshot(pi, state.cachedPortrait); //  / — always appends (file-read refresh)
    }
  });

  // session_shutdown — clear footer ctx, stop all timers, and RELEASE held SQLite mutexes.
  // globalThis state survives /reload (and /new), so an unreleased BEGIN IMMEDIATE connection
  // would keep the write lock open and the reloaded session's acquireLock would contend with
  // this leaked connection forever (startLockPoll polls infinitely → permanent deadlock).
  // removed the stale-reclaim path that made the old file-lock self-heal on reload, so the
  // main mutex MUST be released here. lockPollTimer (60s) is also cleared to keep the event
  // loop from staying alive after the agent loop finishes (avoids subagent inactivity-timeout
  // kills).
  // NOTE: only the MAIN (instance) lock is released here. The COLLECT lock is owned by an
  // in-flight runPipelineLoop and released by its own `finally` — releasing it here would steal
  // the lock mid-collection and let a reloaded session collect concurrently (lost updates).
  pi.on("session_shutdown", async () => {
    clearFooterCtx();
    clearAllTimers();
    const state = getState();
    // Signal in-progress MANUAL collection/maintenance to stop (they check collectCancelled).
    // The auto profiling cycle ignores these (runs to completion) — its collect lock is released
    // by runProfilingCycle's `finally`.
    if (state.collectLockHeld) {
      state.collectCancelled = true;
      state.bgScanCancelled = true;
    }
    // Release the main instance lock so /reload can re-acquire (no reclaim step under).
    if (state.lockHeld) releaseLock();
  });

  // before_agent_start hook
  pi.on("before_agent_start", async (event, _ctx) => {
    const state = getState();
    if (!state.cachedPortrait) return undefined;
    if (!getPortraitSettings().enabled) return undefined;
    return { systemPrompt: (event.systemPrompt ?? "") + state.cachedPortrait };
  });

  // Register commands
  pi.registerCommand("portrait:status", {
    description: "Show portrait profiling status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(getStatus(), "info");
    },
  });

  pi.registerCommand("portrait:pause", {
    description: "Pause portrait profiling (lock holder only)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(pauseProfiling(), "info");
    },
  });

  pi.registerCommand("portrait:resume", {
    description: "Resume portrait profiling (lock holder only)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(resumeProfiling(), "info");
    },
  });

  pi.registerCommand("portrait:collect", {
    description: "Manual collection. Usage: /portrait:collect [N]",
    handler: async (args, ctx) => {
      const parsed = args.trim() ? parseInt(args.trim(), 10) : undefined;
      const limit = parsed !== undefined && !Number.isNaN(parsed) ? parsed : undefined;
      // Run in background — don't block the command handler
      ctx.ui.notify("👤 Portrait collection started...", "info");
      collect(limit)
        .then((result) => {
          ctx.ui.notify(result, "info");
        })
        .catch((err) => {
          ctx.ui.notify(`👤 Collection failed: ${getErrorMessage(err)}`, "error");
        });
    },
  });

  pi.registerCommand("portrait:stop", {
    description: "Stop an in-progress portrait collection",
    handler: async (_args, ctx) => {
      const state = globalThis.__piPortrait;
      if (!state?.collectLockHeld) {
        ctx.ui.notify("👤 No collection is running in this session.", "warning");
        return;
      }
      state.collectCancelled = true;
      state.bgScanCancelled = true;
      ctx.ui.notify("👤 Portrait collection will stop after current step.", "info");
    },
  });

  pi.registerCommand("portrait:maintenance", {
    description: "Run portrait maintenance (dedup, contradiction resolution, cleanup, backfill)",
    handler: async (_args, ctx) => {
      const state = globalThis.__piPortrait;
      // Run in background — don't block the command handler (same pattern as /collect)
      ctx.ui.notify("👤 Portrait maintenance started...", "info");
      maintenance(() => state?.collectCancelled === true)
        .then((result) => {
          ctx.ui.notify(result, "info");
        })
        .catch((err) => {
          ctx.ui.notify(`👤 Maintenance failed: ${getErrorMessage(err)}`, "error");
        });
    },
  });

  pi.registerCommand("portrait:reset", {
    description: "Reset portrait — clear all rules and checkpoints for re-extraction",
    handler: async (_args, _ctx) => {
      const { reset } = await import("./commands/reset.js");
      const result = await reset();
      _ctx.ui.notify(result, "info");
    },
  });

  // Process exit cleanup
  process.on("exit", cleanupOnExit);

  // Reset the wiring flag on shutdown so /reload re-wires. pi re-evaluates extension modules
  // fresh on /reload (jiti moduleCache:false) but globalThis persists — an un-reset flag would
  // short-circuit re-wiring and leave the extension dead after reload. This complements the
  // cleanup session_shutdown handler above (both fire: pi accumulates handlers per event).
  pi.on("session_shutdown", () => {
    (globalThis as GlobalWithWired)[WIRED_KEY] = false;
  });
}
