// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "../src/globals.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortraitState } from "../src/types.js";

// Mock llm-call before importing maintenance-core
vi.mock("../src/llm-call.js", () => ({
  callPortraitLlm: vi.fn(),
  PAUSED: Symbol("PAUSED"),
  setLlmProgressSink: vi.fn(),
  setDebugStreamSink: vi.fn(),
  makeDebugStreamDumpSink: vi.fn(() => vi.fn()),
  NO_LLM_PROGRESS_SINK: null,
  NO_DEBUG_STREAM_SINK: null,
}));

// Mock builder
vi.mock("../src/builder.js", () => ({
  buildPortrait: vi.fn(),
}));

// Mock config
vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...orig,
    getPortraitDir: () => mockPortraitDir,
  };
});

// Mock footer
vi.mock("../src/footer.js", () => ({
  setCachedPipelineState: vi.fn(),
}));

// Mock error
vi.mock("../src/error.js", () => ({
  reportError: vi.fn(),
}));

import { buildPortrait } from "../src/builder.js";
import { maintenance } from "../src/commands/maintenance.js";
import { setCachedPipelineState } from "../src/footer.js";
import * as gitNS from "../src/git.js";
import { initGit } from "../src/git.js";
import { callPortraitLlm, setDebugStreamSink, setLlmProgressSink } from "../src/llm-call.js";
import { runMaintenance } from "../src/maintenance-core.js";
import { loadPortraitState, savePortraitState } from "../src/storage.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";

const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;
const mockBuildPortrait = buildPortrait as unknown as ReturnType<typeof vi.fn>;
const mockSetCachedPipelineState = setCachedPipelineState as unknown as ReturnType<typeof vi.fn>;
const mockSetLlmProgressSink = setLlmProgressSink as unknown as ReturnType<typeof vi.fn>;
const mockSetDebugStreamSink = setDebugStreamSink as unknown as ReturnType<typeof vi.fn>;

let mockPortraitDir: string;

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `portrait-maint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeTestPortrait(dir: string, rules: string[]): void {
  const content = `# User Portrait\n\n## Anticipation Rules\n${rules.join("\n")}\n`;
  fs.writeFileSync(path.join(dir, "portrait.md"), content, "utf-8");
}

