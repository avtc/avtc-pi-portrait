// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Global test setup, registered via `setupFiles` in vitest.config.ts.
 *
 * The suite runs with `isolate: false` for speed, which shares ONE module registry and ONE
 * `globalThis` across every test file. Without coordination this turns ordinary test patterns
 * into deterministic killers:
 *
 * 1. `vi.mock(module)` collisions. When several files `vi.mock` the SAME module, only the first
 *    factory to load wins for the whole process, and the `vi.fn()` it mints is the single cached
 *    instance. Files that captured a different instance then configure a mock the SUT never calls
 *    (symptoms: "promise resolved instead of rejecting", "Phase 1 LLM call failed", one file's
 *    portrait dir leaking into another → ENOENT). Worse, some files need a module's REAL exports
 *    while others need them STUBBED (e.g. portrait.test.ts exercises the real builder/storage/
 *    footer; maintenance/pipeline stub them) — one shared registry cannot hold both, so whichever
 *    file loads first decides for everyone. The fix is to mock each shared module ONCE, here,
 *    preserving the real exports (via `importOriginal`) and gating the stubs behind per-file flags
 *    so a file opts into exactly the stubs it needs.
 * 2. `vi.useFakeTimers()` is process-global. A fake-timer leak from one file freezes the real-timer
 *    waits (`setTimeout`) of another (e.g. sqlite-mutex busy-retry → 30s test timeout).
 *
 * Convention: a test file calls `useStubs({ ... })` in its `beforeEach` to declare which modules it
 * wants stubbed. While a stub's flag is on, calls to that function hit a `vi.fn` (which records
 * calls and lets the test drive return values via `mockResolvedValue`/`mockReturnValue`); while it
 * is off, the call is forwarded to the REAL implementation, so files that need real behavior
 * (portrait.test.ts) are unaffected. The stub function IS the module export, so existing
 * `import { fn } from "../src/x.js"` + `as unknown as ReturnType<typeof vi.fn>` + `.mock` patterns
 * keep working unchanged.
 */

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * Per-test portrait configuration holder. `vi.mock("../src/config.js")` below reads every field
 * from here, so every test file that needs to redirect config sets the relevant fields in its
 * `beforeEach` (the holder is reset after each test by {@link afterEach}).
 */
export interface PortraitTestConfig {
  portraitDir: string;
  lockPath: string;
  collectLockPath: string;
  sessionDirs: string[];
  bgScanCheckpointsPath: string;
}

const DEFAULT_TEST_CONFIG: PortraitTestConfig = {
  portraitDir: "",
  lockPath: "",
  collectLockPath: "",
  sessionDirs: [],
  bgScanCheckpointsPath: "",
};

/**
 * Derive a lock/checkpoint path under the portrait dir when a test does not set the explicit
 * field (mirrors how the real config derives these from its STATE_DIR base). This keeps the
 * naming convention (`instance.lock.sqlite`, `collect.lock.sqlite`, `bg-scan-checkpoints.json`)
 * under test by construction without each test spelling every path out.
 */
function derivedPath(field: keyof PortraitTestConfig, fallbackBase: string, filename: string): string {
  const cfg = globalThis.__portraitTestConfig;
  const explicit = cfg?.[field];
  if (typeof explicit === "string" && explicit) return explicit;
  const base = cfg?.portraitDir || fallbackBase;
  return path.join(base, filename);
}

/**
 * Set the portrait config for the current test. Any omitted field is reset to its default.
 * Intended for use in a test file's `beforeEach` (the holder is cleared after each test).
 */
export function setTestConfig(overrides: Partial<PortraitTestConfig>): PortraitTestConfig {
  const cfg: PortraitTestConfig = { ...DEFAULT_TEST_CONFIG, ...overrides };
  globalThis.__portraitTestConfig = cfg;
  return cfg;
}

/**
 * The stub flags a test file can opt into via {@link useStubs}. Each key names a module whose
 * stubbed exports should be active for the current test. Unset/off ⇒ real implementation.
 */
