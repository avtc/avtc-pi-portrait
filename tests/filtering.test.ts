// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { isContinuation, isExtensionMessage, stripSkillBlocks } from "../src/filtering.js";

// ============================================================================
// stripSkillBlocks
// ============================================================================

describe("stripSkillBlocks", () => {
  describe("complete blocks", () => {
    it("strips a single complete skill block", () => {
      const input = '<skill name="foo">secret content</skill>real message';
      expect(stripSkillBlocks(input)).toBe("real message");
    });

    it("strips a skill block with attributes", () => {
      const input = '<skill name="foo" location="bar">content</skill>after';
      expect(stripSkillBlocks(input)).toBe("after");
    });

    it("strips multiple complete skill blocks", () => {
      const input = '<skill name="a">block1</skill>middle<skill name="b">block2</skill>end';
      expect(stripSkillBlocks(input)).toBe("middleend");
    });

    it("returns empty when only a skill block is present", () => {
      const input = '<skill name="foo">all content</skill>';
      expect(stripSkillBlocks(input)).toBe("");
    });
  });

  describe("unclosed blocks", () => {
    it("strips an unclosed skill block to end of string", () => {
      const input = 'before<skill name="foo">rest of string with no close';
      expect(stripSkillBlocks(input)).toBe("before");
    });

    it("strips unclosed block after a complete block", () => {
      const input = '<skill name="a">closed</skill>keep<skill name="b">unclosed to end';
      expect(stripSkillBlocks(input)).toBe("keep");
    });
  });

  describe("skill: prefix", () => {
    it("strips a /skill: prefix", () => {
      expect(stripSkillBlocks("/skill:foo remaining text")).toBe("remaining text");
    });

    it("strips /skill: prefix with leading whitespace", () => {
      expect(stripSkillBlocks("  /skill:bar  text")).toBe("text");
    });

    it("returns empty when only a /skill: prefix remains", () => {
      expect(stripSkillBlocks("/skill:foo")).toBe("");
    });
  });

  describe("passthrough (no skill content)", () => {
    it("returns content unchanged when no skill blocks present", () => {
      const input = "just a normal user message";
      expect(stripSkillBlocks(input)).toBe(input);
    });

    it("preserves whitespace-only content as empty after trim", () => {
      expect(stripSkillBlocks("   ")).toBe("");
    });

    it("returns empty string unchanged", () => {
      expect(stripSkillBlocks("")).toBe("");
    });

    it("does not strip text that merely mentions skill in prose", () => {
      const input = "Use the skill system to load tools";
      expect(stripSkillBlocks(input)).toBe(input);
    });
  });
});

// ============================================================================
// isContinuation
// ============================================================================

describe("isContinuation", () => {
  describe("bare continuation phrases (should be detected)", () => {
    it('detects bare "continue"', () => {
      expect(isContinuation("continue")).toBe(true);
    });

    it('detects bare "commit"', () => {
      expect(isContinuation("commit")).toBe(true);
    });

    it('detects "please continue"', () => {
      expect(isContinuation("please continue")).toBe(true);
    });

    it('detects "commit then proceed"', () => {
      expect(isContinuation("commit then proceed")).toBe(true);
    });

    it('detects "commit your changes"', () => {
      expect(isContinuation("commit your changes")).toBe(true);
    });

    it('detects "commit files you have changed"', () => {
      expect(isContinuation("commit files you have changed")).toBe(true);
    });
  });

  describe("whitespace handling", () => {
    it("trims leading/trailing whitespace before matching", () => {
      expect(isContinuation("  continue  ")).toBe(true);
      expect(isContinuation("\tcommit\t")).toBe(true);
    });
  });

  describe("non-continuations", () => {
    it('does not flag "continue" embedded in a sentence', () => {
      expect(isContinuation("please continue with the next step carefully")).toBe(false);
    });

    it('does not flag "commit" embedded in a sentence', () => {
      expect(isContinuation("commit your changes after fixing this")).toBe(false);
    });

    it("does not flag empty string", () => {
      expect(isContinuation("")).toBe(false);
    });
  });
});

// ============================================================================
// isExtensionMessage
// ============================================================================

describe("isExtensionMessage", () => {
  describe("extension-generated patterns (should be detected)", () => {
    it('detects "Plan review complete..." handoff', () => {
      expect(isExtensionMessage("Plan review complete across 4 rounds")).toBe(true);
    });

    it('detects "TODO #N:..." compaction follow-up', () => {
      expect(isExtensionMessage("TODO #5: implement the extraction step")).toBe(true);
    });

    it('detects "Continuing work on feature:" kanban lifecycle', () => {
      expect(isExtensionMessage("Continuing work on feature: enriched-extraction")).toBe(true);
    });

    it('detects "▶ N:" pi-todo follow-up', () => {
      expect(isExtensionMessage("▶ 3: fix the bug")).toBe(true);
    });

    it('detects "[Pending dialog" compaction restoration', () => {
      expect(isExtensionMessage("[Pending dialog — user was asked a question]")).toBe(true);
    });

    it('detects "Context was compacted" restoration', () => {
      expect(isExtensionMessage("Context was compacted into the following summary")).toBe(true);
    });

    it('detects "Run design review iteration" follow-up', () => {
      expect(isExtensionMessage("Run design review iteration #2")).toBe(true);
    });

    it('detects "Work on feature:" lifecycle', () => {
      expect(isExtensionMessage("Work on feature: portrait")).toBe(true);
    });

    it('detects "Design review complete" handoff', () => {
      expect(isExtensionMessage("Design review complete: 3 issues found")).toBe(true);
    });

    it('detects "Feature review complete" handoff', () => {
      expect(isExtensionMessage("Feature review complete across 2 rounds")).toBe(true);
    });

    it('detects "Code review complete" handoff', () => {
      expect(isExtensionMessage("Code review complete: all passing")).toBe(true);
    });

    it('detects "Run plan review iteration" follow-up', () => {
      expect(isExtensionMessage("Run plan review iteration #3")).toBe(true);
    });

    it('detects "Context was reset between tasks" plan-tracker', () => {
      expect(isExtensionMessage("Context was reset between tasks, continuing with task 2")).toBe(true);
    });
  });

  describe("real user feedback (should NOT be detected)", () => {
    it("does not flag substantive feedback", () => {
      expect(isExtensionMessage("Search first before creating new implementations")).toBe(false);
    });

    it("does not flag a question", () => {
      expect(isExtensionMessage("Why did you skip the tests?")).toBe(false);
    });

    it("does not flag empty string", () => {
      expect(isExtensionMessage("")).toBe(false);
    });

    it("does not flag bare continuation phrases", () => {
      expect(isExtensionMessage("continue")).toBe(false);
      expect(isExtensionMessage("commit")).toBe(false);
    });
  });
});