function readTestPortraitRules(dir: string): string[] {
  const content = fs.readFileSync(path.join(dir, "portrait.md"), "utf-8");
  const headerEnd = content.indexOf("## Anticipation Rules\n");
  if (headerEnd < 0) return [];
  const rulesSection = content.slice(headerEnd + "## Anticipation Rules\n".length);
  return rulesSection
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

describe("runMaintenance", () => {
  beforeEach(() => {
    mockPortraitDir = tmpDir();
    // Initialize git repo
    initGit(mockPortraitDir);
    vi.resetAllMocks();
    // Wire test settings (schema-derived defaults + test overrides); no real settings file.
    setupTestSettings({
      debugDumpLimit: 30,
      rateLimitMs: 0,
      maintenanceBackfillBatchSize: 1,
    });
  });

  afterEach(() => {
    teardownTestSettings();
    cleanup(mockPortraitDir);
  });

  it("returns message when portrait is empty (skips Phase 1)", async () => {
    writeTestPortrait(mockPortraitDir, []);
    const result = await runMaintenance(undefined);
    expect(result).toContain("Portrait is empty");
    expect(result).toContain("no evicted rules to backfill");
    // No LLM call for empty portrait
    expect(mockCallPortraitLlm).not.toHaveBeenCalled();
  });

  it("calls LLM for Phase 1 analysis with existing rules", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2", "rule 3"]);
    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1", "rule 3"],
      dropped: [2],
    });
    mockBuildPortrait.mockResolvedValue(undefined);

    const result = await runMaintenance(undefined);
    expect(result).toContain("1 rules dropped");
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(1);
  });

  it("validates portrait non-empty and rejects empty result", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    // First call returns empty portrait, second call returns valid result
    mockCallPortraitLlm
      .mockResolvedValueOnce({ portrait: [], dropped: [1, 2] })
      .mockResolvedValueOnce({ portrait: ["rule 1"], dropped: [2] });

    const result = await runMaintenance(undefined);
    expect(result).toContain("1 rules dropped");
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(2);
  });

  it("validates dropped rule numbers must be valid positions", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm
      .mockResolvedValueOnce({ portrait: ["rule 1"], dropped: [5] }) // out of range
      .mockResolvedValueOnce({ portrait: ["rule 1"], dropped: [2] });

    const result = await runMaintenance(undefined);
    expect(result).toContain("1 rules dropped");
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(2);
  });

  it("validates dropped rule numbers reject non-integers", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm
      .mockResolvedValueOnce({ portrait: ["rule 1"], dropped: [1.5] }) // non-integer
      .mockResolvedValueOnce({ portrait: ["rule 1"], dropped: [2] });

    const result = await runMaintenance(undefined);
    expect(result).toContain("1 rules dropped");
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(2);
  });

  it("dedupes repeated dropped rule numbers", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1"], dropped: [2, 2] });

    const result = await runMaintenance(undefined);
    expect(result).toContain("1 rules dropped");

    // Dropped file should contain rule 2 only once
    const droppedContent = fs.readFileSync(path.join(mockPortraitDir, "dropped.md"), "utf-8");
    const occurrences = droppedContent.split("rule 2").length - 1;
    expect(occurrences).toBe(1);
  });

  it("validates count invariant (portrait + dropped >= input)", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2", "rule 3"]);
    mockCallPortraitLlm
      .mockResolvedValueOnce({ portrait: ["rule 1"], dropped: [] }) // Missing 2 rules
      .mockResolvedValueOnce({ portrait: ["rule 1"], dropped: [2, 3] });

    const result = await runMaintenance(undefined);
    expect(result).toContain("2 rules dropped");
  });

  it("aborts Phase 1 when LLM returns undefined", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue(undefined);

    const result = await runMaintenance(undefined);
    expect(result).toContain("aborted");
    // Portrait unchanged
    const content = fs.readFileSync(path.join(mockPortraitDir, "portrait.md"), "utf-8");
    expect(content).toContain("rule 1");
  });

  it("resets rulesInsertedSinceMaintenance counter", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]);
    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1"],
      dropped: [],
    });

    // Set counter to non-zero
    const state = loadPortraitState(mockPortraitDir);
    state.rulesInsertedSinceMaintenance = 10;
    savePortraitState(mockPortraitDir, state);

    await runMaintenance(undefined);

    const afterState = loadPortraitState(mockPortraitDir);
    expect(afterState.rulesInsertedSinceMaintenance).toBe(0);
  });

  it("restores counter on Phase 1 abort", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue(undefined);

    // Set counter to non-zero
    const state = loadPortraitState(mockPortraitDir);
    state.rulesInsertedSinceMaintenance = 10;
    savePortraitState(mockPortraitDir, state);

    const result = await runMaintenance(undefined);
    expect(result).toContain("aborted");

    // Counter should be restored to original value
    const afterState = loadPortraitState(mockPortraitDir);
    expect(afterState.rulesInsertedSinceMaintenance).toBe(10);
  });

  it("sets lastMaintenanceRun timestamp", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]);
    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1"],
      dropped: [],
    });

    const before = new Date().toISOString();
    await runMaintenance(undefined);
    const after = new Date().toISOString();

    const state = loadPortraitState(mockPortraitDir);
    expect(state.lastMaintenanceRun).not.toBeNull();
    const lastRun = state.lastMaintenanceRun;
    if (lastRun !== null && lastRun !== undefined) {
      expect(lastRun >= before).toBe(true);
      expect(lastRun <= after).toBe(true);
    }
  });

  it("commits Phase 1 results to git (no backfill)", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1"],
      dropped: [2],
    });

    await runMaintenance(undefined);

    // No evicted rules → no backfill → last commit is the Phase 1 commit
    const log = execSync("git log -1 --format=%s", { cwd: mockPortraitDir }).toString().trim();
    expect(log).toContain("maintenance");
    expect(log).toContain("1 dropped");
    // Cleaned portrait is committed
    expect(readTestPortraitRules(mockPortraitDir)).toEqual(["rule 1"]);
  });

  it("commits Phase 1 before backfill starts (separate commits)", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    const evictedPath = path.join(mockPortraitDir, "evicted.md");
    fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted rule 1\n", "utf-8");

    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1"],
      dropped: [2],
    });

    // Backfill promotes one rule, then portrait is full enough to stop
    mockBuildPortrait.mockResolvedValueOnce({
      inserted: 1,
      evicted: 0,
      rules: ["rule 1", "evicted rule 1"],
      evictedRules: [],
      droppedRules: [],
    });

    await runMaintenance(undefined);

    // Should be TWO commits beyond the init commit: Phase 1 (cleaned) + backfill
    const log = execSync("git log --format=%s", { cwd: mockPortraitDir }).toString().trim();
    const lines = log.split("\n");
    // First line is HEAD (most recent) = backfill commit
    expect(lines[0]).toContain("backfill");
    // A Phase 1 'cleaned' commit exists below it
    const cleanedCommit = lines.find((l) => l.includes("cleaned"));
    expect(cleanedCommit).toBeDefined();
    expect(cleanedCommit).toContain("1 dropped");
  });

  it("Phase 1 commit persists when backfill batch fails", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2", "rule 3"]);
    const evictedPath = path.join(mockPortraitDir, "evicted.md");
    fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted rule 1\n", "utf-8");

    // Phase 1 drops rule 3
    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1", "rule 2"],
      dropped: [3],
    });

    // Backfill batch fails (buildPortrait returns undefined) → loop breaks
    mockBuildPortrait.mockResolvedValueOnce(undefined);

    await runMaintenance(undefined);

    // Even though backfill failed, Phase 1's cleaned portrait is committed
    const headPortrait = execSync("git show HEAD:portrait.md", { cwd: mockPortraitDir }).toString();
    expect(headPortrait).toContain("rule 1");
    expect(headPortrait).toContain("rule 2");
    expect(headPortrait).not.toContain("rule 3");
    // And the Phase 1 commit is in the log
    const log = execSync("git log --format=%s", { cwd: mockPortraitDir }).toString().trim();
    expect(log).toContain("cleaned");
  });

  it("gracefully stops backfill when buildPortrait throws PAUSED", async () => {
    // Regression: builder now throws "PAUSED" on user pause (used to return undefined).
    // Maintenance backfill must catch it and stop gracefully (restore batch) instead of
    // surfacing "Maintenance failed: PAUSED".
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2", "rule 3"]);
    const evictedPath = path.join(mockPortraitDir, "evicted.md");
    fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted rule 1\n", "utf-8");

    // Phase 1 succeeds (drops rule 3)
    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1", "rule 2"],
      dropped: [3],
    });

    // Backfill buildPortrait throws PAUSED (user paused from the retry dialog)
    mockBuildPortrait.mockRejectedValueOnce(new Error("PAUSED"));

    const result = await runMaintenance(undefined);

    // Maintenance completes gracefully (not "failed") — Phase 1 still committed
    expect(result).toContain("Maintenance complete");
    expect(result).not.toContain("failed");
    // The evicted batch was restored to the pool (not lost)
    const evictedContent = fs.readFileSync(evictedPath, "utf-8");
    expect(evictedContent).toContain("evicted rule 1");
  });

  // === Phase 2: Backfill tests ===

  it("promotes evicted rules in Phase 2 backfill", async () => {
    // This test asserts ONLY on the orchestration (return message + buildPortrait call count)
    // it does not read git state. runMaintenance issues 3 git commits (Phase 1 + 2× Phase 2) that
    // are pure overhead here (~9 git subprocesses). No-op commitPortrait to remove them; the file
    // writes (writePortrait/writeEvicted) still run and drive the loop logic. See.
    const commitSpy = vi.spyOn(gitNS, "commitPortrait").mockImplementation(() => true);
    try {
      writeTestPortrait(mockPortraitDir, ["rule 1"]);
      // Write evicted.md with rules to promote
      const evictedPath = path.join(mockPortraitDir, "evicted.md");
      fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted rule 1\n", "utf-8");

      mockCallPortraitLlm.mockResolvedValue({
        portrait: ["rule 1"],
        dropped: [],
      });

      // buildPortrait returns result for backfill (once only, then undefined = LLM fail)
      mockBuildPortrait.mockResolvedValueOnce({
        inserted: 1,
        evicted: 0,
        rules: ["rule 1", "evicted rule 1"],
        evictedRules: [],
        droppedRules: [],
      });

      const result = await runMaintenance(undefined);
      expect(result).toContain("1 promoted");
      expect(mockBuildPortrait).toHaveBeenCalledTimes(1);
    } finally {
      // Restore the real commitPortrait so subsequent git-asserting tests get real commits.
      commitSpy.mockRestore();
    }
  });

  it("puts mechanically evicted rules back into evicted pool", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]);
    const evictedPath = path.join(mockPortraitDir, "evicted.md");
    fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted rule 1\n", "utf-8");

    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1"],
      dropped: [],
    });

    // buildPortrait returns result that fills portrait to ruleLimit (200),
    // mechanically evicting one rule back to the pool
    const fullRules = ["rule 1", "evicted rule 1", ...Array.from({ length: 198 }, (_, i) => `filler ${i}`)];
    mockBuildPortrait.mockResolvedValueOnce({
      inserted: 1,
      evicted: 1,
      rules: fullRules,
      evictedRules: ["mechanically evicted"],
      droppedRules: [],
    });
    // Second call: no more free slots, portrait is at limit
    mockBuildPortrait.mockResolvedValueOnce({
      inserted: 0,
      evicted: 0,
      rules: fullRules,
      evictedRules: [],
      droppedRules: [],
    });

    await runMaintenance(undefined);

    // Remaining evicted.md should contain the mechanically evicted rule
    const content = fs.readFileSync(evictedPath, "utf-8");
    expect(content).toContain("mechanically evicted");
  });

  it("skips Phase 2 when no evicted rules exist", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]);
    // evicted.md only has header (created by initGit)

    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1"],
      dropped: [],
    });

    await runMaintenance(undefined);
    expect(mockBuildPortrait).not.toHaveBeenCalled();
  });

  it("stops backfill when collectCancelled is set", async () => {
    globalThis.__piPortrait = { collectCancelled: false } as PortraitState;
    writeTestPortrait(mockPortraitDir, ["rule 1"]);
    const evictedPath = path.join(mockPortraitDir, "evicted.md");
    fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted 1\nevicted 2\n", "utf-8");

    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1"],
      dropped: [],
    });

    // First batch succeeds and sets cancel flag, then undefined to stop
    let callCount = 0;
    mockBuildPortrait.mockImplementation(async () => {
      callCount++;
      if (callCount >= 1) {
        const state = globalThis.__piPortrait;
        if (state) state.collectCancelled = true;
      }
      return {
        inserted: 1,
        evicted: 0,
        rules: ["rule 1", "evicted 1"],
        evictedRules: ["evicted 2"],
        droppedRules: [],
      };
    });

    await runMaintenance(undefined);
    // Should have called buildPortrait once then stopped via cancel
    expect(mockBuildPortrait).toHaveBeenCalledTimes(1);
    delete globalThis.__piPortrait;
  });

  it("sets footer status to analyzing N rules during Phase 1", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2", "rule 3"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1", "rule 2", "rule 3"], dropped: [] });

    await runMaintenance(undefined);

    // setCachedPipelineState called with phase 'maintaining' and analyzing text (N=3)
    const analyzingCall = mockSetCachedPipelineState.mock.calls.find(
      ([ps]) => ps.pipelinePhase === "maintaining" && ps.maintenanceStatus === "analyzing 3 rules...",
    );
    expect(analyzingCall).toBeDefined();
  });

  it("sets footer status to backfilling M rules during Phase 2 (M = min(slots, evicted))", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]); // 1 rule, ruleLimit=200 → 199 free slots
    const evictedPath = path.join(mockPortraitDir, "evicted.md");
    fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted 1\nevicted 2\n", "utf-8"); // 2 evicted

    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1"], dropped: [] });
    mockBuildPortrait.mockResolvedValue({
      inserted: 2,
      evicted: 0,
      rules: ["rule 1", "evicted 1", "evicted 2"],
      evictedRules: [],
      droppedRules: [],
    });

    await runMaintenance(undefined);

    // M = min(199, 2) = 2
    const backfillCall = mockSetCachedPipelineState.mock.calls.find(
      ([ps]) => ps.pipelinePhase === "maintaining" && ps.maintenanceStatus === "backfilling 2 rules...",
    );
    expect(backfillCall).toBeDefined();

    // Phase 2 buildPortrait called with maintenanceMaxTokens (default 0 → null)
    const buildOpts = mockBuildPortrait.mock.calls[0]?.[2];
    expect(buildOpts?.maxTokensOverride).toBeNull();
    // ...and maintenanceTimeout (default '1h' → 60*60*1000 ms)
    expect(buildOpts?.timeoutOverride).toBe(60 * 60 * 1000);
  });

  it("resets footer phase to idle on completion", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1"], dropped: [] });

    await runMaintenance(undefined);

    // Final setCachedPipelineState call must reset phase to idle and clear status
    const lastCall = mockSetCachedPipelineState.mock.calls.at(-1)?.[0];
    expect(lastCall.pipelinePhase).toBe("idle");
    expect(lastCall.maintenanceStatus).toBe("");
  });

  it("resets footer phase to idle on Phase 1 abort", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue(undefined); // forces abort

    await runMaintenance(undefined);

    const lastCall = mockSetCachedPipelineState.mock.calls.at(-1)?.[0];
    expect(lastCall.pipelinePhase).toBe("idle");
    expect(lastCall.maintenanceStatus).toBe("");
  });

  it("skips Phase 1 analysis when shouldCancel is true at entry", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1", "rule 2"], dropped: [] });

    await runMaintenance(() => true); // cancelled before start

    // Phase 1 LLM call skipped entirely
    expect(mockCallPortraitLlm).not.toHaveBeenCalled();
  });

  it("maintenance command wrapper threads shouldCancel into runMaintenance", async () => {
    // Set up globals required by the wrapper
    globalThis.__piPortrait = { collectCancelled: false } as PortraitState;
    globalThis.__piPortraitAcquireCollectLock = () => Promise.resolve(true);
    globalThis.__piPortraitReleaseCollectLock = () => Promise.resolve();
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1", "rule 2"], dropped: [] });

    // shouldCancel=true → Phase 1 skipped
    await maintenance(() => true);
    expect(mockCallPortraitLlm).not.toHaveBeenCalled();

    delete globalThis.__piPortrait;
    delete globalThis.__piPortraitAcquireCollectLock;
    delete globalThis.__piPortraitReleaseCollectLock;
  });

  it("installs a progress sink that updates footer with token/word count", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2", "rule 3"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1", "rule 2", "rule 3"], dropped: [] });

    await runMaintenance(undefined);

    // runMaintenance installed a sink (non-null) and cleared it on exit (null)
    const installedSinks = mockSetLlmProgressSink.mock.calls.map((c) => c[0]);
    expect(installedSinks.length).toBeGreaterThanOrEqual(2);
    expect(installedSinks[0]).toBeTypeOf("function");
    expect(installedSinks.at(-1)).toBeNull();

    // Invoking the installed sink updates the footer status with token/word counts
    const sink = installedSinks[0] as (info: { tokens: number; words: number }) => void;
    sink({ tokens: 150, words: 42 });
    const updated = mockSetCachedPipelineState.mock.calls.at(-1)?.[0];
    expect(updated.pipelinePhase).toBe("maintaining");
    expect(updated.llmTokens).toBe(150);
    expect(updated.llmWords).toBe(42);
  });

  it("writes a maintenance debug dump with input + output", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1"], dropped: [2] });

    await runMaintenance(undefined);

    // A maintenance-<ts>.txt dump file exists in the debug dir
    const debugDir = path.join(mockPortraitDir, "debug");
    const files = fs.readdirSync(debugDir).filter((f) => f.startsWith("maintenance-"));
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(debugDir, files[0]), "utf-8");
    // Input section includes the prompt + numbered portrait
    expect(content).toContain("=== Maintenance Input (2 rules) ===");
    expect(content).toContain("1. rule 1");
    expect(content).toContain("2. rule 2");
    // Output section includes the parsed portrait + dropped
    expect(content).toContain("=== Maintenance Output ===");
    expect(content).toContain("rule 1");
    expect(content).toContain("rule 2");
  });

  it("installs and clears a debug stream sink around Phase 1", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1", "rule 2"], dropped: [] });

    await runMaintenance(undefined);

    const sinkCalls = mockSetDebugStreamSink.mock.calls.map((c) => c[0]);
    // First call installs a function, last call clears with null
    expect(sinkCalls[0]).toBeTypeOf("function");
    expect(sinkCalls.at(-1)).toBeNull();
  });

  it("passes a backfill debug dump path to buildPortrait", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]); // 1 rule, ruleLimit=200 → free slots
    const evictedPath = path.join(mockPortraitDir, "evicted.md");
    fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted 1\n", "utf-8");

    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1"], dropped: [] });
    mockBuildPortrait.mockResolvedValue({
      inserted: 1,
      evicted: 0,
      rules: ["rule 1", "evicted 1"],
      evictedRules: [],
      droppedRules: [],
    });

    await runMaintenance(undefined);

    // buildPortrait received a debugDumpPath pointing at a backfill-*.txt file
    const buildOpts = mockBuildPortrait.mock.calls[0]?.[2];
    expect(buildOpts?.debugDumpPath).toMatch(/backfill-.*\.txt$/);
  });

  it("Phase 1 passes maintenanceMaxTokens (default 0 → null = no cap)", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1", "rule 2"], dropped: [] });

    await runMaintenance(undefined);

    // 7th arg (index 6) is maxTokensOverride — default maintenanceMaxTokens=0 → null
    const phase1Call = mockCallPortraitLlm.mock.calls[0];
    expect(phase1Call[6]).toBeNull();
  });

  it("Phase 1 passes maintenanceTimeout (default 1h → 60*60*1000 ms)", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1", "rule 2"], dropped: [] });

    await runMaintenance(undefined);

    // 8th arg (index 7) is timeoutOverride — default maintenanceTimeoutMs=3_600_000 → 60*60*1000 ms
    const phase1Call = mockCallPortraitLlm.mock.calls[0];
    expect(phase1Call[7]).toBe(60 * 60 * 1000);
  });

  it("Phase 1 threads configured maintenanceMaxTokens and maintenanceTimeout", async () => {
    setupTestSettings({
      rateLimitMs: 0,
      maintenanceBackfillBatchSize: 1,
      maintenanceMaxTokens: 50000,
      maintenanceTimeoutMs: 12 * 60 * 1000,
    });
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);
    mockCallPortraitLlm.mockResolvedValue({ portrait: ["rule 1", "rule 2"], dropped: [] });

    await runMaintenance(undefined);

    const phase1Call = mockCallPortraitLlm.mock.calls[0];
    expect(phase1Call[6]).toBe(50000); // maintenanceMaxTokens flows through
    expect(phase1Call[7]).toBe(12 * 60 * 1000); // 12m in ms
  });

  it("shrinks portrait when LLM identifies duplicates and drops them", async () => {
    // Portrait has 4 rules, 2 are duplicates
    writeTestPortrait(mockPortraitDir, ["rule a", "rule b", "rule a duplicate", "rule b duplicate"]);

    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule a", "rule b"],
      dropped: [3, 4],
    });

    const result = await runMaintenance(undefined);

    // Result should report 2 rules dropped
    expect(result).toContain("2 rules dropped");

    // Portrait should now have only the 2 kept rules
    const portrait = readTestPortraitRules(mockPortraitDir);
    expect(portrait).toEqual(["rule a", "rule b"]);

    // Dropped file should contain the 2 duplicates
    const droppedPath = path.join(mockPortraitDir, "dropped.md");
    const droppedContent = fs.readFileSync(droppedPath, "utf-8");
    expect(droppedContent).toContain("rule a duplicate");
    expect(droppedContent).toContain("rule b duplicate");
  });

  it("aborts Phase 1 without modifying portrait when all validation retries fail", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);

    // All 3 validation attempts return empty portrait (invalid)
    mockCallPortraitLlm.mockResolvedValue({ portrait: [], dropped: [1, 2] });

    const result = await runMaintenance(undefined);

    // Portrait should remain unchanged
    const portrait = readTestPortraitRules(mockPortraitDir);
    expect(portrait).toEqual(["rule 1", "rule 2"]);

    // Should report abort
    expect(result).toContain("aborted");
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(3);
  });

  it("aborts Phase 1 cleanly when LLM returns PAUSED", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1", "rule 2"]);

    const { PAUSED: PAUSED_SYMBOL } = await import("../src/llm-call.js");
    mockCallPortraitLlm.mockResolvedValue(PAUSED_SYMBOL);

    const result = await runMaintenance(undefined);

    // Portrait should remain unchanged
    const portrait = readTestPortraitRules(mockPortraitDir);
    expect(portrait).toEqual(["rule 1", "rule 2"]);

    // Should report abort
    expect(result).toContain("aborted");
  });

  it("restores evicted rules to pool and stops backfill when buildPortrait fails", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]);
    const evictedPath = path.join(mockPortraitDir, "evicted.md");
    fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted 1\nevicted 2\n", "utf-8");

    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1"],
      dropped: [],
    });

    // buildPortrait fails — loop should break, restoring the batch
    mockBuildPortrait.mockResolvedValueOnce(undefined);

    await runMaintenance(undefined);

    // Both evicted rules should still be in evicted.md (restored, loop stopped)
    const evictedContent = fs.readFileSync(evictedPath, "utf-8");
    expect(evictedContent).toContain("evicted 1");
    expect(evictedContent).toContain("evicted 2");
    // buildPortrait should only have been called once (broke out of loop)
    expect(mockBuildPortrait).toHaveBeenCalledTimes(1);
  });

  it("runs Phase 1 shrink then Phase 2 backfill end-to-end", async () => {
    // Portrait at ruleLimit with 3 rules, 1 is a duplicate
    writeTestPortrait(mockPortraitDir, ["rule a", "rule b", "rule a dup"]);
    const evictedPath = path.join(mockPortraitDir, "evicted.md");
    fs.writeFileSync(evictedPath, "# Evicted Portrait Rules\nevicted 1\n", "utf-8");

    // Phase 1: LLM drops the duplicate
    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule a", "rule b"],
      dropped: [3],
    });

    // Phase 2: backfill promotes evicted 1 into the freed slot
    mockBuildPortrait.mockResolvedValueOnce({
      inserted: 1,
      evicted: 0,
      rules: ["rule a", "rule b", "evicted 1"],
      evictedRules: [],
      droppedRules: [],
    });

    const result = await runMaintenance(undefined);

    // Phase 1 dropped 1 rule
    expect(result).toContain("1 rules dropped");
    // Phase 2 promoted 1 rule
    expect(result).toContain("1 promoted");

    // Portrait should have original 2 + promoted 1
    const portrait = readTestPortraitRules(mockPortraitDir);
    expect(portrait).toEqual(["rule a", "rule b", "evicted 1"]);

    // Dropped should have the duplicate
    const droppedPath = path.join(mockPortraitDir, "dropped.md");
    const droppedContent = fs.readFileSync(droppedPath, "utf-8");
    expect(droppedContent).toContain("rule a dup");

    // Evicted should be empty (promoted)
    const evictedContent = fs.readFileSync(evictedPath, "utf-8");
    expect(evictedContent).not.toContain("evicted 1");
  });
});

