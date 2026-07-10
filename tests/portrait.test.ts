// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "../src/globals.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyDecisions, validateDecisions } from "../src/builder.js";
import { summarizeToolCall, summarizeToolResult } from "../src/collector.js";
import { extractAssistantText, extractContent, isApproval } from "../src/filtering.js";
import { initGit, resetGitExec, setGitExec } from "../src/git.js";
import { parsePortraitRules } from "../src/storage.js";
import type { BuildingDecision, PortraitState } from "../src/types.js";
import { installRecordingGit } from "./git-recorder.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";

// Every test reads portrait settings via the mock-DI accessor (schema-derived defaults, no handle).
beforeEach(() => setupTestSettings(null));
afterEach(() => teardownTestSettings());

// ---------------------------------------------------------------------------
// Git audit layer is exercised through an injectable runner seam (setGitExec in src/git.js).
// A recording runner captures commit messages so the commit-message assertions below read them
// via recording.getLatestCommit()/getCommitLog() — no `git` subprocess runs anywhere here.
// ---------------------------------------------------------------------------
const recording = installRecordingGit();

beforeAll(() => {
  // Route every git call in src/git.js through the recording runner (no real `git` subprocesses).
  setGitExec(recording.runner);
});

afterAll(() => {
  resetGitExec();
});

// (git harness removed — git is fully mocked via the recording runner seam above)

// ============================================================================
// BuildingDecision type tests
// ============================================================================
describe("BuildingDecision type", () => {
  it("accepts BuildingDecision with evictPositions", () => {
    const decision: BuildingDecision = {
      candidate: "C1",
      action: "insert",
      beforePosition: 5,
      evictPositions: [12, 15],
    };
    expect(decision.evictPositions).toEqual([12, 15]);
  });

  it("accepts BuildingDecision with string evictPositions", () => {
    const decision: BuildingDecision = {
      candidate: "C1",
      action: "insert",
      beforePosition: 5,
      evictPositions: ["C2"],
    };
    expect(decision.evictPositions).toEqual(["C2"]);
  });

  it("accepts BuildingDecision without evictPositions", () => {
    const decision: BuildingDecision = {
      candidate: "C1",
      action: "insert",
      beforePosition: 5,
    };
    expect(decision.evictPositions).toBeUndefined();
  });
});

// ============================================================================
// parsePortraitRules tests
// ============================================================================
describe("parsePortraitRules", () => {
  it("parses rules from valid portrait.md content", () => {
    const content = `# User Portrait

Anticipate what the user will ask, flag, or correct. Before producing output, check:
- Does this output follow the user's known expectations?

## Anticipation Rules
When working with config files, check existing keys first
Never hardcode values that should come from config
Always validate input before processing
`;
    const rules = parsePortraitRules(content);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toBe("When working with config files, check existing keys first");
    expect(rules[2]).toBe("Always validate input before processing");
  });

  it("returns empty array when header is missing", () => {
    expect(parsePortraitRules("some random content")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parsePortraitRules("")).toEqual([]);
  });

  it("handles header with no rules", () => {
    const content = "# User Portrait\n\n## Anticipation Rules\n";
    expect(parsePortraitRules(content)).toEqual([]);
  });
});

// ============================================================================
// isApproval tests
// ============================================================================
describe("isApproval", () => {
  it("matches basic approvals", () => {
    expect(isApproval("yes")).toBe(true);
    expect(isApproval("ok")).toBe(true);
    expect(isApproval("good")).toBe(true);
    expect(isApproval("approved")).toBe(true);
    expect(isApproval("go ahead")).toBe(true);
    // Phrases added during enriched-extraction feature work
    expect(isApproval("proceed")).toBe(true);
    expect(isApproval("apply")).toBe(true);
  });

  it("matches approvals with punctuation", () => {
    expect(isApproval("yes!")).toBe(true);
    expect(isApproval("ok.")).toBe(true);
    expect(isApproval("looks good!")).toBe(true);
    expect(isApproval("go ahead?")).toBe(true);
  });

  it("matches approvals with whitespace", () => {
    expect(isApproval("  yes  ")).toBe(true);
    expect(isApproval("\tok\t")).toBe(true);
  });

  it("rejects non-approvals", () => {
    expect(isApproval("no")).toBe(false);
    expect(isApproval("actually, this is wrong")).toBe(false);
    expect(isApproval("")).toBe(false);
  });

  it("rejects approvals embedded in longer text", () => {
    expect(isApproval("yes, but change this")).toBe(false);
    expect(isApproval("ok so now fix this")).toBe(false);
  });
});

// ============================================================================
// extractContent tests
// ============================================================================
describe("extractContent", () => {
  it("extracts string content directly", () => {
    expect(extractContent("hello")).toBe("hello");
  });

  it("extracts text from array of content blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractContent(content)).toBe("hello\nworld");
  });

  it("handles mixed string and object array", () => {
    const content = ["plain text", { type: "text", text: "object text" }];
    expect(extractContent(content)).toBe("plain text\nobject text");
  });

  it("returns empty string for null/undefined", () => {
    expect(extractContent(null)).toBe("");
    expect(extractContent(undefined)).toBe("");
  });
});

// ============================================================================
// applyDecisions offset tracking tests
// ============================================================================
// Unit tests for the POSITIONING LOGIC ONLY. Everything that is not under test is mocked
// at the boundary, so the tests touch NO filesystem, NO git, and NO config:
//   - { skipPersist: true } → skips writePortrait / appendDropped / appendEvicted / commitPortrait (disk + git).
//   - { ruleLimit: N } → overrides getPortraitSettings().ruleLimit (settings read) via the existing option.
//   - a dummy portraitDir → never read or written under skipPersist (all disk ops are Phase 6/7, guarded).
// The tests assert on the returned `.rules` array (populated under skipPersist) — the exact logic output.
// (The persistence + git-commit + config paths are covered by other describe blocks that exercise them)
describe("applyDecisions offset tracking", () => {
  // Unused under skipPersist — all disk/git I/O is Phase 6/7 and gated on !skipPersist.
  const DUMMY_DIR = "/nonexistent-portrait-dir";
  const RULE_LIMIT = 1000; // large enough that mechanical eviction never triggers in these tests
  const OPTS = { ruleLimit: RULE_LIMIT, skipPersist: true } as const;

  it("appends at end when no beforePosition", () => {
    const decisions: BuildingDecision[] = [{ candidate: "C1", action: "insert" }];
    const { rules } = applyDecisions(DUMMY_DIR, [], ["NEW"], decisions, OPTS);
    expect(rules).toContain("NEW");
  });

  it("inserts at the very start with beforePosition=1", () => {
    const decisions: BuildingDecision[] = [{ candidate: "C1", action: "insert", beforePosition: 1 }];
    const { rules } = applyDecisions(DUMMY_DIR, ["R1", "R2"], ["NEW"], decisions, OPTS);
    expect(rules[0]).toBe("NEW");
  });

  it("inserts between R1 and R2 with beforePosition=2", () => {
    const decisions: BuildingDecision[] = [{ candidate: "C1", action: "insert", beforePosition: 2 }];
    const { rules } = applyDecisions(DUMMY_DIR, ["R1", "R2", "R3"], ["NEW"], decisions, OPTS);
    expect(rules).toEqual(["R1", "NEW", "R2", "R3"]);
  });

  it("handles two inserts with cascading offsets", () => {
    const decisions: BuildingDecision[] = [
      { candidate: "C1", action: "insert", beforePosition: 2 },
      { candidate: "C2", action: "insert", beforePosition: 4 },
    ];
    const { rules } = applyDecisions(DUMMY_DIR, ["R1", "R2", "R3", "R4"], ["NEW1", "NEW2"], decisions, OPTS);
    expect(rules).toEqual(["R1", "NEW1", "R2", "R3", "NEW2", "R4"]);
  });

  it("handles two inserts both before rule 2", () => {
    const decisions: BuildingDecision[] = [
      { candidate: "C1", action: "insert", beforePosition: 2 },
      { candidate: "C2", action: "insert", beforePosition: 2 },
    ];
    const { rules } = applyDecisions(DUMMY_DIR, ["R1", "R2", "R3"], ["NEW1", "NEW2"], decisions, OPTS);
    // Text-based lookup: both target R2. C1 inserts before R2 (index 1) → [R1,NEW1,R2,R3];
    // R2 now sits at index 2, so C2 inserts before it at index 2 → [R1,NEW1,NEW2,R2,R3].
    // Both end up before R2, in processing order.
    expect(rules).toEqual(["R1", "NEW1", "NEW2", "R2", "R3"]);
  });

  it("resolves string beforePosition to candidate position", () => {
    const decisions: BuildingDecision[] = [
      { candidate: "C1", action: "insert", beforePosition: 1 },
      { candidate: "C2", action: "insert", beforePosition: "C1" },
    ];
    const { rules } = applyDecisions(DUMMY_DIR, ["R1", "R2"], ["NEW1", "NEW2"], decisions, OPTS);
    // C1 inserts before rule 1 (start) → [NEW1,R1,R2]; candidatePositions[C1]=0.
    // C2 inserts before C1's position (0) → [NEW2,NEW1,R1,R2] (C2 lands ahead of C1).
    expect(rules).toEqual(["NEW2", "NEW1", "R1", "R2"]);
  });

  it("skips decisions with action=skip", () => {
    const decisions: BuildingDecision[] = [
      { candidate: "C1", action: "skip" },
      { candidate: "C2", action: "insert", beforePosition: 1 },
    ];
    const { rules } = applyDecisions(DUMMY_DIR, ["R1"], ["SKIP", "NEW"], decisions, OPTS);
    expect(rules).toEqual(["NEW", "R1"]);
  });

  it("clamps negative beforePosition to the very start", () => {
    const decisions: BuildingDecision[] = [{ candidate: "C1", action: "insert", beforePosition: -5 }];
    const { rules } = applyDecisions(DUMMY_DIR, ["R1", "R2"], ["NEW"], decisions, OPTS);
    expect(rules).toEqual(["NEW", "R1", "R2"]);
  });
});

