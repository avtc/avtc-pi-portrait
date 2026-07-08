// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { appendDebug } from "./debug.js";
import { reportError } from "./error.js";
import { commitPortrait } from "./git.js";
import {
  buildSingleUserMessage,
  callPortraitLlm,
  makeDebugStreamDumpSink,
  NO_DEBUG_STREAM_SINK,
  PAUSED,
  setDebugStreamSink,
} from "./llm-call.js";
import { BUILDING_PROMPT } from "./prompts.js";
import { getPortraitSettings } from "./settings-ui.js";
import { appendDropped, appendEvicted, parsePortraitRules, readPortrait, writePortrait } from "./storage.js";
import type { BuildingDecision, BuildingResponse } from "./types.js";

export async function buildPortrait(
  portraitDir: string,
  candidates: string[],
  options:
    | {
        skipPersist?: boolean;
        modelOverride?: string;
        maxTokensOverride?: number | null;
        timeoutOverride?: number | null;
        debugDumpPath?: string;
      }
    | undefined,
): Promise<BuildResult | undefined> {
  const settings = getPortraitSettings();
  const existingContent = readPortrait(portraitDir) ?? "";
  const existingRules = parsePortraitRules(existingContent);

  if (candidates.length === 0) return undefined;

  // Build numbered portrait
  const numberedPortrait = existingRules.map((rule, i) => `${i + 1}. ${rule}`).join("\n");

  // Build candidates list
  const numberedCandidates = candidates.map((c, i) => `C${i + 1}: ${c}`).join("\n");

  // Build prompt
  const prompt = BUILDING_PROMPT.replace("{portrait}", numberedPortrait || "(empty)").replace(
    "{candidates}",
    numberedCandidates,
  );

  // Define return tool
  let buildingResponse: BuildingResponse | null = null;

  const returnBuildingTool: AgentTool = {
    name: "return_building",
    label: "Return building decisions",
    description: "Return building decisions.",
    parameters: Type.Object({
      decisions: Type.Array(
        Type.Object({
          candidate: Type.String(),
          action: Type.Union([Type.Literal("insert"), Type.Literal("merge"), Type.Literal("skip")]),
          beforePosition: Type.Optional(Type.Union([Type.Number(), Type.String()])),
          evictPositions: Type.Optional(Type.Array(Type.Union([Type.Number(), Type.String()]))),
          mergePosition: Type.Optional(Type.Number()),
          text: Type.Optional(Type.String()),
        }),
      ),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const typedParams = params as { decisions: BuildingDecision[] };
      buildingResponse = { decisions: typedParams.decisions };
      return {
        content: [{ type: "text" as const, text: `Applied ${typedParams.decisions.length} decisions` }],
        details: undefined,
      };
    },
  };

  // Build messages
  const messages = buildSingleUserMessage(prompt);

  // Debug dump (maintenance backfill): capture input + streamed output
  const dumpPath = options?.debugDumpPath;
  if (dumpPath) {
    appendDebug(
      dumpPath,
      `\n=== Backfill Input (${candidates.length} candidates) ===\n--- SYSTEM PROMPT ---\n${BUILDING_PROMPT}\n\n--- TOOL ---\n${JSON.stringify({ name: "return_building", description: "Return building decisions.", input_schema: { type: "object", properties: { decisions: { type: "array", items: { type: "object", properties: { candidate: { type: "string" }, action: { type: "string" }, beforePosition: { type: ["number", "string"] }, evictPositions: { type: "array", items: { type: ["number", "string"] } }, mergePosition: { type: "number" }, text: { type: "string" } }, required: ["candidate", "action"] } } }, required: ["decisions"] } }, null, 2)}\n\n--- USER MESSAGE (filled prompt) ---\n${prompt}\n`,
    );
    setDebugStreamSink(makeDebugStreamDumpSink(dumpPath));
  }

  // Call shared LLM helper with validation loop (max 3 retries)
  let response: BuildingResponse | typeof PAUSED | undefined;
  let validationError: string | null = null;
  const maxValidationRetries = 3;
  let validationAttempts = 0;

  try {
    while (validationAttempts < maxValidationRetries) {
      // If there was a validation error, re-call LLM with error context
      if (validationError) {
        if (dumpPath)
          appendDebug(dumpPath, `\n=== Backfill validation retry ${validationAttempts + 1}: ${validationError} ===\n`);
        messages.push({
          role: "user",
          content: [{ type: "text", text: validationError }],
          timestamp: Date.now(),
        });
      }

      response = await callPortraitLlm<BuildingResponse>(
        messages,
        BUILDING_PROMPT.split("\n")[0],
        returnBuildingTool,
        () => buildingResponse ?? undefined,
        "Previous building failed. Please return valid JSON using return_building.",
        options?.modelOverride,
        options?.maxTokensOverride,
        options?.timeoutOverride,
      );

      if (response === PAUSED) throw new Error("PAUSED"); // propagate pause (caller catches "PAUSED")
      if (!response || response.decisions.length === 0) {
        return undefined; // LLM failed after retries
      }

      // Validate decisions
      const validation = validateDecisions(response.decisions, existingRules.length, candidates.length);
      if (validation.ok) {
        if (dumpPath) {
          const decisionsSummary = response.decisions
            .map(
              (d) =>
                `${d.action} ${d.candidate}${d.action === "merge" ? ` into ${d.mergePosition} as "${d.text}"` : ""}${d.beforePosition !== undefined ? ` before ${d.beforePosition}` : ""}${d.evictPositions?.length ? ` (evict ${d.evictPositions.join(",")})` : ""}`,
            )
            .join("\n");
          appendDebug(
            dumpPath,
            `\n=== Backfill Output (${response.decisions.length} decisions) ===\n${decisionsSummary}\n`,
          );
        }
        return applyDecisions(portraitDir, existingRules, candidates, response.decisions, {
          ruleLimit: settings.ruleLimit,
          skipPersist: options?.skipPersist,
        });
      }

      // Validation failed — re-call LLM with error context
      validationError = validation.error;
      validationAttempts++;
    }
  } finally {
    if (dumpPath) setDebugStreamSink(NO_DEBUG_STREAM_SINK);
  }

  // Exhausted validation retries — give up on this batch
  reportError(`Building validation failed after ${maxValidationRetries} attempts`, "building error");
}

const CANDIDATE_REF_RE = /^C(\d+)$/;

/** Resolve a candidate ID (e.g. "C1") to its text from the candidates array. */
function resolveCandidateText(id: string, candidates: string[]): string | undefined {
  const match = id.match(CANDIDATE_REF_RE);
  if (!match) return undefined;
  const idx = parseInt(match[1], 10) - 1; // C1 → index 0
  if (idx < 0 || idx >= candidates.length) return undefined; // C0 or out of range
  return candidates[idx];
}

export interface BuildResult {
  inserted: number;
  merged: number; // Candidates folded into existing rules via merge action
  evicted: number;
  rules: string[]; // Final portrait rules (populated only with skipPersist)
  evictedRules: string[]; // Mechanically evicted texts (populated only with skipPersist)
  droppedRules: string[]; // Semantically evicted + merge-replaced originals (populated only with skipPersist)
}

export function applyDecisions(
  portraitDir: string,
  existingRules: string[],
  candidates: string[],
  decisions: BuildingDecision[],
  options: { ruleLimit?: number; skipPersist?: boolean } | undefined,
): BuildResult {
  const ruleLimit = options?.ruleLimit ?? getPortraitSettings().ruleLimit;
  const rules = [...existingRules];

  // --- Phase 1: Build display-number → rule-text map ---
  const displayMap = new Map<number, string>();
  for (let i = 0; i < existingRules.length; i++) {
    displayMap.set(i + 1, existingRules[i]);
  }

  // --- Phase 2: Apply merges (replace target rule text in place) ---
  // Process merges before inserts/evictions so mergePosition resolves cleanly
  // to the original text. The replaced originals are recorded for dropped.md
  // (same accounting as semantic eviction), and the display map is updated to
  // the new text so later position refs (insert/evict) find the merged rule.
  const mergedOriginals: string[] = [];
  for (const decision of decisions) {
    if (decision.action !== "merge") continue;
    const mergePos = decision.mergePosition;
    const newText = decision.text;
    if (mergePos === undefined || newText === undefined) continue;
    const originalText = displayMap.get(mergePos);
    if (originalText === undefined) continue; // target already gone (cross-decision conflict)
    const idx = rules.indexOf(originalText);
    if (idx < 0) continue; // already removed
    rules[idx] = newText; // replace in place — count unchanged
    mergedOriginals.push(originalText);
    displayMap.set(mergePos, newText); // point position at new text
  }

  // --- Phase 3: Insert candidates by text anchor lookup ---
  const candidatePositions = new Map<string, number>();

  for (const decision of decisions) {
    if (decision.action !== "insert") continue; // skip + merge handled elsewhere

    const candidateText = resolveCandidateText(decision.candidate, candidates);
    if (candidateText === undefined) continue;

    let insertPos = rules.length; // default: append at end

    if (decision.beforePosition !== undefined) {
      if (typeof decision.beforePosition === "number") {
        if (decision.beforePosition <= 1) {
          insertPos = 0; // insert at very start (before rule 1; clamps lower)
        } else {
          const anchorText = displayMap.get(decision.beforePosition);
          if (anchorText) {
            const anchorIdx = rules.indexOf(anchorText);
            if (anchorIdx >= 0) {
              insertPos = anchorIdx; // insert before anchor
            }
            // If anchor not found, append at end
          }
        }
      } else if (typeof decision.beforePosition === "string") {
        // String ref: insert before referenced candidate's position
        if (decision.beforePosition !== undefined && candidatePositions.has(decision.beforePosition)) {
          const beforePos = candidatePositions.get(decision.beforePosition);
          if (beforePos !== undefined) insertPos = beforePos;
        }
      }
    }

    rules.splice(insertPos, 0, candidateText);
    candidatePositions.set(decision.candidate, insertPos);
  }

  // --- Phase 4: Evict rules by text lookup (insert + merge evictPositions) ---
  const semanticEvicted = new Set<string>();
  for (const decision of decisions) {
    if (!decision.evictPositions) continue; // both insert and merge may carry evictPositions
    for (const ref of decision.evictPositions) {
      let evictText: string | undefined;
      if (typeof ref === "number") {
        evictText = displayMap.get(ref);
      } else {
        // String ref: resolve to candidate text
        evictText = resolveCandidateText(ref, candidates);
      }
      if (evictText) {
        const idx = rules.indexOf(evictText);
        if (idx >= 0) {
          rules.splice(idx, 1);
          semanticEvicted.add(evictText);
        }
      }
    }
  }

  // --- Phase 5: Mechanical eviction ---
  const mechanicalEvicted: string[] = [];
  while (rules.length > ruleLimit) {
    const evictedRule = rules.pop();
    if (evictedRule) mechanicalEvicted.push(evictedRule);
  }

  // --- Phase 6: Persist ---
  const mergeCount = mergedOriginals.length;
  if (!options?.skipPersist) {
    writePortrait(portraitDir, rules);

    const allDropped = [...mergedOriginals, ...semanticEvicted];
    if (allDropped.length > 0) {
      appendDropped(portraitDir, allDropped);
    }
    if (mechanicalEvicted.length > 0) {
      appendEvicted(portraitDir, mechanicalEvicted);
    }

    // --- Phase 7: Commit ---
    const insertCount = candidatePositions.size;
    if (insertCount > 0 || mergeCount > 0) {
      const parts: string[] = [];
      if (insertCount > 0) parts.push(`${insertCount} rule${insertCount > 1 ? "s" : ""} added`);
      if (mergeCount > 0) parts.push(`${mergeCount} rule${mergeCount > 1 ? "s" : ""} merged`);
      if (semanticEvicted.size > 0) parts.push(`${semanticEvicted.size} dropped`);
      if (mechanicalEvicted.length > 0) parts.push(`${mechanicalEvicted.length} evicted`);
      commitPortrait(portraitDir, `portrait: ${parts.join(", ")}`);
    }
  }

  const insertCount = candidatePositions.size;
  const evictCount = semanticEvicted.size + mechanicalEvicted.length;
  return {
    inserted: insertCount,
    merged: mergeCount,
    evicted: evictCount,
    rules: options?.skipPersist ? rules : [],
    evictedRules: options?.skipPersist ? mechanicalEvicted : [],
    droppedRules: options?.skipPersist ? [...mergedOriginals, ...semanticEvicted] : [],
  };
}

/**
 * Validate building decisions against the portrait rule set.
 *
 * Rules enforced:
 * 1. evictPositions only valid with insert or merge action
 * 2. String refs must not target skipped candidates
 * 3. Self-reference (C1 evicting C1) is rejected
 * 4. Numeric entries must be in range [1, portraitRuleCount]
 * 5. No duplicate entries in evictPositions
 * 6. String entries must match C\d+ pattern
 * 7. String refs must be within candidate range (when candidateCount provided)
 * 8. String beforePosition must match C\d+ pattern
 * 9. String beforePosition must not reference skipped candidate
 * 10. String beforePosition must be within candidate range (when candidateCount provided)
 * 11. merge requires integer mergePosition in range [1, portraitRuleCount]
 * 12. merge requires non-empty single-line text
 * 13. merge must not set beforePosition (it replaces in place)
 * 14. merge must not evict its own mergePosition
 */
export function validateDecisions(
  decisions: BuildingDecision[],
  portraitRuleCount: number,
  candidateCount: number | undefined,
): { ok: true } | { ok: false; error: string } {
  // Collect skipped candidates
  const skipped = new Set<string>();
  for (const decision of decisions) {
    if (decision.action === "skip") {
      skipped.add(decision.candidate);
    }
  }

  for (const decision of decisions) {
    // Rule 1: evictPositions only valid with insert or merge
    if (
      decision.action !== "insert" &&
      decision.action !== "merge" &&
      decision.evictPositions &&
      decision.evictPositions.length > 0
    ) {
      return {
        ok: false,
        error: `Candidate ${decision.candidate} has evictPositions but action is "${decision.action}". evictPositions is only valid with action "insert" or "merge".`,
      };
    }

    if (decision.action === "skip") continue;

    // merge-specific validation
    if (decision.action === "merge") {
      // beforePosition is meaningless for merge (it replaces in place, no insertion)
      if (decision.beforePosition !== undefined) {
        return {
          ok: false,
          error: `Candidate ${decision.candidate} uses beforePosition with action "merge". merge replaces the target rule in place via mergePosition; do not set beforePosition.`,
        };
      }
      // mergePosition required, integer, in range
      if (
        decision.mergePosition === undefined ||
        typeof decision.mergePosition !== "number" ||
        !Number.isInteger(decision.mergePosition)
      ) {
        return {
          ok: false,
          error: `Candidate ${decision.candidate} merge action requires an integer mergePosition (the existing rule number to fold into).`,
        };
      }
      if (decision.mergePosition < 1 || decision.mergePosition > portraitRuleCount) {
        return {
          ok: false,
          error: `Candidate ${decision.candidate} mergePosition ${decision.mergePosition} is out of range. Must be between 1 and ${portraitRuleCount}.`,
        };
      }
      // text required, non-empty, single line
      if (typeof decision.text !== "string" || decision.text.trim() === "") {
        return {
          ok: false,
          error: `Candidate ${decision.candidate} merge action requires non-empty text (the single-line combined rule).`,
        };
      }
      if (decision.text.includes("\n")) {
        return {
          ok: false,
          error: `Candidate ${decision.candidate} merge text must be a single line — no line breaks.`,
        };
      }
      // cannot evict the rule being merged into (it is being replaced by text)
      if (decision.evictPositions?.includes(decision.mergePosition)) {
        return {
          ok: false,
          error: `Candidate ${decision.candidate} cannot evict mergePosition ${decision.mergePosition} — that rule is being replaced by text.`,
        };
      }
      // evictPositions validation falls through to the shared block below
    }

    // Validate string beforePosition format: must match C\d+ (insert only)
    if (decision.action === "insert" && typeof decision.beforePosition === "string") {
      if (!CANDIDATE_REF_RE.test(decision.beforePosition)) {
        return {
          ok: false,
          error: `Candidate ${decision.candidate} has string beforePosition "${decision.beforePosition}" which does not match candidate reference pattern (C1, C2, etc.).`,
        };
      }
      if (skipped.has(decision.beforePosition)) {
        return {
          ok: false,
          error: `Candidate ${decision.candidate} references ${decision.beforePosition} via beforePosition, but ${decision.beforePosition} was skipped. Please use a numeric beforePosition instead.`,
        };
      }
      // Range check: string beforePosition must reference a valid candidate
      if (candidateCount !== undefined) {
        const refIdx = parseInt(decision.beforePosition.slice(1), 10);
        if (refIdx < 1 || refIdx > candidateCount) {
          return {
            ok: false,
            error: `Candidate ${decision.candidate} references ${decision.beforePosition} via beforePosition, but only ${candidateCount} candidate(s) exist.`,
          };
        }
      }
    }

    // evictPositions validation
    if (decision.evictPositions && decision.evictPositions.length > 0) {
      const seen = new Set<number | string>();
      for (const entry of decision.evictPositions) {
        // Rule 5: no duplicates
        if (seen.has(entry)) {
          return {
            ok: false,
            error: `Candidate ${decision.candidate} has duplicate evictPosition ${JSON.stringify(entry)}. Each evict position must be unique.`,
          };
        }
        seen.add(entry);

        if (typeof entry === "number") {
          // Rule 4: numeric range [1, portraitRuleCount]
          if (entry < 1 || entry > portraitRuleCount) {
            return {
              ok: false,
              error: `Candidate ${decision.candidate} evictPosition ${entry} is out of range. Must be between 1 and ${portraitRuleCount}.`,
            };
          }
        } else {
          // Rule 6: string must match C\d+
          if (!CANDIDATE_REF_RE.test(entry)) {
            return {
              ok: false,
              error: `Candidate ${decision.candidate} evictPosition "${entry}" is not a valid candidate reference. Must match pattern C1, C2, etc.`,
            };
          }
          // Rule 2: must not reference skipped candidate
          if (skipped.has(entry)) {
            return {
              ok: false,
              error: `Candidate ${decision.candidate} evictPosition references ${entry}, but ${entry} was skipped.`,
            };
          }
          // Rule 3: must not reference self
          if (entry === decision.candidate) {
            return {
              ok: false,
              error: `Candidate ${decision.candidate} cannot evict itself.`,
            };
          }
          // Rule 7: string ref must be within candidate range
          if (candidateCount !== undefined) {
            const refMatch = entry.match(CANDIDATE_REF_RE);
            if (refMatch) {
              const refIdx = parseInt(refMatch[1], 10);
              if (refIdx < 1 || refIdx > candidateCount) {
                return {
                  ok: false,
                  error: `Candidate ${decision.candidate} evictPosition references ${entry}, but only ${candidateCount} candidate(s) exist.`,
                };
              }
            }
          }
        }
      }
    }
  }

  return { ok: true };
}
