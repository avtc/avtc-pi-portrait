// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for the word-counting helper used by the streamed progress indicator.
 *
 * callPortraitLlm/attemptWithRetries accumulate words from text/thinking/tool-call
 * deltas and fire onProgress (throttled) so the footer can show a live count.
 * The counting logic is the testable core; the streaming loop itself is exercised
 * end-to-end (agentLoop is a real dependency).
 */
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock agentLoop so attemptWithRetries can be exercised without a real LLM. The mock is set
// per-test via vi.mocked(agentLoop).mockImplementation(...).
vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...orig,
    agentLoop: vi.fn(),
  };
});

import { agentLoop } from "@earendil-works/pi-agent-core";
import { attemptWithRetries, countWords, retryDelayMs } from "../src/llm-call.js";

const mockAgentLoop = agentLoop as unknown as ReturnType<typeof vi.fn>;

describe("countWords", () => {
  it("returns 0 for empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(countWords("   \n\t  ")).toBe(0);
  });

  it("counts a single word", () => {
    expect(countWords("hello")).toBe(1);
  });

  it("counts space-separated words", () => {
    expect(countWords("one two three")).toBe(3);
  });

  it("collapses runs of whitespace (spaces, tabs, newlines)", () => {
    expect(countWords("one\ttwo\n\nthree   four")).toBe(4);
  });

  it("trims leading/trailing whitespace before counting", () => {
    expect(countWords("  one two  ")).toBe(2);
  });

  it("counts JSON-like tool-call deltas as words", () => {
    // toolcall_delta carries incremental JSON fragments — counted like any text
    expect(countWords('{"portrait":["rule 1","rule 2"]}')).toBe(3);
  });

  it("counts a single punctuation token as one word", () => {
    expect(countWords("{")).toBe(1);
  });
});

describe("retryDelayMs", () => {
  // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 10s.
  it("returns 1s (1000ms) for the first retry (attempt 0)", () => {
    expect(retryDelayMs(0)).toBe(1_000);
  });

  it("returns 2s (2000ms) for the second retry (attempt 1)", () => {
    expect(retryDelayMs(1)).toBe(2_000);
  });

  it("returns 4s (4000ms) for the third retry (attempt 2)", () => {
    expect(retryDelayMs(2)).toBe(4_000);
  });

  it("returns 8s (8000ms) for the fourth retry (attempt 3)", () => {
    expect(retryDelayMs(3)).toBe(8_000);
  });

  it("caps at 10s (10000ms) for the fifth retry and beyond", () => {
    // 2^4 = 16s, capped to 10s
    expect(retryDelayMs(4)).toBe(10_000);
    // 2^10 = 1024s, capped to 10s
    expect(retryDelayMs(10)).toBe(10_000);
  });
});

/** Build a no-op async iterable that yields nothing (simulates a stream that produces no tool call). */
function emptyStream() {
  return {
    async *[Symbol.asyncIterator]() {
      // yields nothing — resultExtractor() will return undefined → "tool not called"
    },
    async result() {
      /* no-op */
    },
  };
}

const NO_TOOL_CALLED_CONTEXT = "Previous call failed. Please return valid JSON using the tool.";

describe("attemptWithRetries backoff", () => {
  const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] as AgentTool[] };
  const config = {} as unknown as AgentLoopConfig;
  beforeEach(() => {
    mockAgentLoop.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses with exponential backoff between attempts when the tool is not called", async () => {
    // Regression: the "tool not called" path used to have NO backoff, so all retries fired
    // back-to-back and the retry dialog re-showed immediately after "Continue retrying".
    mockAgentLoop.mockReturnValue(emptyStream());

    vi.useFakeTimers();
    const delayResolved: boolean[] = [];
    // Track when each setTimeout-based backoff resolves (retryDelayMs: 1s, 2s for attempts 0,1)
    const realSetTimeout = setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((cb) => {
      delayResolved.push(false);
      const h = realSetTimeout(() => {
        delayResolved[delayResolved.length - 1] = true;
        cb();
      }, 0);
      return h as unknown as ReturnType<typeof setTimeout>;
    });

    // 3 attempts (maxRetries=3) → 2 backoff waits (after attempt 0 and 1)
    const promise = attemptWithRetries<string>(
      [],
      context,
      config,
      5_000,
      3,
      () => undefined, // tool never called → always "tool not called"
      NO_TOOL_CALLED_CONTEXT,
    );

    await vi.runAllTimersAsync();
    const { lastError } = await promise;

    expect(lastError).toBe("LLM did not call the required extraction tool");
    expect(mockAgentLoop).toHaveBeenCalledTimes(3);
    // Two backoff delays occurred between the three attempts (proves attempts did NOT fire back-to-back)
    expect(delayResolved.length).toBe(2);
    expect(delayResolved).toEqual([true, true]);
  });

  it("pushes an error-context nudge after a tool-not-called failure", async () => {
    mockAgentLoop.mockReturnValue(emptyStream());

    vi.useFakeTimers();
    const messages: AgentMessage[] = [{ role: "user", content: "initial", timestamp: 0 }];

    const promise = attemptWithRetries<string>(
      messages,
      context,
      config,
      5_000,
      2, // 2 attempts → 1 nudge after the first
      () => undefined,
      NO_TOOL_CALLED_CONTEXT,
    );
    await vi.runAllTimersAsync();
    await promise;

    // A user nudge carrying the errorContext + lastError was appended before the second attempt
    const nudgeTexts = messages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c.type === "text")
      .map((c) => c.text)
      .filter((t) => t.includes(NO_TOOL_CALLED_CONTEXT));
    expect(nudgeTexts.length).toBe(1);
    expect(nudgeTexts[0]).toContain("LLM did not call the required extraction tool");
  });
});