export interface PortraitStubFlags {
  /** builder.buildPortrait */
  builder?: boolean;
  /** footer.setCachedPipelineState */
  footer?: boolean;
  /** storage.load/savePortraitState, readPortrait, parsePortraitRules */
  storage?: boolean;
  /** maintenance-core.runMaintenance (and NO_CANCEL_CHECK sentinel) */
  maintenanceCore?: boolean;
  /** collector.scanSessions, discoverFiles, countPendingTrios */
  collector?: boolean;
  /** git.initGit, commitPortrait, checkoutHead */
  git?: boolean;
  /** error.reportError */
  error?: boolean;
}

const NO_STUBS: PortraitStubFlags = {
  builder: false,
  footer: false,
  storage: false,
  maintenanceCore: false,
  collector: false,
  git: false,
  error: false,
};

/**
 * Declare which module stubs the current test wants active. Replaces the whole flag set, so a
 * file that needs no stubs (portrait.test.ts) is implicitly all-real without calling this. Call
 * from a test file's `beforeEach` (flags are reset after each test by {@link afterEach}).
 */
export function useStubs(flags: PortraitStubFlags): PortraitStubFlags {
  globalThis.__portraitMockFlags = { ...NO_STUBS, ...flags };
  return globalThis.__portraitMockFlags;
}

/** Whether a given stub flag is currently on. Used by the gated forwarders below. */
function stubOn(key: keyof PortraitStubFlags): boolean {
  return globalThis.__portraitMockFlags?.[key] === true;
}

/**
 * The in-memory portrait state that the storage stub reads/writes when the `storage` flag is on.
 * Reset before each test that uses the storage stub (see {@link resetStubState}).
 */
const STUB_STATE: Record<string, unknown> = {};

/**
 * Access the in-memory portrait-state object the storage stub reads/writes (`storage` flag on).
 * Tests that assert on persisted pipeline state reference this instead of a per-file holder so the
 * identity matches what `loadPortraitState`/`savePortraitState` actually use.
 */
export function getStubPortraitState(): Record<string, unknown> {
  return STUB_STATE;
}

/** Reset the in-memory storage stub state (called automatically after each test). */
function resetStubState(): void {
  for (const key of Object.keys(STUB_STATE)) {
    delete STUB_STATE[key];
  }
  Object.assign(STUB_STATE, {
    totalKnownTrios: 0,
    triosProcessed: 0,
    scanSessionKB: 0,
    scanRemainingKB: 0,
    pipelinePhase: "idle",
    remainingFiles: 0,
    lastPipelineRun: null,
    lastScanTimestamp: null,
  });
}
resetStubState();

/**
 * Registry of every flag-gated forwarder created below, paired with its real-vs-stub impl. The
 * shared `afterEach` `mockReset`s each one (clearing leaked `mockResolvedValueOnce`/
 * `mockRejectedValueOnce` queues that `clearAllMocks` leaves behind and that would otherwise fire
 * in an unrelated test/file) and immediately re-arms the flag-gating impl, so the forwarder keeps
 * delegating to real or stub as its flag demands.
 */
type ForwarderImpl = (...args: never[]) => unknown;
const forwarders: Array<{ fn: ReturnType<typeof vi.fn>; impl: ForwarderImpl }> = [];

/**
 * Build a flag-gated forwarder: a `vi.fn` whose impl routes to `stubImpl` when the flag is on and
 * `realImpl` when it is off. Registered for per-test reset (see {@link forwarders}). The returned
 * fn IS the module export, so `import { fn } from "../src/x.js"` + `as unknown as ReturnType<typeof
 * vi.fn>` + `.mock`/`.mockResolvedValueOnce` keep working unchanged in tests.
 */
function gatedMock(
  flag: keyof PortraitStubFlags,
  realImpl: ForwarderImpl,
  stubImpl: ForwarderImpl,
): ReturnType<typeof vi.fn> {
  const impl = (...args: never[]): unknown => (stubOn(flag) ? stubImpl(...args) : realImpl(...args));
  const fn = vi.fn(impl);
  forwarders.push({ fn, impl });
  return fn;
}