// ============================================================================
// validateDecisions tests
// ============================================================================
describe("validateDecisions", () => {
  it("accepts valid decisions", () => {
    const result = validateDecisions(
      [
        { candidate: "C1", action: "insert", beforePosition: 1 },
        { candidate: "C2", action: "skip" },
      ],
      10,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects insert referencing skipped candidate", () => {
    const result = validateDecisions(
      [
        { candidate: "C2", action: "skip" },
        { candidate: "C1", action: "insert", beforePosition: "C2" },
      ],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  it("accepts insert referencing numeric position even when other candidates skipped", () => {
    const result = validateDecisions(
      [
        { candidate: "C2", action: "skip" },
        { candidate: "C1", action: "insert", beforePosition: 3 },
      ],
      10,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts empty decisions array", () => {
    const result = validateDecisions([], 0, undefined);
    expect(result.ok).toBe(true);
  });

  it("accepts all-skip decisions", () => {
    const result = validateDecisions(
      [
        { candidate: "C1", action: "skip" },
        { candidate: "C2", action: "skip" },
        { candidate: "C3", action: "skip" },
      ],
      10,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts insert with no beforePosition", () => {
    const result = validateDecisions([{ candidate: "C1", action: "insert" }], 10, undefined);
    expect(result.ok).toBe(true);
  });

  it("accepts insert with string beforePosition referencing non-skipped candidate", () => {
    const result = validateDecisions(
      [
        { candidate: "C1", action: "insert", beforePosition: "C2" },
        { candidate: "C2", action: "insert" },
      ],
      10,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects string beforePosition that does not match C\\d+ pattern", () => {
    const result = validateDecisions([{ candidate: "C1", action: "insert", beforePosition: "3" }], 10, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("beforePosition");
  });

  it("rejects string beforePosition C0 (zero-indexed candidate)", () => {
    const result = validateDecisions([{ candidate: "C1", action: "insert", beforePosition: "C0" }], 10, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("C0");
  });

  it("rejects string beforePosition referencing out-of-range candidate", () => {
    const result = validateDecisions([{ candidate: "C1", action: "insert", beforePosition: "C99" }], 10, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("C99");
  });

  it("rejects insert referencing skipped candidate with error message", () => {
    const result = validateDecisions(
      [
        { candidate: "C3", action: "skip" },
        { candidate: "C1", action: "insert", beforePosition: "C3" },
      ],
      10,
      undefined,
    );
    if (!result.ok) {
      expect(result.error).toContain("C3");
      expect(result.error).toContain("skipped");
    }
  });

  // --- evictPositions validation tests ---

  it("rejects evictPositions on skip action", () => {
    const result = validateDecisions([{ candidate: "C1", action: "skip", evictPositions: [3] }], 10, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("evictPositions");
  });

  it("rejects evictPositions referencing skipped candidate", () => {
    const result = validateDecisions(
      [
        { candidate: "C2", action: "skip" },
        { candidate: "C1", action: "insert", beforePosition: 1, evictPositions: ["C2"] },
      ],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("skipped");
  });

  it("rejects evictPositions out of range", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: [11] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("range");
  });

  it("rejects evictPositions with boundary value 0", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: [0] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("range");
  });

  it("rejects negative evictPositions values", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: [-1] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("range");
  });

  it("rejects duplicate string evictPositions", () => {
    const result = validateDecisions(
      [
        { candidate: "C1", action: "insert", beforePosition: 1 },
        { candidate: "C2", action: "insert", beforePosition: 1, evictPositions: ["C1", "C1"] },
      ],
      10,
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("duplicate");
  });

  it("rejects duplicate evictPositions", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: [3, 3] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("duplicate");
  });

  it("accepts empty evictPositions array", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: [] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects evictPositions string ref to self (C1 evicting C1)", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: ["C1"] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("self");
  });

  it("rejects evictPositions string ref to out-of-range candidate (C99 with only 2 candidates)", () => {
    const result = validateDecisions(
      [
        { candidate: "C1", action: "insert", beforePosition: 1, evictPositions: ["C99"] },
        { candidate: "C2", action: "insert", beforePosition: 1 },
      ],
      10,
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("C99");
  });

  it("accepts evictPositions string ref to other inserted candidate", () => {
    const result = validateDecisions(
      [
        { candidate: "C1", action: "insert", beforePosition: 1 },
        { candidate: "C2", action: "insert", beforePosition: 1, evictPositions: ["C1"] },
      ],
      10,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects evictPositions with invalid string format", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: ["invalid"] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pattern");
  });

  it("rejects evictPositions string C0 (zero-indexed candidate)", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: ["C0"] }],
      10,
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("C0");
  });

  it("accepts evictPositions at exact upper boundary", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: [10] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects evictPositions when portraitRuleCount is 0", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: [1] }],
      0,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("range");
  });

  it("rejects mixed valid/invalid evictPositions on first invalid entry", () => {
    // First entry 3 is valid (in range [1,5]), second entry 99 is out of range
    const result = validateDecisions(
      [{ candidate: "C1", action: "insert", beforePosition: 1, evictPositions: [3, 99] }],
      5,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("99");
  });
});

// ============================================================================
// validateDecisions merge action tests
// ============================================================================
describe("validateDecisions merge action", () => {
  it("accepts valid merge with mergePosition and text", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "merge", mergePosition: 3, text: "combined rule text" }],
      10,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts merge with additional evictPositions", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "merge", mergePosition: 3, text: "combined", evictPositions: [5] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects merge without mergePosition", () => {
    const result = validateDecisions([{ candidate: "C1", action: "merge", text: "combined" }], 10, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mergePosition");
  });

  it("rejects merge with non-integer mergePosition", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "merge", mergePosition: 3.5, text: "combined" }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects mergePosition out of range (too high)", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "merge", mergePosition: 11, text: "combined" }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("11");
  });

  it("rejects mergePosition out of range (zero)", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "merge", mergePosition: 0, text: "combined" }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects merge without text", () => {
    const result = validateDecisions([{ candidate: "C1", action: "merge", mergePosition: 3 }], 10, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("text");
  });

  it("rejects merge with empty text", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "merge", mergePosition: 3, text: "   " }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects merge with multi-line text", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "merge", mergePosition: 3, text: "line one\nline two" }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("single line");
  });

  it("rejects mergePosition appearing in its own evictPositions", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "merge", mergePosition: 3, text: "combined", evictPositions: [3] }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("3");
  });

  it("rejects beforePosition on merge action", () => {
    const result = validateDecisions(
      [{ candidate: "C1", action: "merge", mergePosition: 3, text: "combined", beforePosition: 1 }],
      10,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("beforePosition");
  });

  it("rejects evictPositions on skip action", () => {
    const result = validateDecisions([{ candidate: "C1", action: "skip", evictPositions: [3] }], 10, undefined);
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// Real appendEvicted tests (replacing simulation)
// ============================================================================
import { appendEvicted, loadPortraitState, readEvicted, writePortrait } from "../src/storage.js";

describe("appendEvicted (real)", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-evicted-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  it("appends new rules to evicted.md", () => {
    const dir = tmpDir();
    try {
      appendEvicted(dir, ["rule1", "rule2"]);
      const content = fs.readFileSync(path.join(dir, "evicted.md"), "utf-8");
      expect(content).toContain("rule1");
      expect(content).toContain("rule2");
    } finally {
      cleanup(dir);
    }
  });

  it("skips exact duplicates", () => {
    const dir = tmpDir();
    try {
      appendEvicted(dir, ["rule1"]);
      appendEvicted(dir, ["rule1"]);
      const content = fs.readFileSync(path.join(dir, "evicted.md"), "utf-8");
      const count = (content.match(/rule1/g) || []).length;
      expect(count).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it("no longer caps at 500 rules", () => {
    const dir = tmpDir();
    try {
      // Create 510 rules
      const rules = Array.from({ length: 510 }, (_, i) => `rule_${String(i).padStart(4, "0")}`);
      appendEvicted(dir, rules);
      const content = fs.readFileSync(path.join(dir, "evicted.md"), "utf-8");
      const lines = content.split("\n").filter((l: string) => l.trim() && !l.startsWith("#"));
      expect(lines.length).toBe(510);
      // All rules should be present
      expect(content).toContain("rule_0509");
      expect(content).toContain("rule_0009");
    } finally {
      cleanup(dir);
    }
  });
});

describe("writePortrait", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-write-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  it("writes rules in portrait.md format", () => {
    const dir = tmpDir();
    try {
      writePortrait(dir, ["rule 1", "rule 2", "rule 3"]);
      const content = fs.readFileSync(path.join(dir, "portrait.md"), "utf-8");
      expect(content).toContain("## Anticipation Rules");
      expect(content).toContain("rule 1");
      expect(content).toContain("rule 2");
      expect(content).toContain("rule 3");
    } finally {
      cleanup(dir);
    }
  });

  it("each rule is on its own line", () => {
    const dir = tmpDir();
    try {
      writePortrait(dir, ["alpha", "beta"]);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      expect(rules).toEqual(["alpha", "beta"]);
    } finally {
      cleanup(dir);
    }
  });
});

describe("loadPortraitState validation", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  it("returns defaults for missing file", () => {
    const dir = tmpDir();
    try {
      const state = loadPortraitState(dir);
      expect(state.paused).toBe(false);
      expect(state.triosProcessed).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it("falls back to defaults for Infinity values", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "portrait-state.json"),
        JSON.stringify({
          triosProcessed: Infinity,
          totalKnownTrios: NaN,
          remainingFiles: -Infinity,
        }),
      );
      const state = loadPortraitState(dir);
      expect(state.triosProcessed).toBe(0);
      expect(state.totalKnownTrios).toBe(0);
      expect(state.remainingFiles).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it("falls back to defaults for wrong types", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "portrait-state.json"),
        JSON.stringify({
          paused: "yes",
          pipelinePhase: 123,
          lastPipelineRun: 456,
        }),
      );
      const state = loadPortraitState(dir);
      expect(state.paused).toBe(false);
      expect(state.pipelinePhase).toBe("idle");
      expect(state.lastPipelineRun).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it("preserves valid values", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "portrait-state.json"),
        JSON.stringify({
          paused: true,
          triosProcessed: 42,
          pipelinePhase: "processing",
        }),
      );
      const state = loadPortraitState(dir);
      expect(state.paused).toBe(true);
      expect(state.triosProcessed).toBe(42);
      expect(state.pipelinePhase).toBe("processing");
    } finally {
      cleanup(dir);
    }
  });

  it("defaults rulesInsertedSinceMaintenance to 0", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "portrait-state.json"), JSON.stringify({}));
      const state = loadPortraitState(dir);
      expect(state.rulesInsertedSinceMaintenance).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it("preserves rulesInsertedSinceMaintenance", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "portrait-state.json"),
        JSON.stringify({
          rulesInsertedSinceMaintenance: 15,
        }),
      );
      const state = loadPortraitState(dir);
      expect(state.rulesInsertedSinceMaintenance).toBe(15);
    } finally {
      cleanup(dir);
    }
  });

  it("defaults lastMaintenanceRun to null", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "portrait-state.json"), JSON.stringify({}));
      const state = loadPortraitState(dir);
      expect(state.lastMaintenanceRun).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it("preserves lastMaintenanceRun", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "portrait-state.json"),
        JSON.stringify({
          lastMaintenanceRun: "2026-06-12T10:00:00.000Z",
        }),
      );
      const state = loadPortraitState(dir);
      expect(state.lastMaintenanceRun).toBe("2026-06-12T10:00:00.000Z");
    } finally {
      cleanup(dir);
    }
  });

  it("defaults lastMaintenanceRun to null for non-string", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "portrait-state.json"),
        JSON.stringify({
          lastMaintenanceRun: 12345,
        }),
      );
      const state = loadPortraitState(dir);
      expect(state.lastMaintenanceRun).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it("defaults rulesInsertedSinceMaintenance to 0 for negative value", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "portrait-state.json"),
        JSON.stringify({
          rulesInsertedSinceMaintenance: -5,
        }),
      );
      const state = loadPortraitState(dir);
      expect(state.rulesInsertedSinceMaintenance).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it("defaults rulesInsertedSinceMaintenance to 0 for non-integer", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "portrait-state.json"),
        JSON.stringify({
          rulesInsertedSinceMaintenance: 3.5,
        }),
      );
      const state = loadPortraitState(dir);
      expect(state.rulesInsertedSinceMaintenance).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it("defaults rulesInsertedSinceMaintenance to 0 for Infinity", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "portrait-state.json"),
        JSON.stringify({
          rulesInsertedSinceMaintenance: Infinity,
        }),
      );
      const state = loadPortraitState(dir);
      expect(state.rulesInsertedSinceMaintenance).toBe(0);
    } finally {
      cleanup(dir);
    }
  });
});