describe("maintenance command wrapper", () => {
  let savedGlobal: PortraitState | undefined;
  let savedAcquire: (() => Promise<boolean>) | undefined;
  let savedRelease: (() => void) | undefined;

  beforeEach(() => {
    mockPortraitDir = tmpDir();
    initGit(mockPortraitDir);
    vi.resetAllMocks();

    // Save and set up globals
    savedGlobal = globalThis.__piPortrait;
    savedAcquire = globalThis.__piPortraitAcquireCollectLock;
    savedRelease = globalThis.__piPortraitReleaseCollectLock;
    setupTestSettings({ debugDumpLimit: 0, rateLimitMs: 0 });
  });

  afterEach(() => {
    teardownTestSettings();
    cleanup(mockPortraitDir);
    globalThis.__piPortrait = savedGlobal;
    globalThis.__piPortraitAcquireCollectLock = savedAcquire;
    globalThis.__piPortraitReleaseCollectLock = savedRelease;
  });

  it("returns unavailable message when state is missing", async () => {
    delete globalThis.__piPortrait;
    delete globalThis.__piPortraitAcquireCollectLock;
    delete globalThis.__piPortraitReleaseCollectLock;

    const result = await maintenance(undefined);
    expect(result).toContain("not available");
  });

  it("returns unavailable message when lock functions are missing", async () => {
    globalThis.__piPortrait = {} as PortraitState;
    delete globalThis.__piPortraitAcquireCollectLock;
    delete globalThis.__piPortraitReleaseCollectLock;

    const result = await maintenance(undefined);
    expect(result).toContain("not available");
  });

  it("returns busy message when lock acquisition fails", async () => {
    globalThis.__piPortrait = {} as PortraitState;
    globalThis.__piPortraitAcquireCollectLock = () => Promise.resolve(false);
    globalThis.__piPortraitReleaseCollectLock = () => Promise.resolve();

    const result = await maintenance(undefined);
    expect(result).toContain("already in progress");
  });

  it("acquires lock, runs maintenance, releases lock on success", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]);
    let lockReleased = false;

    globalThis.__piPortrait = { collectCancelled: false } as PortraitState;
    globalThis.__piPortraitAcquireCollectLock = () => Promise.resolve(true);
    globalThis.__piPortraitReleaseCollectLock = () => {
      lockReleased = true;
    };

    mockCallPortraitLlm.mockResolvedValue({
      portrait: ["rule 1"],
      dropped: [],
    });

    const result = await maintenance(undefined);
    expect(result).toContain("Maintenance complete");
    expect(lockReleased).toBe(true);
    // Reset collectCancelled
    delete globalThis.__piPortrait;
  });

  it("releases lock and returns error when runMaintenance throws", async () => {
    writeTestPortrait(mockPortraitDir, ["rule 1"]);
    let lockReleased = false;

    globalThis.__piPortrait = { collectCancelled: false } as PortraitState;
    globalThis.__piPortraitAcquireCollectLock = () => Promise.resolve(true);
    globalThis.__piPortraitReleaseCollectLock = () => {
      lockReleased = true;
    };

    // Force an error by making callPortraitLlm throw
    mockCallPortraitLlm.mockImplementationOnce(() => {
      throw new Error("test error");
    });

    const result = await maintenance(undefined);
    expect(result).toContain("failed");
    expect(lockReleased).toBe(true);
  });
});