// ---- The ONE mock per shared module -----------------------------------------------------------

// config: fully synthetic (every field reads from the holder / derives from portraitDir).
const REAL_STATE_DIR = path.join(os.homedir(), ".pi", "portrait");
vi.mock("../src/config.js", () => ({
  getPortraitDir: () => globalThis.__portraitTestConfig?.portraitDir ?? "",
  getLockPath: () => derivedPath("lockPath", REAL_STATE_DIR, "instance.lock.sqlite"),
  getCollectLockPath: () => derivedPath("collectLockPath", REAL_STATE_DIR, "collect.lock.sqlite"),
  getSessionDirs: () => globalThis.__portraitTestConfig?.sessionDirs ?? [],
  getBgScanCheckpointsPath: () => derivedPath("bgScanCheckpointsPath", REAL_STATE_DIR, "bg-scan-checkpoints.json"),
}));

// llm-call: spread the real module (so real exports like attemptWithRetries/countWords/
// retryDelayMs/PAUSED survive for llm-call.test.ts) and replace only callPortraitLlm + the sinks,
// with stable identities from the shared bag so a test's `mockResolvedValue` always targets the
// instance the SUT calls (collector caches one callPortraitLlm reference for the whole process).
vi.mock("../src/llm-call.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/llm-call.js")>();
  const bag = testMockBag();
  return {
    ...orig,
    callPortraitLlm: bag.callPortraitLlm,
    setLlmProgressSink: bag.setLlmProgressSink,
    setDebugStreamSink: bag.setDebugStreamSink,
    makeDebugStreamDumpSink: bag.makeDebugStreamDumpSink,
  };
});

// builder: real applyDecisions/validateDecisions are always available (portrait.test.ts exercises
// them); buildPortrait is stubbed only when the `builder` flag is on (maintenance/pipeline).
vi.mock("../src/builder.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/builder.js")>();
  return {
    ...orig,
    buildPortrait: gatedMock("builder", orig.buildPortrait, async () => undefined),
  };
});

// footer: real footer fns always available; setCachedPipelineState stubbed only when `footer` on.
vi.mock("../src/footer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/footer.js")>();
  return {
    ...orig,
    setCachedPipelineState: gatedMock("footer", orig.setCachedPipelineState, () => undefined),
  };
});

// storage: real storage always available (maintenance/portrait read & write real portrait state);
// the 4 functions pipeline drives are stubbed only when `storage` is on, backed by STUB_STATE.
vi.mock("../src/storage.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/storage.js")>();
  return {
    ...orig,
    loadPortraitState: gatedMock("storage", orig.loadPortraitState, () => STUB_STATE),
    savePortraitState: gatedMock("storage", orig.savePortraitState, (_dir: string, state: Record<string, unknown>) => {
      Object.assign(STUB_STATE, state);
    }),
    readPortrait: gatedMock("storage", orig.readPortrait, () => undefined),
    parsePortraitRules: gatedMock("storage", orig.parsePortraitRules, () => []),
  };
});

// maintenance-core: real runMaintenance always available (maintenance.test.ts tests it directly);
// stubbed only when `maintenanceCore` is on (pipeline).
vi.mock("../src/maintenance-core.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/maintenance-core.js")>();
  return {
    ...orig,
    NO_CANCEL_CHECK: undefined,
    runMaintenance: gatedMock("maintenanceCore", orig.runMaintenance, async () => "Maintenance complete."),
  };
});

// collector: real collector always available (extraction/portrait exercise scanSessions via spies);
// scanSessions/discoverFiles/countPendingTrios stubbed only when `collector` is on (pipeline).
vi.mock("../src/collector.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/collector.js")>();
  return {
    ...orig,
    discoverFiles: gatedMock("collector", orig.discoverFiles, () => []),
    scanSessions: gatedMock("collector", orig.scanSessions, async () => ({
      results: [],
      remainingFiles: 0,
      triosProcessed: 0,
      totalKnownTrios: 0,
    })),
    countPendingTrios: gatedMock("collector", orig.countPendingTrios, async () => 0),
  };
});

