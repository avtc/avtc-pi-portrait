// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { type SessionEntry, TrioDetector } from "../src/trio-detector.js";

// Helpers to build session entries with minimal valid messages.
function assistantEntry(text: string): SessionEntry {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic",
      provider: "anthropic",
      model: "test",
      usage: {},
      stopReason: "end_turn",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function userEntry(content: string): SessionEntry {
  return {
    type: "message",
    message: { role: "user", content, timestamp: 0 },
  };
}

function askUserQuestionEntry(content: string): SessionEntry {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "ask_user_question",
      content: [{ type: "text", text: content }],
      toolCallId: "x",
      isError: false,
      timestamp: 0,
    },
  };
}

// ============================================================================
// TrioDetector
// ============================================================================

describe("TrioDetector", () => {
  describe("trio detection", () => {
    it("emits a trio on assistant → user → assistant", () => {
      const d = new TrioDetector();
      expect(d.process(assistantEntry("I will do X."))).toBeNull();
      expect(d.process(userEntry("Do X differently."))).toBeNull();
      const trio = d.process(assistantEntry("I did X differently."));
      expect(trio).toEqual({
        agentBefore: "I will do X.",
        userFeedback: "Do X differently.",
        agentAfter: "I did X differently.",
      });
    });

    it("returns null for entries without a message", () => {
      const d = new TrioDetector();
      expect(d.process({ type: "message" })).toBeNull();
      expect(d.process({ type: "other" })).toBeNull();
    });

    it("does not emit a trio until all three parts are present", () => {
      const d = new TrioDetector();
      expect(d.process(assistantEntry("A1"))).toBeNull();
      expect(d.process(userEntry("U1"))).toBeNull();
      // A second assistant without prior user does not emit
      const d2 = new TrioDetector();
      expect(d2.process(userEntry("U1"))).toBeNull();
      expect(d2.process(assistantEntry("A2"))).toBeNull();
    });
  });

  describe("one user message completes at most one trio", () => {
    it("clears lastUser after emitting a trio", () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry("U1"));
      const trio1 = d.process(assistantEntry("A2"));
      expect(trio1).not.toBeNull();
      // A third assistant should NOT complete another trio with the same user
      const trio2 = d.process(assistantEntry("A3"));
      expect(trio2).toBeNull();
    });
  });

  describe("approval skipping", () => {
    it("does not emit a trio when user message is an approval", () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry("yes"));
      expect(d.process(assistantEntry("A2"))).toBeNull();
    });

    it('does not emit a trio when user message is "looks good!"', () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry("looks good!"));
      expect(d.process(assistantEntry("A2"))).toBeNull();
    });
  });

  describe("extension-message skipping", () => {
    it('does not emit a trio when user message is extension-generated (bare "continue")', () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry("continue"));
      expect(d.process(assistantEntry("A2"))).toBeNull();
    });

    it('does not emit a trio when user message is "TODO #5:..."', () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry("TODO #5: do something"));
      expect(d.process(assistantEntry("A2"))).toBeNull();
    });

    it('does not emit a trio when user message is "Context was compacted..."', () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry("Context was compacted into a summary"));
      expect(d.process(assistantEntry("A2"))).toBeNull();
    });
  });

  describe("skill-block stripping", () => {
    it("strips skill blocks from user message before storing", () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry('<skill name="x">injected</skill>real feedback'));
      const trio = d.process(assistantEntry("A2"));
      expect(trio).toEqual({
        agentBefore: "A1",
        userFeedback: "real feedback",
        agentAfter: "A2",
      });
    });

    it("does not emit a trio when only skill content remains (empty after strip)", () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry('<skill name="x">only skill content</skill>'));
      expect(d.process(assistantEntry("A2"))).toBeNull();
    });
  });

  describe("ask_user_question toolResult", () => {
    it("treats ask_user_question toolResult as a user message", () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(askUserQuestionEntry("Pick option A"));
      const trio = d.process(assistantEntry("A2"));
      expect(trio).toEqual({
        agentBefore: "A1",
        userFeedback: "Pick option A",
        agentAfter: "A2",
      });
    });
  });

  describe("multiple consecutive trios", () => {
    it("emits two trios from a sequence of 5 messages", () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry("U1"));
      const trio1 = d.process(assistantEntry("A2"));
      d.process(userEntry("U2"));
      const trio2 = d.process(assistantEntry("A3"));
      expect(trio1).toEqual({ agentBefore: "A1", userFeedback: "U1", agentAfter: "A2" });
      expect(trio2).toEqual({ agentBefore: "A2", userFeedback: "U2", agentAfter: "A3" });
    });
  });

  describe("edge cases", () => {
    it("ignores assistant messages with only a tool call (no text)", () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry("U1"));
      // Assistant with only a tool call (no text content) should not complete a trio
      const toolCallOnly: SessionEntry = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" as const, name: "bash" }],
          api: "anthropic",
          provider: "anthropic",
          model: "test",
          usage: {},
          stopReason: "toolUse",
          timestamp: 0,
        },
      } as unknown as SessionEntry;
      expect(d.process(toolCallOnly)).toBeNull();
      // A subsequent text assistant should still complete the trio using A1/U1
      const trio = d.process(assistantEntry("A2"));
      expect(trio).toEqual({ agentBefore: "A1", userFeedback: "U1", agentAfter: "A2" });
    });

    it("ignores non-ask_user_question tool results (e.g. bash, read)", () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      // A bash toolResult should NOT be treated as user feedback
      const bashResult: SessionEntry = {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "command output here" }],
          toolCallId: "x",
          isError: false,
          timestamp: 0,
        },
      };
      expect(d.process(bashResult)).toBeNull();
      // No trio should complete because no user message was registered
      expect(d.process(assistantEntry("A2"))).toBeNull();
    });
  });

  describe("reset", () => {
    it("clears state so no trio is emitted from stale data", () => {
      const d = new TrioDetector();
      d.process(assistantEntry("A1"));
      d.process(userEntry("U1"));
      d.reset();
      // After reset, a new assistant alone should not complete a trio
      expect(d.process(assistantEntry("A2"))).toBeNull();
      // Need a fresh user → assistant to emit
      d.process(userEntry("U2"));
      const trio = d.process(assistantEntry("A3"));
      expect(trio).toEqual({ agentBefore: "A2", userFeedback: "U2", agentAfter: "A3" });
    });
  });
});
