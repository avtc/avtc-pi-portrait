// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing pipeline
vi.mock("../src/config.js", () => ({
  getPortraitDir: vi.fn(() => "/tmp/portrait"),
  getSessionDirs: vi.fn(() => ["/tmp/sessions"]),
}));

vi.mock("../src/collector.js", () => ({
  scanSessions: vi.fn(),
  discoverFiles: vi.fn(() => []),
  countPendingTrios: vi.fn().mockResolvedValue(0),
}));

const globalMockState: Record<string, unknown> = {
  totalKnownTrios: 0,
  triosProcessed: 0,
  scanSessionKB: 0,
  scanRemainingKB: 0,
  pipelinePhase: "idle",
  remainingFiles: 0,
  lastPipelineRun: null,
  lastScanTimestamp: null,
};

vi.mock("../src/builder.js", () => ({
  buildPortrait: vi.fn(),
}));

vi.mock("../src/storage.js", () => {
  return {
    loadPortraitState: vi.fn(() => globalMockState),
    savePortraitState: vi.fn((_dir: string, state: Record<string, unknown>) => {
      Object.assign(globalMockState, state);
    }),
    readPortrait: vi.fn(),
    parsePortraitRules: vi.fn(() => []),
  };
});

vi.mock("../src/footer.js", () => ({
  setCachedPipelineState: vi.fn(),
}));

vi.mock("../src/maintenance-core.js", () => ({
  runMaintenance: vi.fn().mockResolvedValue("Maintenance complete."),
  NO_CANCEL_CHECK: undefined,
}));

vi.mock("../src/error.js", () => ({
  reportError: vi.fn(),
}));

import { buildPortrait } from "../src/builder.js";
import { countPendingTrios, scanSessions } from "../src/collector.js";
import { runMaintenance } from "../src/maintenance-core.js";
import { resetPipelineState, runPipelineLoop } from "../src/pipeline.js";
import type { PortraitSettings } from "../src/schema.js";
import { loadPortraitState, parsePortraitRules, readPortrait } from "../src/storage.js";

const mockScanSessions = scanSessions as unknown as ReturnType<typeof vi.fn>;
const mockBuildPortrait = buildPortrait as unknown as ReturnType<typeof vi.fn>;
const mockLoadPortraitState = loadPortraitState as unknown as ReturnType<typeof vi.fn>;
const mockReadPortrait = readPortrait as unknown as ReturnType<typeof vi.fn>;
const mockCountPendingTrios = countPendingTrios as unknown as ReturnType<typeof vi.fn>;
const mockParsePortraitRules = parsePortraitRules as unknown as ReturnType<typeof vi.fn>;

