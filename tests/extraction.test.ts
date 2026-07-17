// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for enriched extraction with interaction summary.
 *
 * These tests verify that the extraction pipeline correctly:
 * 1. Produces a summary alongside rules
 * 2. Forwards the summary to post-extraction
 * 3. Writes summary fields to the debug dump
 * 4. Handles edge cases (empty rules, failed extraction, missing summary)
 *
 * Approach: Mock callPortraitLlm from llm-call.ts to control what
 * callExtractionLlm and postExtractRules return, then verify via
 * the debug dump file output.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "../src/config.js";
import { initGit } from "../src/git.js";

// config.js and llm-call.js are mocked centrally in tests/setup.ts (one stable identity per stubbed
// function), so this file does not declare competing mocks. git (and every other stubbable module)
// is also centralized there with a flag-gated stub; extraction opts into the git stub (the git
// audit layer is irrelevant here — these tests assert on the debug dump, not commit messages) and
// otherwise runs against the real collector/builder/footer/error.

import { scanSessions } from "../src/collector.js";
// Import after mocks
import { callPortraitLlm } from "../src/llm-call.js";
import type { PortraitPipelineState } from "../src/types.js";
import { DEFAULT_PIPELINE_STATE } from "../src/types.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { setTestConfig, useStubs } from "./setup.js";

const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;