// git: real git always available (maintenance/portrait use the injectable runner seam); initGit/
// commitPortrait/checkoutHead stubbed only when `git` is on (extraction).
vi.mock("../src/git.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...orig,
    initGit: gatedMock("git", orig.initGit, () => undefined),
    commitPortrait: gatedMock("git", orig.commitPortrait, () => true),
    checkoutHead: gatedMock("git", orig.checkoutHead, () => false),
  };
});

// error: real reportError always available; stubbed (no-op) only when `error` is on.
vi.mock("../src/error.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/error.js")>();
  return {
    ...orig,
    reportError: gatedMock("error", orig.reportError, () => undefined),
  };
});

// ---- shared llm-call mock identities (survive vi.resetModules in extension-idempotency) -------
function testMockBag(): TestMockBag {
  let bag = globalThis.__portraitTestBag;
  if (!bag) {
    bag = {
      callPortraitLlm: vi.fn(),
      setLlmProgressSink: vi.fn(),
      setDebugStreamSink: vi.fn(),
      makeDebugStreamDumpSink: vi.fn(() => vi.fn()),
    };
    globalThis.__portraitTestBag = bag;
  }
  return bag;
}

interface TestMockBag {
  callPortraitLlm: ReturnType<typeof vi.fn>;
  setLlmProgressSink: ReturnType<typeof vi.fn>;
  setDebugStreamSink: ReturnType<typeof vi.fn>;
  makeDebugStreamDumpSink: ReturnType<typeof vi.fn>;
}

// Real timers before every test: a fake-timer leak from a prior test would freeze real-timer
// waits (e.g. the sqlite-mutex busy-retry loop) and time the test out at 30s.
beforeEach(() => {
  vi.useRealTimers();
});

// Reset global hazards after each test so nothing leaks into the next file's tests.
afterEach(() => {
  vi.useRealTimers();
  // Clear every flag-gated forwarder's call log AND queued `mockResolvedValueOnce`/
  // `mockRejectedValueOnce` returns (which `clearAllMocks`/`mockClear` leave behind and which would
  // otherwise fire in an unrelated test), then re-arm the flag-gating impl.
  for (const { fn, impl } of forwarders) {
    fn.mockReset();
    fn.mockImplementation(impl);
  }
  // Reset the shared llm-call bag stubs (queued returns would otherwise leak across files).
  const bag = globalThis.__portraitTestBag;
  if (bag) {
    bag.callPortraitLlm.mockReset();
    bag.setLlmProgressSink.mockReset();
    bag.setDebugStreamSink.mockReset();
    bag.makeDebugStreamDumpSink.mockReset();
    bag.makeDebugStreamDumpSink.mockImplementation(() => vi.fn());
  }
  globalThis.__portraitTestConfig = undefined;
  globalThis.__portraitMockFlags = undefined;
  // Clear EVERY __piPortrait* global. Importing src/index.ts (extension entry) stamps real,
  // SQLite-mutex-backed closures onto globalThis at module top level (e.g.
  // __piPortraitAcquireCollectLock); under isolate:false those persist for the whole process and a
  // later file's collect()/maintenance() would call a stale closure → "Collection already in
  // progress" or writes to a torn-down lock path. Each test that needs these re-sets them in its
  // own beforeEach, so clearing here is safe and keeps tests hermetic.
  delete globalThis.__piPortrait;
  delete globalThis.__piPortraitPipelineState;
  delete globalThis.__piPortraitStartProfilingTimer;
  delete globalThis.__piPortraitRunProfilingCycle;
  delete globalThis.__piPortraitReportError;
  delete globalThis.__piPortraitAcquireCollectLock;
  delete globalThis.__piPortraitReleaseCollectLock;
  resetStubState();
});

declare global {
  // eslint-disable-next-line no-var
  var __portraitTestConfig: PortraitTestConfig | undefined;
  // eslint-disable-next-line no-var
  var __portraitMockFlags: PortraitStubFlags | undefined;
  // eslint-disable-next-line no-var
  var __portraitTestBag: TestMockBag | undefined;
}