// ============================================================================
// runPipelineLoop tests
// ============================================================================
describe("runPipelineLoop", () => {
  const defaultSettings: PortraitSettings = {
    enabled: true,
    intervalMs: 300_000,
    startupDelayMs: 2000,
    ruleLimit: 200,
    model: null,
    thinkingLevel: "high" as const,
    maxTokens: 8192,
    timeoutMs: 180_000,
    retries: 3,
    buildingBatchSize: 1,
    maxAgeDays: 30,
    debugDumpLimit: 0,
    postExtractionEnabled: false,
    postExtractionModel: null,
    rateLimitMs: 0,
    maintenanceModel: null,
    maintenanceEveryNRulesInserted: 200,
    maintenanceBackfillBatchSize: 1,
    maintenanceMaxTokens: 0,
    maintenanceTimeoutMs: 3_600_000,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetPipelineState(); // Reset pendingBgScan for test isolation

    // Reset mock state counter
    globalMockState.rulesInsertedSinceMaintenance = 0;

    // Default: no more files after first scan
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });
    mockBuildPortrait.mockResolvedValue(undefined);
    mockReadPortrait.mockReturnValue(null);
    mockParsePortraitRules.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes one batch and returns stats", async () => {
    const stats = await runPipelineLoop(defaultSettings, Infinity, () => false);
    expect(stats.totalSequences).toBe(1);
    expect(mockScanSessions).toHaveBeenCalledTimes(1);
  });

  it("respects maxSequences limit", async () => {
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 5,
      triosProcessed: 1,
      totalKnownTrios: 10,
    });

    const stats = await runPipelineLoop(defaultSettings, 1, () => false);
    expect(stats.totalSequences).toBe(1);
    expect(mockScanSessions).toHaveBeenCalledTimes(1);
  });

  it("stops when shouldCancel returns true", async () => {
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 5,
      triosProcessed: 1,
      totalKnownTrios: 10,
    });

    const stats = await runPipelineLoop(defaultSettings, Infinity, () => true);
    expect(stats.totalSequences).toBe(0);
    expect(mockScanSessions).not.toHaveBeenCalled();
  });

  it("applies rate limit delay after extraction", async () => {
    const settingsWithRateLimit = { ...defaultSettings, rateLimitMs: 1000 };
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });

    const start = Date.now();
    const promise = runPipelineLoop(settingsWithRateLimit, Infinity, () => false);
    await vi.advanceTimersByTimeAsync(2000); // Fast-forward through delays
    const stats = await promise;
    const elapsed = Date.now() - start;
    expect(stats.totalSequences).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(1000); // At least 1s delay was applied
  }, 10000);

  it("resets progress counters before loop", async () => {
    await runPipelineLoop(defaultSettings, Infinity, () => false);
    const state = mockLoadPortraitState.mock.results[0]?.value;
    expect(state.totalKnownTrios).toBe(0);
    expect(state.triosProcessed).toBe(0);
    expect(state.scanSessionKB).toBe(0);
  });

  it("finalizes state to idle after loop", async () => {
    await runPipelineLoop(defaultSettings, Infinity, () => false);
    const state = mockLoadPortraitState.mock.results[0]?.value;
    expect(state.pipelinePhase).toBe("idle");
    expect(state.remainingFiles).toBe(0);
    expect(state.lastPipelineRun).toBeDefined();
    expect(state.lastScanTimestamp).toBeDefined();
  });

  it("does not rate limit when rateLimit is 0s", async () => {
    // With fake timers, if there's no delay, the promise resolves immediately
    const promise = runPipelineLoop(defaultSettings, Infinity, () => false);
    const stats = await promise;
    expect(stats.totalSequences).toBe(1);
  });

  it("spawns bg trio counter only once across multiple calls", async () => {
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });

    // Make the bg scan slow so pendingBgScan stays non-null during both calls
    let resolveBgScan: (() => void) | undefined;
    mockCountPendingTrios.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveBgScan = () => resolve();
      }),
    );

    const p1 = runPipelineLoop(defaultSettings, Infinity, () => false);
    const p2 = runPipelineLoop(defaultSettings, Infinity, () => false);
    // Both calls started before bg scan finished — only one spawn
    resolveBgScan?.();
    await p1;
    await p2;
    expect(mockCountPendingTrios).toHaveBeenCalledTimes(1);
  });

  it("counts totalInserted from buildPortrait result", async () => {
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });
    mockBuildPortrait.mockResolvedValue({ inserted: 2, evicted: 1, rules: [], evictedRules: [], droppedRules: [] });

    const stats = await runPipelineLoop(defaultSettings, Infinity, () => false);
    expect(stats.totalInserted).toBe(2);
    expect(stats.totalEvicted).toBe(1);
  });

  it("propagates errors from scanSessions", async () => {
    mockScanSessions.mockRejectedValue(new Error("scan failed"));

    await expect(runPipelineLoop(defaultSettings, Infinity, () => false)).rejects.toThrow("scan failed");
  });

  it("propagates errors from buildPortrait", async () => {
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });
    mockBuildPortrait.mockRejectedValue(new Error("build failed"));

    await expect(runPipelineLoop(defaultSettings, Infinity, () => false)).rejects.toThrow("build failed");
  });

  it("respects mid-loop cancellation", async () => {
    let callCount = 0;
    mockScanSessions.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
          remainingFiles: 2,
          triosProcessed: 1,
          totalKnownTrios: 3,
        });
      }
      return Promise.resolve({ results: [], remainingFiles: 0, triosProcessed: 0, totalKnownTrios: 0 });
    });
    mockParsePortraitRules.mockImplementation(() => []);
    mockBuildPortrait.mockResolvedValue(undefined);

    const cancelCb = () => {
      if (callCount >= 1) return true;
      return false;
    };

    const stats = await runPipelineLoop(defaultSettings, Infinity, cancelCb);
    expect(stats.totalSequences).toBe(1); // stopped after first iteration
  });

  it("preserves bg scan totalKnownTrios during finalization", async () => {
    mockCountPendingTrios.mockResolvedValue(42);
    mockScanSessions.mockResolvedValue({
      results: [],
      remainingFiles: 0,
      triosProcessed: 0,
      totalKnownTrios: 0,
    });

    await runPipelineLoop(defaultSettings, Infinity, () => false);

    // Advance timers to let bg scan microtask complete
    await vi.advanceTimersByTimeAsync(10);

    // totalKnownTrios should be 42 (set by bg scan, preserved by finalization)
    expect(globalMockState.totalKnownTrios).toBe(42);
  });

  it("increments rulesInsertedSinceMaintenance counter on buildPortrait", async () => {
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });
    mockBuildPortrait.mockResolvedValue({ inserted: 3, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });

    await runPipelineLoop(defaultSettings, Infinity, () => false);

    expect(globalMockState.rulesInsertedSinceMaintenance).toBe(3);
  });

  it("triggers auto-maintenance when counter reaches threshold", async () => {
    const mockRunMaintenance = runMaintenance as unknown as ReturnType<typeof vi.fn>;

    const settingsWithMaintenance = {
      ...defaultSettings,
      maintenanceEveryNRulesInserted: 5,
    };

    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });
    mockBuildPortrait.mockResolvedValue({ inserted: 6, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });

    await runPipelineLoop(settingsWithMaintenance, Infinity, () => false);

    expect(mockRunMaintenance).toHaveBeenCalledTimes(1);
  });

  it("does not trigger auto-maintenance when counter is below threshold", async () => {
    const mockRunMaintenance = runMaintenance as unknown as ReturnType<typeof vi.fn>;

    const settingsWithMaintenance = {
      ...defaultSettings,
      maintenanceEveryNRulesInserted: 10,
    };

    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });
    mockBuildPortrait.mockResolvedValue({ inserted: 3, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });

    await runPipelineLoop(settingsWithMaintenance, Infinity, () => false);

    expect(mockRunMaintenance).not.toHaveBeenCalled();
  });

  it("does not trigger auto-maintenance when maintenanceEveryNRulesInserted is 0", async () => {
    const mockRunMaintenance = runMaintenance as unknown as ReturnType<typeof vi.fn>;

    const settingsNoMaintenance = {
      ...defaultSettings,
      maintenanceEveryNRulesInserted: 0,
    };

    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });
    mockBuildPortrait.mockResolvedValue({ inserted: 100, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });

    await runPipelineLoop(settingsNoMaintenance, Infinity, () => false);

    expect(mockRunMaintenance).not.toHaveBeenCalled();
  });
});