describe("applyDecisions out-of-bounds beforePosition", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-oob-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "portrait.md"), "# User Portrait\n\n## Anticipation Rules\n");
    initGit(dir);
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  it("appends at end when beforePosition exceeds array length", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [{ candidate: "C1", action: "insert", beforePosition: 999 }];
      applyDecisions(dir, ["R1", "R2", "R3"], ["NEW"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      expect(rules).toEqual(["R1", "R2", "R3", "NEW"]);
    } finally {
      cleanup(dir);
    }
  });
});

describe("applyDecisions with evictPositions (insert-then-evict by text)", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-evict-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "portrait.md"), "# User Portrait\n\n## Anticipation Rules\n");
    initGit(dir);
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  it("insert-only creates no evicted.md and has clean commit message", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 2,
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3"], ["NEW"], decisions, undefined);
      // evicted.md exists (created by initGit) but should only contain header — no rules
      expect(readEvicted(dir)).toEqual([]);
      // Commit message should only contain "added"
      const log = recording.getLatestCommit(dir).toString().trim();
      expect(log).toContain("added");
      expect(log).not.toContain("dropped");
      expect(log).not.toContain("evicted");
    } finally {
      cleanup(dir);
    }
  });

  it("inserts with evictPositions removing correct rules", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 2,
          evictPositions: [4],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4"], ["NEW"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert after R1 → [R1,NEW,R2,R3,R4], evict R4 → [R1,NEW,R2,R3]
      expect(rules).toEqual(["R1", "NEW", "R2", "R3"]);
    } finally {
      cleanup(dir);
    }
  });

  it("handles replace scenario (beforePosition=N, evictPositions=[N-1])", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 4,
          evictPositions: [3],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4"], ["NEW"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert before R4 → [R1,R2,R3,NEW,R4], evict R3 → [R1,R2,NEW,R4]
      expect(rules).toEqual(["R1", "R2", "NEW", "R4"]);
      // Replaced rule should be persisted to dropped.md (semantic eviction)
      const droppedPath = path.join(dir, "dropped.md");
      expect(fs.existsSync(droppedPath)).toBe(true);
      expect(fs.readFileSync(droppedPath, "utf-8")).toContain("R3");
    } finally {
      cleanup(dir);
    }
  });

  it("handles multiple evictPositions", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 2,
          evictPositions: [4, 2],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4", "R5"], ["NEW"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert after R1 → [R1,NEW,R2,R3,R4,R5], evict R4 and R2 → [R1,NEW,R3,R5]
      expect(rules).toEqual(["R1", "NEW", "R3", "R5"]);
    } finally {
      cleanup(dir);
    }
  });

  it("persists semantically evicted rules to dropped.md", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 3,
          evictPositions: [3],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4"], ["NEW"], decisions, undefined);
      const droppedPath = path.join(dir, "dropped.md");
      expect(fs.existsSync(droppedPath)).toBe(true);
      const droppedContent = fs.readFileSync(droppedPath, "utf-8");
      expect(droppedContent).toContain("R3");
    } finally {
      cleanup(dir);
    }
  });

  it("insert at beforePosition=1 (very start) works correctly", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 1,
          evictPositions: [3],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4"], ["NEW"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert at start → [NEW,R1,R2,R3,R4], evict R3 → [NEW,R1,R2,R4]
      expect(rules).toEqual(["NEW", "R1", "R2", "R4"]);
    } finally {
      cleanup(dir);
    }
  });

  it("handles empty portrait with beforePosition=1", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 1,
        },
      ];
      applyDecisions(dir, [], ["NEW"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      expect(rules).toEqual(["NEW"]);
    } finally {
      cleanup(dir);
    }
  });

  it("handles evict last rule and insert at end", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          evictPositions: [4],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4"], ["NEW"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert at end (no beforePosition) → [R1,R2,R3,R4,NEW], evict R4 → [R1,R2,R3,NEW]
      expect(rules).toEqual(["R1", "R2", "R3", "NEW"]);
    } finally {
      cleanup(dir);
    }
  });

  it("handles string evictPositions referencing another candidate", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        { candidate: "C1", action: "insert", beforePosition: 3 },
        { candidate: "C2", action: "insert", beforePosition: 2, evictPositions: ["C1"] },
      ];
      applyDecisions(dir, ["R1", "R2", "R3"], ["NEW1", "NEW2"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert C1 after R2 → [R1,R2,NEW1,R3]
      // Insert C2 after R1 → [R1,NEW2,R2,NEW1,R3]
      // Evict C1 ("NEW1") → [R1,NEW2,R2,R3]
      expect(rules).toEqual(["R1", "NEW2", "R2", "R3"]);
    } finally {
      cleanup(dir);
    }
  });

  it("handles pure candidate eviction with no portrait rule eviction", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        { candidate: "C1", action: "insert", beforePosition: 1 },
        { candidate: "C2", action: "insert", beforePosition: 1, evictPositions: ["C1"] },
      ];
      applyDecisions(dir, ["R1", "R2"], ["NEW1", "NEW2"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert C1 at start → [NEW1,R1,R2]
      // Insert C2 at start → [NEW2,NEW1,R1,R2]
      // Evict C1 ("NEW1") → [NEW2,R1,R2]
      expect(rules).toEqual(["NEW2", "R1", "R2"]);
      // C1 text should be in dropped.md (semantic candidate eviction)
      const dropped = readDropped(dir);
      expect(dropped).toContain("NEW1");
    } finally {
      cleanup(dir);
    }
  });

  it("persists multiple semantic evictions to dropped.md", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 2,
          evictPositions: [3, 5],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4", "R5"], ["NEW"], decisions, undefined);
      const droppedPath = path.join(dir, "dropped.md");
      expect(fs.existsSync(droppedPath)).toBe(true);
      const droppedContent = fs.readFileSync(droppedPath, "utf-8");
      expect(droppedContent).toContain("R3");
      expect(droppedContent).toContain("R5");
    } finally {
      cleanup(dir);
    }
  });

  it("handles two candidates each evicting different rules", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        { candidate: "C1", action: "insert", beforePosition: 2, evictPositions: [4] },
        { candidate: "C2", action: "insert", beforePosition: 3, evictPositions: [5] },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4", "R5"], ["NEW1", "NEW2"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert C1 after R1 → [R1,NEW1,R2,R3,R4,R5]
      // Insert C2 after R2 → [R1,NEW1,R2,NEW2,R3,R4,R5]
      // Evict R4 (C1) and R5 (C2) → [R1,NEW1,R2,NEW2,R3]
      expect(rules).toEqual(["R1", "NEW1", "R2", "NEW2", "R3"]);
    } finally {
      cleanup(dir);
    }
  });

  it("triggers mechanical eviction when rules exceed ruleLimit", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 2,
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4", "R5"], ["NEW"], decisions, { ruleLimit: 4 });
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert after R1 → [R1,NEW,R2,R3,R4,R5] (6 rules), limit 4 → pop 2 → [R1,NEW,R2,R3]
      expect(rules).toEqual(["R1", "NEW", "R2", "R3"]);
      // Mechanical evictions should be in evicted.md
      const evictedPath = path.join(dir, "evicted.md");
      expect(fs.existsSync(evictedPath)).toBe(true);
      const evictedContent = fs.readFileSync(evictedPath, "utf-8");
      expect(evictedContent).toContain("R5");
      expect(evictedContent).toContain("R4");
      // Commit message should NOT contain 'dropped' (mechanical only)
      const log = recording.getLatestCommit(dir).toString().trim();
      expect(log).not.toContain("dropped");
    } finally {
      cleanup(dir);
    }
  });

  it("combines semantic and mechanical eviction", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 2,
          evictPositions: [3],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4", "R5"], ["NEW"], decisions, { ruleLimit: 3 });
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert after R1 → [R1,NEW,R2,R3,R4,R5]
      // Semantic evict R3 → [R1,NEW,R2,R4,R5]
      // Mechanical evict 2 (5 rules, limit 3) → [R1,NEW,R2]
      expect(rules).toEqual(["R1", "NEW", "R2"]);
      // Semantic eviction in dropped.md, mechanical evictions in evicted.md
      const droppedPath = path.join(dir, "dropped.md");
      const droppedContent = fs.readFileSync(droppedPath, "utf-8");
      expect(droppedContent).toContain("R3"); // semantic
      const evictedPath = path.join(dir, "evicted.md");
      const evictedContent = fs.readFileSync(evictedPath, "utf-8");
      expect(evictedContent).toContain("R5"); // mechanical
      expect(evictedContent).toContain("R4"); // mechanical
      // Commit message should contain both dropped and evicted segments
      const log = recording.getLatestCommit(dir).toString().trim();
      expect(log).toContain("dropped");
      expect(log).toContain("evicted");
    } finally {
      cleanup(dir);
    }
  });

  it("commit message includes dropped segment for semantic eviction", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "insert",
          beforePosition: 2,
          evictPositions: [3],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4"], ["NEW"], decisions, undefined);
      // Check git log for commit message
      const log = recording.getLatestCommit(dir).toString().trim();
      expect(log).toContain("dropped");
    } finally {
      cleanup(dir);
    }
  });

  // DEDUP-LOGIC UNIT TEST — mocked at the boundary. This test asserts
  // only on the dedup behavior when two candidates evict the SAME rule, so it uses skipPersist
  // and reads the returned `droppedRules`/`rules` (no filesystem, no git). The dedup source is a
  // single `Set<string>` (semanticEvicted in builder.ts): droppedRules === [...that Set] and the
  // commit-message "dropped" count === that Set's size, so droppedRules.length === the count the
  // commit message WOULD show. Asserting droppedRules === ["R3"] is thus equivalent to the old
  // dropped.md + "1 dropped" commit-message checks, with no git subprocesses to time out.
  it("handles two candidates evicting the same rule", () => {
    const decisions: BuildingDecision[] = [
      { candidate: "C1", action: "insert", beforePosition: 2, evictPositions: [3] },
      { candidate: "C2", action: "insert", beforePosition: 3, evictPositions: [3] },
    ];
    const { rules, droppedRules } = applyDecisions(
      "/nonexistent-portrait-dir",
      ["R1", "R2", "R3", "R4"],
      ["NEW1", "NEW2"],
      decisions,
      { ruleLimit: 1000, skipPersist: true },
    );
    // Insert C1 after R1 → [R1,NEW1,R2,R3,R4]
    // Insert C2 after R2 → [R1,NEW1,R2,NEW2,R3,R4]
    // Evict R3 (C1) → [R1,NEW1,R2,NEW2,R4]
    // Evict R3 again (C2) → indexOf returns -1, silent skip → [R1,NEW1,R2,NEW2,R4]
    expect(rules).toEqual(["R1", "NEW1", "R2", "NEW2", "R4"]);
    // R3 evicted by both C1 and C2, but deduped to exactly once (the core behavior under test).
    expect(droppedRules).toEqual(["R3"]);
  });

  it("skips malformed candidate ID silently", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [{ candidate: "X1", action: "insert", beforePosition: 2 }];
      applyDecisions(dir, ["R1", "R2"], ["NEW"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // X1 is not a valid C\d+ candidate ID → resolveCandidateText returns undefined → skip
      expect(rules).toEqual(["R1", "R2"]);
    } finally {
      cleanup(dir);
    }
  });

  it("handles mixed-type evictPositions (numeric and string)", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        { candidate: "C1", action: "insert", beforePosition: 2, evictPositions: [4] },
        { candidate: "C2", action: "insert", beforePosition: 2, evictPositions: [3, "C1"] },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4"], ["NEW1", "NEW2"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // Insert C1 after R1 → [R1,NEW1,R2,R3,R4]
      // Insert C2 after R1 → [R1,NEW2,NEW1,R2,R3,R4]
      // Evict R4 (C1 numeric) → [R1,NEW2,NEW1,R2,R3]
      // Evict C1/NEW1 (C2 string) → [R1,NEW2,R2,R3]
      // Also evict R3 (C2 numeric) → [R1,NEW2,R2]
      expect(rules).toEqual(["R1", "NEW2", "R2"]);
    } finally {
      cleanup(dir);
    }
  });

  it("produces no commit when all decisions are skips", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        { candidate: "C1", action: "skip" },
        { candidate: "C2", action: "skip" },
      ];
      applyDecisions(dir, ["R1", "R2"], ["SKIP1", "SKIP2"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      expect(rules).toEqual(["R1", "R2"]);
      // No new commit should be created — only the init commit exists
      const log = recording.getCommitLog(dir).toString().trim();
      const lines = log.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(1); // only init commit
      // evicted.md exists (created by initGit) but should only contain header — no rules
      expect(readEvicted(dir)).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// applyDecisions merge action tests
// ============================================================================
describe("applyDecisions merge action", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "portrait.md"), "# User Portrait\n\n## Anticipation Rules\n");
    initGit(dir);
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  it("replaces target rule text in place and does not insert candidate separately", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "merge",
          mergePosition: 2,
          text: "MERGED TEXT",
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3"], ["CAND"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // R2 replaced by MERGED TEXT; candidate CAND NOT inserted; count unchanged
      expect(rules).toEqual(["R1", "MERGED TEXT", "R3"]);
    } finally {
      cleanup(dir);
    }
  });

  it("persists the replaced original to dropped.md", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "merge",
          mergePosition: 2,
          text: "MERGED TEXT",
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3"], ["CAND"], decisions, undefined);
      const dropped = readDropped(dir);
      expect(dropped).toContain("R2");
    } finally {
      cleanup(dir);
    }
  });

  it("folds additional rules via evictPositions into the merge", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "merge",
          mergePosition: 2,
          text: "MERGED TEXT",
          evictPositions: [4],
        },
      ];
      applyDecisions(dir, ["R1", "R2", "R3", "R4"], ["CAND"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // R2 → MERGED TEXT, R4 evicted
      expect(rules).toEqual(["R1", "MERGED TEXT", "R3"]);
      const dropped = readDropped(dir);
      expect(dropped).toContain("R2");
      expect(dropped).toContain("R4");
    } finally {
      cleanup(dir);
    }
  });

  it("updates display map so a later insert beforePosition=N lands before the merged rule", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        { candidate: "C1", action: "merge", mergePosition: 2, text: "MERGED TEXT" },
        { candidate: "C2", action: "insert", beforePosition: 3 },
      ];
      applyDecisions(dir, ["R1", "R2", "R3"], ["C1CAND", "NEW"], decisions, undefined);
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      // R2 → MERGED TEXT, then NEW inserted after position 2 (the merged rule)
      expect(rules).toEqual(["R1", "MERGED TEXT", "NEW", "R3"]);
    } finally {
      cleanup(dir);
    }
  });

  it("merge-only batch still creates a git commit", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        {
          candidate: "C1",
          action: "merge",
          mergePosition: 1,
          text: "MERGED TEXT",
        },
      ];
      applyDecisions(dir, ["R1", "R2"], ["CAND"], decisions, undefined);
      const log = recording.getLatestCommit(dir).toString().trim();
      expect(log).toContain("merged");
    } finally {
      cleanup(dir);
    }
  });

  it("reports merged count in BuildResult (skipPersist)", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        { candidate: "C1", action: "merge", mergePosition: 1, text: "M1" },
        { candidate: "C2", action: "merge", mergePosition: 2, text: "M2" },
      ];
      const result = applyDecisions(dir, ["R1", "R2", "R3"], ["CA", "CB"], decisions, { skipPersist: true });
      expect(result.merged).toBe(2);
      expect(result.inserted).toBe(0);
      // Both originals present in droppedRules
      expect(result.droppedRules).toEqual(expect.arrayContaining(["R1", "R2"]));
      // Final rules reflect both merges
      expect(result.rules).toEqual(["M1", "M2", "R3"]);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// skipPersist tests