// Helper to create a session file with a valid trio
function createSessionFile(
  sessionDir: string,
  filename: string,
  trios: Array<{ assistant1: string; user: string; assistant2: string }>,
): string {
  const filePath = path.join(sessionDir, filename);
  const lines: string[] = [];

  for (const trio of trios) {
    // Assistant message
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: trio.assistant1 }],
          timestamp: Date.now(),
        },
      }),
    );
    // User message
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: trio.user }],
          timestamp: Date.now(),
        },
      }),
    );
    // Next assistant message (completes the trio)
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: trio.assistant2 }],
          timestamp: Date.now(),
        },
      }),
    );
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `portrait-extraction-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  initGit(dir);
  return dir;
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function getDefaultState(): PortraitPipelineState {
  return { ...DEFAULT_PIPELINE_STATE };
}

describe("enriched extraction summary", () => {
  // Coverage note: The summary validation in the return_extraction tool's
  // execute callback (collector.ts) is NOT directly exercised by these
  // tests. All tests mock callPortraitLlm at the module level, which sits
  // above the tool's execute callback — so the summary-presence gate that
  // triggers retry-on-missing-summary is bypassed. The design explicitly
  // decided against extracting a validation helper (the validation is
  // inline in a nested closure), so this gate can only be exercised
  // through the full agent framework. These tests instead verify the
  // observable outcomes: summary data flows into the dump, reaches the
  // post-extraction prompt, and failed extraction produces a clean (none)
  // dump entry.
  let portraitDir: string;
  let sessionDir: string;

  beforeEach(() => {
    portraitDir = tmpDir();
    // Stub git so no real `git` subprocess runs during initGit.
    useStubs({ git: true });
    // Redirect the central config mock to this file's temp portrait dir.
    setTestConfig({ portraitDir });

    // Create session directory structure: sessions/project/session.jsonl
    sessionDir = path.join(portraitDir, "sessions", "test-project");
    fs.mkdirSync(sessionDir, { recursive: true });

    // Override getSessionDirs to return our test session dir
    const parentDir = path.join(portraitDir, "sessions");
    vi.spyOn(config, "getSessionDirs").mockReturnValue([parentDir]);

    // Default: post-extraction enabled (hermetic — don't depend on real settings file)
    setupTestSettings({
      debugDumpLimit: 30,
      postExtractionEnabled: true,
    });

    mockCallPortraitLlm.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestSettings();
    cleanup(portraitDir);
  });

  it("handles empty rules with valid summary gracefully", async () => {
    // Create a session file with a trio
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will implement the feature by creating a new module.",
        user: "Good approach, but also add error handling.",
        assistant2: "I have added error handling to the module.",
      },
    ]);

    // Mock: extraction returns empty notes but valid summary
    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: [],
      summary: {
        agentBefore: "Agent implemented a new module",
        userFeedback: "User asked to add error handling",
        agentAfter: "Agent added error handling",
      },
    });

    const result = await scanSessions(portraitDir, getDefaultState(), 10, 100);

    // Should complete without error and return empty results
    expect(result.results).toEqual([]);
    expect(result.triosProcessed).toBe(0);

    // Verify the dump file was created
    const debugDir = path.join(portraitDir, "debug");
    expect(fs.existsSync(debugDir)).toBe(true);
    const dumpFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("extraction-"));
    expect(dumpFiles.length).toBe(1);

    const dumpContent = fs.readFileSync(path.join(debugDir, dumpFiles[0]), "utf-8");
    // Should have extraction output with summary but no rules
    expect(dumpContent).toContain("Agent before: Agent implemented a new module");
    expect(dumpContent).toContain("User feedback: User asked to add error handling");
    expect(dumpContent).toContain("Agent after: Agent added error handling");
    expect(dumpContent).toContain("Rules:\n(none)");
    // Should NOT have post-extraction output (skipped because notes is empty)
    expect(dumpContent).not.toContain("=== Post-Extraction Output ===");
  });

  it("includes summary data in dump and forwards it to post-extraction prompt", async () => {
    // Create a session file with a trio
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will search for existing patterns in the codebase.",
        user: "Search first before creating new implementations.",
        assistant2: "I searched and found an existing pattern to adapt.",
      },
    ]);

    // Mock: extraction returns rules with summary
    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: ["Search for and adapt established patterns across the codebase"],
      summary: {
        agentBefore: "Agent was about to create a new implementation",
        userFeedback: "User told agent to search first",
        agentAfter: "Agent searched and found existing pattern to adapt",
      },
    });
    // Mock: post-extraction returns validated rules
    mockCallPortraitLlm.mockResolvedValueOnce(["Search for and adapt established patterns across the codebase"]);

    const result = await scanSessions(portraitDir, getDefaultState(), 10, 100);

    // Should return the validated rule
    expect(result.results.length).toBe(1);
    expect(result.results[0].behaviorNotes).toEqual(["Search for and adapt established patterns across the codebase"]);

    // Verify the dump file
    const debugDir = path.join(portraitDir, "debug");
    const dumpFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("extraction-"));
    const dumpContent = fs.readFileSync(path.join(debugDir, dumpFiles[0]), "utf-8");

    // Should have extraction output with summary fields
    expect(dumpContent).toContain("=== Extraction Agent Output ===");
    expect(dumpContent).toContain("Agent before: Agent was about to create a new implementation");
    expect(dumpContent).toContain("User feedback: User told agent to search first");
    expect(dumpContent).toContain("Agent after: Agent searched and found existing pattern to adapt");
    expect(dumpContent).toContain("Rules:\nSearch for and adapt established patterns across the codebase");

    // Should also have post-extraction output (proving summary was forwarded)
    expect(dumpContent).toContain("=== Post-Extraction Input ===");
    expect(dumpContent).toContain("=== Post-Extraction Output ===");
    expect(dumpContent).toContain("Search for and adapt established patterns across the codebase");

    // Verify the summary reached the post-extraction prompt by inspecting
    // the second callPortraitLlm call (post-extraction). The system prompt
    // is the second argument; it should NOT contain the summary. But the
    // messages (first argument) contain the prompt with the interaction tags.
    const postExtractionCall = mockCallPortraitLlm.mock.calls[1];
    expect(postExtractionCall).toBeDefined();
    const messages = postExtractionCall[0] as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    const promptText = messages[0].content[0].text;
    // The interaction tags with summary fields must be in the prompt
    expect(promptText).toContain("<agent-before>");
    expect(promptText).toContain("Agent was about to create a new implementation");
    expect(promptText).toContain("<user-feedback>");
    expect(promptText).toContain("User told agent to search first");
    expect(promptText).toContain("<agent-after>");
    expect(promptText).toContain("Agent searched and found existing pattern to adapt");
    // The rules must also be in the prompt (unnumbered, inside <rules> tags)
    expect(promptText).toContain("<rules>");
    expect(promptText).toContain("Search for and adapt established patterns across the codebase");
    expect(promptText).not.toContain("R1:");

    // When postExtractionModel is empty (default), the 6th arg (modelOverride)
    // should be undefined so callPortraitLlm falls back to the default model
    const modelOverride = postExtractionCall[5];
    expect(modelOverride).toBeUndefined();
  });

  it("writes summary to debug dump on successful extraction", async () => {
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I am implementing the database migration.",
        user: "Make sure to backup before running migrations.",
        assistant2: "I backed up the database and ran the migration.",
      },
    ]);

    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: ["Always backup before running database migrations"],
      summary: {
        agentBefore: "Agent was implementing database migration",
        userFeedback: "User said to backup before migrations",
        agentAfter: "Agent backed up and ran migration",
      },
    });
    mockCallPortraitLlm.mockResolvedValueOnce(["Always backup before running database migrations"]);

    await scanSessions(portraitDir, getDefaultState(), 10, 100);

    const debugDir = path.join(portraitDir, "debug");
    const dumpFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("extraction-"));
    const dumpContent = fs.readFileSync(path.join(debugDir, dumpFiles[0]), "utf-8");

    // Verify the exact dump format
    expect(dumpContent).toContain("=== Extraction Agent Output ===");
    expect(dumpContent).toMatch(/Agent before: Agent was implementing database migration/);
    expect(dumpContent).toMatch(/User feedback: User said to backup before migrations/);
    expect(dumpContent).toMatch(/Agent after: Agent backed up and ran migration/);
    expect(dumpContent).toMatch(/Rules:\nAlways backup before running database migrations/);
  });

  it("writes (none) to debug dump on failed extraction", async () => {
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will refactor the module.",
        user: "Use dependency injection instead.",
        assistant2: "I refactored using dependency injection.",
      },
    ]);

    // Mock: extraction returns undefined (all retries failed)
    mockCallPortraitLlm.mockResolvedValue(undefined);

    const result = await scanSessions(portraitDir, getDefaultState(), 10, 100);

    // Should complete without error, no results
    expect(result.results).toEqual([]);

    // Verify the dump file shows failure
    const debugDir = path.join(portraitDir, "debug");
    const dumpFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("extraction-"));
    const dumpContent = fs.readFileSync(path.join(debugDir, dumpFiles[0]), "utf-8");

    expect(dumpContent).toContain("=== Extraction Agent Output ===");
    expect(dumpContent).toContain("(none)");
    expect(dumpContent).not.toContain("Agent before:");
  });

  it("handles post-extraction dropping all rules", async () => {
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will add a comment to explain the code.",
        user: "Remove the comment, the code is self-explanatory.",
        assistant2: "I removed the comment.",
      },
    ]);

    // Mock: extraction returns rules with valid summary
    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: ["Always add comments to explain code"],
      summary: {
        agentBefore: "Agent was about to add explanatory comments",
        userFeedback: "User said the code is self-explanatory",
        agentAfter: "Agent removed the comment",
      },
    });
    // Mock: post-extraction drops all rules (returns empty array)
    mockCallPortraitLlm.mockResolvedValueOnce([]);

    const result = await scanSessions(portraitDir, getDefaultState(), 10, 100);

    // Should complete without error, no results (all rules dropped)
    expect(result.results).toEqual([]);

    // Verify dump has BOTH extraction output (with summary) AND
    // post-extraction output (with (none) since all rules were dropped)
    const debugDir = path.join(portraitDir, "debug");
    const dumpFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("extraction-"));
    const dumpContent = fs.readFileSync(path.join(debugDir, dumpFiles[0]), "utf-8");

    // Extraction output section with summary fields
    expect(dumpContent).toContain("=== Extraction Agent Output ===");
    expect(dumpContent).toContain("Agent before: Agent was about to add explanatory comments");
    expect(dumpContent).toContain("User feedback: User said the code is self-explanatory");
    expect(dumpContent).toContain("Agent after: Agent removed the comment");
    expect(dumpContent).toContain("Rules:\nAlways add comments to explain code");

    // Post-extraction output section showing all rules dropped
    expect(dumpContent).toContain("=== Post-Extraction Output ===");
    expect(dumpContent).toContain("(none)");
  });

  it("skips post-extraction step when postExtractionEnabled is false", async () => {
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will add error handling to the function.",
        user: "Also log the errors.",
        assistant2: "I added error handling and logging.",
      },
    ]);

    // Override settings to disable post-extraction
    setupTestSettings({
      debugDumpLimit: 30,
      postExtractionEnabled: false,
    });

    // Mock: extraction returns rules with summary
    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: ["Add error handling and logging to functions"],
      summary: {
        agentBefore: "Agent was about to add error handling",
        userFeedback: "User said to also log errors",
        agentAfter: "Agent added error handling and logging",
      },
    });

    const result = await scanSessions(portraitDir, getDefaultState(), 10, 100);

    // Rules pass through directly (no post-extraction validation)
    expect(result.results.length).toBe(1);
    expect(result.results[0].behaviorNotes).toEqual(["Add error handling and logging to functions"]);

    // Only 1 LLM call (extraction only, no post-extraction)
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(1);

    // Dump should have extraction output but NO post-extraction output
    const debugDir = path.join(portraitDir, "debug");
    const dumpFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("extraction-"));
    const dumpContent = fs.readFileSync(path.join(debugDir, dumpFiles[0]), "utf-8");

    expect(dumpContent).toContain("=== Extraction Agent Output ===");
    expect(dumpContent).not.toContain("=== Post-Extraction Output ===");
  });

  it("forwards postExtractionModel override to callPortraitLlm", async () => {
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will write unit tests for the module.",
        user: "Also test edge cases.",
        assistant2: "I added edge case tests.",
      },
    ]);

    // Override settings to set a custom post-extraction model
    setupTestSettings({
      debugDumpLimit: 30,
      postExtractionEnabled: true,
      postExtractionModel: "anthropic/claude-3.5-haiku",
    });

    // Mock: extraction returns rules with summary
    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: ["Test edge cases alongside happy paths"],
      summary: {
        agentBefore: "Agent was writing unit tests",
        userFeedback: "User said to test edge cases",
        agentAfter: "Agent added edge case tests",
      },
    });
    // Mock: post-extraction returns validated rules
    mockCallPortraitLlm.mockResolvedValueOnce(["Test edge cases alongside happy paths"]);

    await scanSessions(portraitDir, getDefaultState(), 10, 100);

    // The second callPortraitLlm call (post-extraction) should have
    // the modelOverride as its 6th argument
    const postExtractionCall = mockCallPortraitLlm.mock.calls[1];
    expect(postExtractionCall).toBeDefined();
    // callPortraitLlm signature: (messages, systemPrompt, tool, resultExtractor, errorContext, modelOverride)
    const modelOverride = postExtractionCall[5];
    expect(modelOverride).toBe("anthropic/claude-3.5-haiku");
  });

  it("forwards multiple rules to post-extraction joined with newlines", async () => {
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will add input validation and error handling.",
        user: "Also add logging for all validation failures.",
        assistant2: "I added validation, error handling, and logging.",
      },
    ]);

    // Mock: extraction returns MULTIPLE rules with summary
    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: ["Validate all user inputs at function boundaries", "Log validation failures with context for debugging"],
      summary: {
        agentBefore: "Agent was adding input validation",
        userFeedback: "User said to add logging too",
        agentAfter: "Agent added validation and logging",
      },
    });
    // Mock: post-extraction returns both rules validated
    mockCallPortraitLlm.mockResolvedValueOnce([
      "Validate all user inputs at function boundaries",
      "Log validation failures with context for debugging",
    ]);

    const result = await scanSessions(portraitDir, getDefaultState(), 10, 100);

    // Both rules should pass through
    expect(result.results.length).toBe(1);
    expect(result.results[0].behaviorNotes).toEqual([
      "Validate all user inputs at function boundaries",
      "Log validation failures with context for debugging",
    ]);

    // Verify both rules appear in the post-extraction prompt inside <rules> tags
    const postExtractionCall = mockCallPortraitLlm.mock.calls[1];
    expect(postExtractionCall).toBeDefined();
    const messages = postExtractionCall[0] as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    const promptText = messages[0].content[0].text;
    expect(promptText).toContain("<rules>");
    expect(promptText).toContain("Validate all user inputs at function boundaries");
    expect(promptText).toContain("Log validation failures with context for debugging");
    expect(promptText).toContain("</rules>");
  });

  it("extracts multiple trios from a single session file", async () => {
    // Two independent trios in one session file
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will write the function without validation.",
        user: "Always validate inputs at function boundaries.",
        assistant2: "I added input validation to the function.",
      },
      {
        assistant1: "I will use a synchronous file read here.",
        user: "Prefer async I/O to avoid blocking the event loop.",
        assistant2: "I switched to async file reads.",
      },
    ]);

    // Mock: interleaved extraction + post-extraction per trio
    // Trio 1: extraction then post-extraction
    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: ["Validate inputs at function boundaries"],
      summary: {
        agentBefore: "Agent wrote function without validation",
        userFeedback: "User said to validate inputs",
        agentAfter: "Agent added validation",
      },
    });
    mockCallPortraitLlm.mockResolvedValueOnce(["Validate inputs at function boundaries"]);
    // Trio 2: extraction then post-extraction
    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: ["Prefer async I/O over synchronous reads"],
      summary: {
        agentBefore: "Agent used sync file read",
        userFeedback: "User said to use async I/O",
        agentAfter: "Agent switched to async reads",
      },
    });
    mockCallPortraitLlm.mockResolvedValueOnce(["Prefer async I/O over synchronous reads"]);

    const result = await scanSessions(portraitDir, getDefaultState(), 10, 100);

    // Both trios should be extracted (2 results, 1 rule each)
    expect(result.results.length).toBe(2);
    expect(result.results[0].behaviorNotes).toEqual(["Validate inputs at function boundaries"]);
    expect(result.results[1].behaviorNotes).toEqual(["Prefer async I/O over synchronous reads"]);
    expect(result.triosProcessed).toBe(2);

    // 4 LLM calls total: 2 extraction + 2 post-extraction
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(4);
  });

  it("propagates PAUSED from extraction instead of swallowing it in the scan loop", async () => {
    // Regression: the scan loop's try/catch (meant to skip malformed JSON lines) used to wrap
    // tryExtractTrio too, so a "PAUSED" throw from callExtractionLlm was silently caught and the
    // scan continued — re-showing the retry dialog after the user already chose to pause. Now the
    // catch re-throws PAUSED so it propagates up to collect/runProfilingCycle.
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will implement the feature.",
        user: "Also add error handling.",
        assistant2: "Added error handling.",
      },
    ]);

    // callExtractionLlm throws "PAUSED" (mirrors collector.ts line 644: throw new Error("PAUSED"))
    mockCallPortraitLlm.mockRejectedValueOnce(new Error("PAUSED"));

    await expect(scanSessions(portraitDir, getDefaultState(), 10, 100)).rejects.toThrow("PAUSED");
  });

  it("propagates PAUSED from post-extraction instead of swallowing it", async () => {
    // The post-extractor (postExtractRules) also throws "PAUSED" (line 734) and the SAME scan-loop
    // catch must re-throw it. Verify the post-extraction throw path propagates too.
    createSessionFile(sessionDir, "test.jsonl", [
      {
        assistant1: "I will implement the feature.",
        user: "Also add error handling.",
        assistant2: "Added error handling.",
      },
    ]);

    // First call = extraction (succeeds). Second call = post-extraction (throws PAUSED).
    mockCallPortraitLlm.mockResolvedValueOnce({
      notes: ["some note"],
      summary: { agentBefore: "a", userFeedback: "b", agentAfter: "c" },
    });
    mockCallPortraitLlm.mockRejectedValueOnce(new Error("PAUSED"));

    await expect(scanSessions(portraitDir, getDefaultState(), 10, 100)).rejects.toThrow("PAUSED");
  });
});