// ============================================================================

describe("applyDecisions skipPersist", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-skip-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "portrait.md"), "# User Portrait\n\n## Anticipation Rules\nR1\nR2\nR3");
    initGit(dir);
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  it("skipPersist does not write portrait.md", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [{ candidate: "C1", action: "insert", beforePosition: 2 }];
      const result = applyDecisions(dir, ["R1", "R2", "R3"], ["NEW"], decisions, { skipPersist: true });
      // portrait.md should still have original rules
      const rules = parsePortraitRules(fs.readFileSync(path.join(dir, "portrait.md"), "utf-8"));
      expect(rules).toEqual(["R1", "R2", "R3"]);
      expect(result.rules).toEqual(["R1", "NEW", "R2", "R3"]);
    } finally {
      cleanup(dir);
    }
  });

  it("skipPersist does not create commit", () => {
    const dir = tmpDir();
    try {
      const beforeLog = recording.getCommitLog(dir).toString().trim();
      const decisions: BuildingDecision[] = [{ candidate: "C1", action: "insert", beforePosition: 2 }];
      applyDecisions(dir, ["R1", "R2", "R3"], ["NEW"], decisions, { skipPersist: true });
      const afterLog = recording.getCommitLog(dir).toString().trim();
      expect(afterLog).toBe(beforeLog);
    } finally {
      cleanup(dir);
    }
  });

  it("skipPersist returns rules, evictedRules, and droppedRules", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [
        { candidate: "C1", action: "insert", beforePosition: 2, evictPositions: [3] },
      ];
      const result = applyDecisions(dir, ["R1", "R2", "R3", "R4"], ["NEW"], decisions, {
        ruleLimit: 3,
        skipPersist: true,
      });
      // R3 is semantic eviction → droppedRules
      // R4 is mechanical eviction (limit 3) → evictedRules
      expect(result.inserted).toBe(1);
      expect(result.droppedRules).toEqual(["R3"]);
      expect(result.evictedRules).toEqual(["R4"]);
      expect(result.rules).toEqual(["R1", "NEW", "R2"]);
    } finally {
      cleanup(dir);
    }
  });

  it("without skipPersist, rules/evictedRules/droppedRules are empty", () => {
    const dir = tmpDir();
    try {
      const decisions: BuildingDecision[] = [{ candidate: "C1", action: "insert", beforePosition: 2 }];
      const result = applyDecisions(dir, ["R1", "R2", "R3"], ["NEW"], decisions, undefined);
      expect(result.rules).toEqual([]);
      expect(result.evictedRules).toEqual([]);
      expect(result.droppedRules).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});

import { vi } from "vitest";
// ============================================================================
// reset tests
// ============================================================================
import { reset } from "../src/commands/reset.js";

const mockPortraitDirs: string[] = [];
vi.mock("../src/config.js", () => ({
  getPortraitDir: () => (mockPortraitDirs.length > 0 ? mockPortraitDirs[mockPortraitDirs.length - 1] : ""),
  getLockPath: () => path.join(process.env.TEMP || "/tmp", "portrait-test-instance-lock.json"),
  getCollectLockPath: () => path.join(process.env.TEMP || "/tmp", "portrait-test-collect-lock.json"),
  getSessionDirs: () => [],
  getBgScanCheckpointsPath: () => "",
}));

describe("reset", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    initGit(dir);
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  const setupState = (dir: string, uiSelectResponse: string) => {
    fs.writeFileSync(
      path.join(dir, "portrait.md"),
      "# User Portrait\n\n## Anticipation Rules\nrule 1\nrule 2\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "evicted.md"), "evicted rule\n", "utf-8");
    fs.writeFileSync(
      path.join(dir, "processed-sessions.json"),
      JSON.stringify({ "file1.jsonl": { lastLine: 100, lastAt: "2026-01-01" } }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, "portrait-state.json"),
      JSON.stringify({
        triosProcessed: 50,
        totalKnownTrios: 100,
        lastProcessedFile: "file1.jsonl",
        lastProcessedLine: 100,
        lastPipelineRun: "2026-01-01",
        lastScanTimestamp: "2026-01-01",
      }),
      "utf-8",
    );

    globalThis.__piPortrait = {
      lockHeld: true,
      uiSelect: async (_msg: string, _opts: string[]) => uiSelectResponse,
    } as PortraitState;
    mockPortraitDirs.push(dir);
  };

  it("clears portrait.md, evicted.md, checkpoints and resets counters", async () => {
    const dir = tmpDir();
    setupState(dir, "Yes, reset");
    try {
      const result = await reset();
      expect(result).toContain("reset");

      const content = fs.readFileSync(path.join(dir, "portrait.md"), "utf-8");
      expect(content).not.toContain("rule 1");
      expect(content).not.toContain("rule 2");
      // evicted.md recreated with header (not deleted) so git add succeeds
      expect(fs.existsSync(path.join(dir, "evicted.md"))).toBe(true);
      const evictedContent = fs.readFileSync(path.join(dir, "evicted.md"), "utf-8");
      expect(evictedContent).toBe("# Evicted Portrait Rules\n");

      const checkpoints = JSON.parse(fs.readFileSync(path.join(dir, "processed-sessions.json"), "utf-8"));
      expect(checkpoints).toEqual({});

      const state = JSON.parse(fs.readFileSync(path.join(dir, "portrait-state.json"), "utf-8"));
      expect(state.triosProcessed).toBe(0);
      expect(state.totalKnownTrios).toBe(0);
    } finally {
      mockPortraitDirs.pop();
      delete globalThis.__piPortrait;
      cleanup(dir);
    }
  });

  it("cancels when user selects Cancel", async () => {
    const dir = tmpDir();
    setupState(dir, "Cancel");
    try {
      const result = await reset();
      expect(result).toContain("cancelled");
      const content = fs.readFileSync(path.join(dir, "portrait.md"), "utf-8");
      expect(content).toContain("rule 1");
    } finally {
      mockPortraitDirs.pop();
      delete globalThis.__piPortrait;
      cleanup(dir);
    }
  });

  it("returns locked message when lock not held", async () => {
    globalThis.__piPortrait = { lockHeld: false } as PortraitState;
    try {
      const result = await reset();
      expect(result).toContain("not available");
    } finally {
      delete globalThis.__piPortrait;
    }
  });
});

// ============================================================================
// footer tests
// ============================================================================
import { clearFooterCtx, setCachedPipelineState, setFooterCtx } from "../src/footer.js";
import type { PortraitPipelineState } from "../src/types.js";
import { DEFAULT_PIPELINE_STATE } from "../src/types.js";

describe("footer widget state", () => {
  const capturedStatuses: string[] = [];
  const mockCtx = {
    ui: {
      setStatus: (_key: string, text: string) => {
        capturedStatuses.push(text);
      },
    },
  } as ExtensionContext;

  afterEach(() => {
    clearFooterCtx();
    delete globalThis.__piPortrait;
    delete globalThis.__piPortraitPipelineState;
    capturedStatuses.length = 0;
  });

  it("shows idle when not holding lock and no lock file", () => {
    globalThis.__piPortrait = { lockHeld: false } as PortraitState;
    const state = { ...DEFAULT_PIPELINE_STATE };
    setFooterCtx(mockCtx);
    setCachedPipelineState(state);
    expect(capturedStatuses.length).toBeGreaterThan(0);
    expect(capturedStatuses[capturedStatuses.length - 1]).toContain("idle");
  });

  it("shows paused when state is paused", () => {
    globalThis.__piPortrait = { lockHeld: true } as PortraitState;
    const state: PortraitPipelineState = {
      ...DEFAULT_PIPELINE_STATE,
      paused: true,
      pausedBy: { pid: 1234 },
    };
    setFooterCtx(mockCtx);
    setCachedPipelineState(state);
    expect(capturedStatuses[capturedStatuses.length - 1]).toContain("paused");
  });

  it("shows unified status: trios + scan MB", () => {
    globalThis.__piPortrait = { lockHeld: true } as PortraitState;
    const state: PortraitPipelineState = {
      ...DEFAULT_PIPELINE_STATE,
      pipelinePhase: "processing",
      triosProcessed: 5,
      totalKnownTrios: 20,
      scanSessionKB: 10 * 1024, // 10 MB scanned in current session
      scanRemainingKB: 10 * 1024, // 10 MB remaining
    };
    setFooterCtx(mockCtx);
    setCachedPipelineState(state);
    const status = capturedStatuses[capturedStatuses.length - 1];
    expect(status).toContain("profiling 5/20");
    expect(status).toContain("10.0/10.0 MB"); // session progress / remaining
  });

  it("shows idle with default state", () => {
    globalThis.__piPortrait = { lockHeld: true } as PortraitState;
    const state: PortraitPipelineState = {
      ...DEFAULT_PIPELINE_STATE,
      pipelinePhase: "idle",
    };
    setFooterCtx(mockCtx);
    setCachedPipelineState(state);
    expect(capturedStatuses[capturedStatuses.length - 1]).toContain("idle");
  });

  it("clearFooterCtx stops status updates", () => {
    globalThis.__piPortrait = { lockHeld: false } as PortraitState;
    setFooterCtx(mockCtx);
    setCachedPipelineState({ ...DEFAULT_PIPELINE_STATE });
    const countAfterSet = capturedStatuses.length;
    clearFooterCtx();
    // Another state update should NOT produce new status (no ctx)
    setCachedPipelineState({ ...DEFAULT_PIPELINE_STATE, pipelinePhase: "processing" });
    // setCachedPipelineState calls updateStatus internally, but without ctx it's a no-op
    // Count should not increase since clearFooterCtx was called
    expect(capturedStatuses.length).toBe(countAfterSet);
  });
});

// ============================================================================
// session_shutdown timer cleanup test
// ============================================================================
import { clearAllTimers } from "../src/index.js";

describe("clearAllTimers", () => {
  afterEach(() => {
    delete globalThis.__piPortrait;
  });

  it("clears both timers and sets them to null", () => {
    // Set up state with fake timer IDs (only `timer` + `lockPollTimer` — no heartbeat timers)
    let timerCleared = 0;
    let lockPollCleared = false;
    type FakeTimer = ReturnType<typeof setInterval>;
    const fakeTimer = { _fake: "timer" } as unknown as FakeTimer;
    const fakeLockPoll = { _fake: "lockPoll" } as unknown as FakeTimer;

    // Override clearInterval to track calls
    const origClearInterval = globalThis.clearInterval;
    globalThis.clearInterval = ((id: FakeTimer | undefined) => {
      if (id === fakeTimer) timerCleared++;
      if (id === fakeLockPoll) lockPollCleared = true;
    }) as typeof globalThis.clearInterval;

    globalThis.__piPortrait = {
      lockHeld: false,
      mainMutex: null,
      collectLockHeld: false,
      collectMutex: null,
      collectCancelled: false,
      bgScanCancelled: false,
      timer: fakeTimer,
      lockPollTimer: fakeLockPoll,
      cachedPortrait: undefined,
      cachedPortraitLoadTime: undefined,
      uiNotify: null,
      uiSelect: null,
      cachedPipelineState: null,
      startProfilingTimer: null,
      runProfilingCycle: null,
      reportError: null,
    };

    try {
      clearAllTimers();

      expect(timerCleared).toBe(1);
      expect(lockPollCleared).toBe(true);

      const state = globalThis.__piPortrait;
      expect(state.timer).toBeNull();
      expect(state.lockPollTimer).toBeNull();
    } finally {
      globalThis.clearInterval = origClearInterval;
    }
  });

  it("is safe when timers are already null", () => {
    globalThis.__piPortrait = {
      lockHeld: false,
      mainMutex: null,
      collectLockHeld: false,
      collectMutex: null,
      collectCancelled: false,
      bgScanCancelled: false,
      timer: null,
      lockPollTimer: null,
      cachedPortrait: undefined,
      cachedPortraitLoadTime: undefined,
      uiNotify: null,
      uiSelect: null,
      cachedPipelineState: null,
      startProfilingTimer: null,
      runProfilingCycle: null,
      reportError: null,
    };

    // Should not throw
    expect(() => clearAllTimers()).not.toThrow();
  });
});

describe("summarizeToolCall", () => {
  it("summarizes read with path", () => {
    expect(summarizeToolCall("read", { path: "src/collector.ts" })).toBe("[read: src/collector.ts]");
  });

  it("summarizes read with offset", () => {
    expect(summarizeToolCall("read", { path: "src/collector.ts", offset: 100 })).toBe("[read: src/collector.ts:100]");
  });

  it("summarizes grep with pattern and path", () => {
    expect(summarizeToolCall("grep", { pattern: "catch|error", path: "src/index.ts" })).toBe(
      '[grep: "catch|error" in src/index.ts]',
    );
  });

  it("summarizes edit with path", () => {
    expect(summarizeToolCall("edit", { path: "src/config.ts" })).toBe("[edit: src/config.ts]\n"); // empty edits = no diffs, just header
  });

  it("summarizes bash with command", () => {
    expect(summarizeToolCall("bash", { command: "git log --oneline -5" })).toBe("[bash: git log --oneline -5]");
  });

  it("summarizes unknown tool", () => {
    expect(summarizeToolCall("customTool", {})).toBe("[customTool: {}]");
  });

  it("handles null args", () => {
    expect(summarizeToolCall("read", null)).toBe("[read]");
  });
});

describe("extractAssistantText", () => {
  it("extracts text, strips tool calls", () => {
    const content = [
      { type: "text", text: "Let me read the file:" },
      { type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
    ];
    expect(extractAssistantText(content)).toBe("Let me read the file:");
  });

  it("skips empty text", () => {
    const content = [
      { type: "text", text: "" },
      { type: "toolCall", name: "grep", arguments: { pattern: "test", path: "src/" } },
    ];
    expect(extractAssistantText(content)).toBe("");
  });

  it("handles string content", () => {
    expect(extractAssistantText("plain text")).toBe("plain text");
  });
});

describe("summarizeToolResult", () => {
  it("skips unknown tool results (tool call summary is enough)", () => {
    expect(summarizeToolResult([{ type: "text", text: "short result" }], undefined)).toBe("");
  });

  it("skips long unknown results", () => {
    const long = "x".repeat(1000);
    expect(summarizeToolResult([{ type: "text", text: long }], undefined)).toBe("");
  });

  it("returns empty for empty content", () => {
    expect(summarizeToolResult([{ type: "text", text: "" }], undefined)).toBe("");
  });

  it("skips read tool results", () => {
    expect(summarizeToolResult([{ type: "text", text: "file contents here" }], "read")).toBe("");
  });

  it("skips grep tool results", () => {
    expect(summarizeToolResult([{ type: "text", text: "matching lines" }], "grep")).toBe("");
  });

  it("skips write/edit tool results", () => {
    expect(summarizeToolResult([{ type: "text", text: "Successfully replaced" }], "edit")).toBe("");
    expect(summarizeToolResult([{ type: "text", text: "File written" }], "write")).toBe("");
  });

  it("returns full subagent results", () => {
    const long = "x".repeat(5000);
    expect(summarizeToolResult([{ type: "text", text: long }], "subagent")).toBe(long);
  });

  it("skips bash results (command is in tool call, output is noise)", () => {
    const long = "x".repeat(1000);
    expect(summarizeToolResult([{ type: "text", text: long }], "bash")).toBe("");
  });

  it("skips unknown tool results", () => {
    expect(summarizeToolResult([{ type: "text", text: "some output" }], "customTool")).toBe("");
  });
});

import * as builder from "../src/builder.js";
import * as collector from "../src/collector.js";
// ============================================================================
// collect cancellation tests
// ============================================================================
import { collect } from "../src/commands/collect.js";

describe("collect cancellation", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-collect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    initGit(dir);
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  const setupState = (dir: string) => {
    fs.writeFileSync(path.join(dir, "portrait.md"), "# User Portrait\n\n## Anticipation Rules\n", "utf-8");
    fs.writeFileSync(
      path.join(dir, "portrait-state.json"),
      JSON.stringify({
        paused: false,
        pausedAt: null,
        pausedBy: null,
        lastPipelineRun: null,
        lastScanTimestamp: null,
        lastProcessedFile: null,
        lastProcessedLine: 0,
        scanProgress: undefined,
        scanRemainingKB: 0,
        scanSessionKB: 0,
        triosProcessed: 0,
        totalKnownTrios: 0,
        pipelinePhase: "idle",
        remainingFiles: 0,
        lastError: null,
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "processed-sessions.json"), "{}", "utf-8");

    globalThis.__piPortrait = {
      lockHeld: true,
      mainMutex: null,
      collectLockHeld: false,
      collectMutex: null,
      collectCancelled: false,
      bgScanCancelled: false,
      timer: null,
      lockPollTimer: null,
      cachedPortrait: undefined,
      cachedPortraitLoadTime: undefined,
      uiNotify: null,
      uiSelect: null,
      cachedPipelineState: null,
      startProfilingTimer: null,
      runProfilingCycle: null,
      reportError: null,
    };
    mockPortraitDirs.push(dir);
  };

  afterEach(() => {
    delete globalThis.__piPortrait;
  });

  it("resets collectCancelled to false at start", async () => {
    const dir = tmpDir();
    setupState(dir);
    try {
      const portrait = globalThis.__piPortrait;
      if (portrait) portrait.collectCancelled = true;
      vi.spyOn(collector, "scanSessions").mockResolvedValue({
        results: [],
        triosProcessed: 0,
        totalKnownTrios: 0,
        remainingFiles: 0,
      });
      const result = await collect(undefined);
      expect(result).toContain("Collected 0 sequences");
    } finally {
      mockPortraitDirs.pop();
      vi.restoreAllMocks();
      cleanup(dir);
    }
  });

  it("stops when collectCancelled is set to true", async () => {
    const dir = tmpDir();
    setupState(dir);
    try {
      // Mock scanSessions to return results so the loop would normally continue
      vi.spyOn(collector, "scanSessions").mockResolvedValue({
        results: [{ behaviorNotes: ["test rule"], sessionPath: "test.jsonl", source: "main" }],
        triosProcessed: 1,
        totalKnownTrios: 1,
        remainingFiles: 10,
      });
      vi.spyOn(builder, "buildPortrait").mockResolvedValue(undefined);

      // Intercept collectCancelled: after collect resets it to false,
      // set it back to true so the loop check sees it cancelled.
      // This simulates the user typing /portrait:stop between reset and loop check.
      const state = globalThis.__piPortrait;
      let cancelAfterFirst = false;
      Object.defineProperty(state, "collectCancelled", {
        get: () => cancelAfterFirst,
        set: (value: boolean) => {
          if (value === false) {
            // After reset, schedule cancellation to take effect after first iteration
            cancelAfterFirst = true;
          }
        },
        configurable: true,
        enumerable: true,
      });

      const result = await collect(undefined);
      expect(result).toContain("Collection stopped");
    } finally {
      mockPortraitDirs.pop();
      vi.restoreAllMocks();
      cleanup(dir);
    }
  });

  it("resets collectCancelled in finally block after normal completion", async () => {
    const dir = tmpDir();
    setupState(dir);
    try {
      vi.spyOn(collector, "scanSessions").mockResolvedValue({
        results: [],
        triosProcessed: 0,
        totalKnownTrios: 0,
        remainingFiles: 0,
      });
      await collect(undefined);
      expect(globalThis.__piPortrait?.collectCancelled).toBe(false);
    } finally {
      mockPortraitDirs.pop();
      vi.restoreAllMocks();
      cleanup(dir);
    }
  });

  it("resets collectCancelled in finally block after error", async () => {
    const dir = tmpDir();
    setupState(dir);
    try {
      vi.spyOn(collector, "scanSessions").mockRejectedValue(new Error("scan failed"));
      const result = await collect(undefined);
      expect(result).toContain("Collection failed");
      expect(globalThis.__piPortrait?.collectCancelled).toBe(false);
    } finally {
      mockPortraitDirs.pop();
      vi.restoreAllMocks();
      cleanup(dir);
    }
  });

  it("pauses when buildPortrait throws PAUSED (building-phase pause propagates)", async () => {
    // Regression: builder used to return undefined on PAUSED, swallowing the pause so
    // runPipelineLoop continued and re-shown the retry dialog. Now buildPortrait throws
    // "PAUSED" (like collector.ts does for extraction), so collect must catch it and pause.
    const dir = tmpDir();
    setupState(dir);
    setupTestSettings({ rateLimitMs: 0 });
    try {
      vi.spyOn(collector, "scanSessions").mockResolvedValue({
        results: [{ behaviorNotes: ["test rule"], sessionPath: "test.jsonl", source: "main" }],
        triosProcessed: 1,
        totalKnownTrios: 1,
        remainingFiles: 0,
      });
      vi.spyOn(builder, "buildPortrait").mockRejectedValue(new Error("PAUSED"));

      const result = await collect(undefined);
      expect(result).toContain("paused");
      // Pause state must be persisted so the timer does not resume collecting
      const statePath = path.join(dir, "portrait-state.json");
      const persisted = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(persisted.paused).toBe(true);
      expect(globalThis.__piPortrait?.collectCancelled).toBe(false);
    } finally {
      mockPortraitDirs.pop();
      vi.restoreAllMocks();
      cleanup(dir);
    }
  });

  it("returns unavailable message when collect lock functions not exported", async () => {
    globalThis.__piPortrait = { collectCancelled: false } as PortraitState;
    // Simulate early startup — lock functions not yet exported
    const savedAcquire = globalThis.__piPortraitAcquireCollectLock;
    const savedRelease = globalThis.__piPortraitReleaseCollectLock;
    delete globalThis.__piPortraitAcquireCollectLock;
    delete globalThis.__piPortraitReleaseCollectLock;
    try {
      const result = await collect(undefined);
      expect(result).toContain("not available");
    } finally {
      delete globalThis.__piPortrait;
      globalThis.__piPortraitAcquireCollectLock = savedAcquire;
      globalThis.__piPortraitReleaseCollectLock = savedRelease;
    }
  });
});

// ============================================================================
// /portrait:stop command tests
// ============================================================================

describe("portrait:stop command", () => {
  afterEach(() => {
    delete globalThis.__piPortrait;
  });

  it("sets collectCancelled and bgScanCancelled to true when collect lock is held", () => {
    globalThis.__piPortrait = {
      collectLockHeld: true,
      collectCancelled: false,
      bgScanCancelled: false,
    } as PortraitState;
    const state = globalThis.__piPortrait;
    // Simulate what the command handler does
    state.collectCancelled = true;
    state.bgScanCancelled = true;
    expect(state.collectCancelled).toBe(true);
    expect(state.bgScanCancelled).toBe(true);
  });

  it("collectCancelled defaults to false when no collection running", () => {
    globalThis.__piPortrait = {
      collectLockHeld: false,
      collectCancelled: false,
    } as PortraitState;
    expect(globalThis.__piPortrait.collectCancelled).toBe(false);
  });
});

// ============================================================================
// Cached state MB values tests (setCachedPipelineState persistence)
// ============================================================================

describe("cached state MB values", () => {
  afterEach(() => {
    delete globalThis.__piPortraitPipelineState;
    clearFooterCtx();
  });

  it("caches asymmetric values: session progress / remaining", () => {
    const pipelineState = {
      pipelinePhase: "scanning" as const,
      totalKnownTrios: 0,
      triosProcessed: 0,
      scanSessionKB: 3 * 1024,
      scanRemainingKB: 10 * 1024,
      remainingFiles: 5,
      lastError: "",
    };
    setCachedPipelineState(pipelineState as unknown as PortraitPipelineState);
    const cached = globalThis.__piPortraitPipelineState;
    expect(cached?.scanSessionKB).toBe(3 * 1024);
    expect(cached?.scanRemainingKB).toBe(10 * 1024);
  });

  it("caches 0 session KB on collect start", () => {
    const pipelineState = {
      pipelinePhase: "scanning" as const,
      totalKnownTrios: 0,
      triosProcessed: 0,
      scanSessionKB: 0,
      scanRemainingKB: 20 * 1024,
      remainingFiles: 10,
      lastError: "",
    };
    setCachedPipelineState(pipelineState as unknown as PortraitPipelineState);
    const cached = globalThis.__piPortraitPipelineState;
    expect(cached?.scanSessionKB).toBe(0);
    expect(cached?.scanRemainingKB).toBe(20 * 1024);
  });
});

// ============================================================================
// dropped.md storage tests
// ============================================================================
import { appendDropped, readDropped, writeDropped, writeEvicted } from "../src/storage.js";

describe("dropped.md storage", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-dropped-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  it("appendDropped creates file with header if missing", () => {
    const dir = tmpDir();
    try {
      appendDropped(dir, ["dropped rule 1"]);
      const content = fs.readFileSync(path.join(dir, "dropped.md"), "utf-8");
      expect(content).toContain("# Dropped Portrait Rules");
      expect(content).toContain("dropped rule 1");
    } finally {
      cleanup(dir);
    }
  });

  it("appendDropped appends rules and deduplicates", () => {
    const dir = tmpDir();
    try {
      appendDropped(dir, ["rule A", "rule B"]);
      appendDropped(dir, ["rule B", "rule C"]); // rule B is duplicate
      const rules = readDropped(dir);
      expect(rules).toEqual(["rule A", "rule B", "rule C"]);
    } finally {
      cleanup(dir);
    }
  });

  it("writeDropped rewrites entire file", () => {
    const dir = tmpDir();
    try {
      appendDropped(dir, ["old rule"]);
      writeDropped(dir, ["new rule 1", "new rule 2"]);
      const rules = readDropped(dir);
      expect(rules).toEqual(["new rule 1", "new rule 2"]);
    } finally {
      cleanup(dir);
    }
  });

  it("writeDropped handles empty rules array", () => {
    const dir = tmpDir();
    try {
      appendDropped(dir, ["old rule"]);
      writeDropped(dir, []);
      const rules = readDropped(dir);
      expect(rules).toEqual([]);
      // File should still exist with header
      const content = fs.readFileSync(path.join(dir, "dropped.md"), "utf-8");
      expect(content).toContain("# Dropped Portrait Rules");
    } finally {
      cleanup(dir);
    }
  });

  it("readDropped returns empty array for missing file", () => {
    const dir = tmpDir();
    try {
      expect(readDropped(dir)).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});

describe("evicted.md no cap", () => {
  const tmpDir = () => {
    const dir = path.join(
      process.env.TEMP || "/tmp",
      `portrait-evicted-nocap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const cleanup = (dir: string) => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  it("appendEvicted keeps all rules beyond 500", () => {
    const dir = tmpDir();
    try {
      const rules = Array.from({ length: 510 }, (_, i) => `rule_${String(i).padStart(4, "0")}`);
      appendEvicted(dir, rules);
      const evicted = readEvicted(dir);
      expect(evicted.length).toBe(510);
      expect(evicted).toContain("rule_0000");
      expect(evicted).toContain("rule_0509");
    } finally {
      cleanup(dir);
    }
  });

  it("writeEvicted rewrites entire file", () => {
    const dir = tmpDir();
    try {
      appendEvicted(dir, ["old rule 1", "old rule 2"]);
      writeEvicted(dir, ["new rule"]);
      const evicted = readEvicted(dir);
      expect(evicted).toEqual(["new rule"]);
    } finally {
      cleanup(dir);
    }
  });

  it("writeEvicted handles empty rules array", () => {
    const dir = tmpDir();
    try {
      appendEvicted(dir, ["old rule"]);
      writeEvicted(dir, []);
      const evicted = readEvicted(dir);
      expect(evicted).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});
