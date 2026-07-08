// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "./globals.js";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { type BuildResult, buildPortrait } from "./builder.js";
import { getPortraitDir } from "./config.js";
import { appendDebug, openDebugDump } from "./debug.js";
import { setCachedPipelineState } from "./footer.js";
import { commitPortrait } from "./git.js";
import {
  callPortraitLlm,
  type LlmProgressInfo,
  makeDebugStreamDumpSink,
  NO_DEBUG_STREAM_SINK,
  NO_LLM_PROGRESS_SINK,
  PAUSED,
  setDebugStreamSink,
  setLlmProgressSink,
} from "./llm-call.js";
import { MAINTENANCE_PROMPT } from "./prompts.js";
import { getPortraitSettings } from "./settings-ui.js";
import {
  appendDropped,
  loadPortraitState,
  parsePortraitRules,
  readEvicted,
  readPortrait,
  savePortraitState,
  writeEvicted,
  writePortrait,
} from "./storage.js";
import { getErrorMessage } from "./utils.js";

interface MaintenanceResponse {
  portrait: string[];
  /** 1-indexed positions of removed/merged-away rules in the input list. */
  dropped: number[];
}

/** Sentinel for runMaintenance() — no cancellation callback (run to completion). */
export const NO_CANCEL_CHECK: (() => boolean) | undefined = undefined;

export async function runMaintenance(shouldCancel: (() => boolean) | undefined): Promise<string> {
  const state = globalThis.__piPortrait;
  const portraitDir = getPortraitDir();
  const settings = getPortraitSettings();

  // Default cancellation check — reads the shared flag set by /portrait:stop
  const cancelCheck = shouldCancel ?? (() => state?.collectCancelled === true);

  /** Set footer status during maintenance. */
  const setMaintenanceStatus = (status: string) => {
    const ps = loadPortraitState(portraitDir);
    ps.pipelinePhase = "maintaining";
    ps.maintenanceStatus = status;
    ps.llmTokens = 0;
    ps.llmWords = 0;
    savePortraitState(portraitDir, ps);
    setCachedPipelineState(ps);
  };

  /** Progress sink: update footer with live token/word count for the current stage. */
  const progressSink = (info: LlmProgressInfo) => {
    const ps = loadPortraitState(portraitDir);
    // Preserve the current maintenanceStatus (set by the active stage)
    ps.pipelinePhase = "maintaining";
    ps.llmTokens = info.tokens;
    ps.llmWords = info.words;
    savePortraitState(portraitDir, ps);
    setCachedPipelineState(ps);
  };

  // Install the module-level sink so all maintenance LLM calls report progress
  setLlmProgressSink(progressSink);

  try {
    // Reset counter BEFORE maintenance starts (prevents re-trigger)
    const portraitState = loadPortraitState(portraitDir);
    const originalCounter = portraitState.rulesInsertedSinceMaintenance;
    portraitState.rulesInsertedSinceMaintenance = 0;
    savePortraitState(portraitDir, portraitState);

    const modelOverride = settings.maintenanceModel || undefined;
    // Maintenance emits the full portrait as a single tool call, so it routinely
    // exceeds the per-call maxTokens/timeout. Resolve dedicated maintenance values:
    //   maintenanceMaxTokens = 0  → no cap (let the model's own limit apply)
    //   maintenanceTimeoutMs = null → no timeout (the call runs to completion)
    const maintenanceMaxTokens = settings.maintenanceMaxTokens > 0 ? settings.maintenanceMaxTokens : null;
    const maintenanceTimeoutMs = settings.maintenanceTimeoutMs;
    const existingRules = parsePortraitRules(readPortrait(portraitDir) ?? "");

    let totalDropped = 0;
    let totalPromoted = 0;
    let totalMechEvicted = 0;
    let phase1Aborted = false;

    // === Phase 1: Analysis ===
    const phase1Status = `analyzing ${existingRules.length} rules...`;
    if (existingRules.length > 0 && !cancelCheck()) {
      // Footer: analyzing N rules (N = current portrait rule count)
      setMaintenanceStatus(phase1Status);

      // Build numbered portrait for LLM
      const numberedPortrait = existingRules.map((r, i) => `${i + 1}. ${r}`).join("\n");

      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: `${MAINTENANCE_PROMPT}\n\n${numberedPortrait}` }],
          timestamp: Date.now(),
        },
      ];

      // Tool definition (same pattern as builder.ts — defined inline so it can set module-level variable)
      let maintenanceResponse: MaintenanceResponse | null = null;

      const returnMaintenanceTool: AgentTool = {
        name: "return_maintenance",
        label: "Return maintenance result",
        description: "Return cleaned portrait and dropped rules.",
        parameters: Type.Object({
          portrait: Type.Array(Type.String()),
          dropped: Type.Array(Type.Number()),
        }),
        execute: async (_toolCallId: string, params: unknown) => {
          const typedParams = params as MaintenanceResponse;
          maintenanceResponse = typedParams;
          return {
            content: [
              {
                type: "text" as const,
                text: `Returned ${typedParams.portrait.length} rules, ${typedParams.dropped.length} dropped`,
              },
            ],
            details: undefined,
          };
        },
      };

      // Debug dump: capture what the maintenance LLM sees + produces (streamed, flushed).
      // openDebugDump returns null when debugDumpLimit <= 0 (dumps disabled) — appendDebug no-ops then.
      const dumpPath = openDebugDump(portraitDir, "maintenance", settings.debugDumpLimit);
      appendDebug(
        dumpPath,
        `=== Maintenance Input (${existingRules.length} rules) ===\n--- SYSTEM PROMPT ---\n${MAINTENANCE_PROMPT}\n\n--- TOOL ---\n${JSON.stringify({ name: "return_maintenance", description: "Return maintenance decisions.", input_schema: { type: "object", properties: { portrait: { type: "array", items: { type: "string" } }, dropped: { type: "array", items: { type: "string" } } }, required: ["portrait", "dropped"] } }, null, 2)}\n\n--- USER MESSAGE (numbered rules) ---\n${numberedPortrait}\n`,
      );

      // Stream sink: flush each streamed delta to the dump so partial output survives
      // an abort/retry (the original "stopped at 9k words then started over" symptom).
      // Only install when dumps are enabled — avoids per-delta overhead when off.
      if (dumpPath) setDebugStreamSink(makeDebugStreamDumpSink(dumpPath));

      // Validation loop (LLM retries handled inside callPortraitLlm)
      let response: MaintenanceResponse | undefined;
      let validationError: string | null = null;
      let validationPassed = false;
      const maxValidationRetries = 3;
      let validationAttempts = 0;
      let droppedIndices: number[] = [];
      const promptTitle = MAINTENANCE_PROMPT.split("\n")[0];

      try {
        while (validationAttempts < maxValidationRetries) {
          if (validationError) {
            appendDebug(dumpPath, `\n=== Validation retry ${validationAttempts + 1}: ${validationError} ===\n`);
            messages.push({ role: "user", content: [{ type: "text", text: validationError }], timestamp: Date.now() });
          }

          const llmResult = await callPortraitLlm<MaintenanceResponse>(
            messages,
            promptTitle,
            returnMaintenanceTool,
            () => maintenanceResponse ?? undefined,
            "Previous maintenance failed. Return valid JSON using return_maintenance.",
            modelOverride,
            maintenanceMaxTokens, // token cap for maintenance (null = model limit)
            maintenanceTimeoutMs, // timeout for maintenance (null = no timeout)
          );

          // callPortraitLlm returns undefined on failure, PAUSED on user pause
          if (!llmResult || llmResult === PAUSED) {
            phase1Aborted = true;
            break;
          }
          response = llmResult;

          // Validate: portrait non-empty
          if (response.portrait.length === 0 && existingRules.length > 0) {
            validationError = "Portrait must not be empty. Return at least some kept rules.";
            validationAttempts++;
            continue;
          }

          // Validate: dropped rule numbers must be valid 1-indexed positions
          const invalidDropped = response.dropped.filter(
            (i) => !Number.isInteger(i) || i < 1 || i > existingRules.length,
          );
          if (invalidDropped.length > 0) {
            validationError = `Dropped rule numbers must be integers between 1 and ${existingRules.length}. Invalid: ${invalidDropped.slice(0, 5).join(", ")}`;
            validationAttempts++;
            continue;
          }

          // Dedupe dropped indices (a repeated number must not double-count or duplicate the entry)
          droppedIndices = [...new Set(response.dropped)];

          // Validate: count invariant (portrait + dropped >= input, because merges reduce count)
          if (response.portrait.length + droppedIndices.length < existingRules.length) {
            validationError = `Missing rules: returned ${response.portrait.length} portrait + ${droppedIndices.length} dropped = ${response.portrait.length + droppedIndices.length}, but input had ${existingRules.length}. Every rule must appear in either portrait or dropped.`;
            validationAttempts++;
            continue;
          }

          // Valid
          validationPassed = true;
          break;
        }
      } finally {
        setDebugStreamSink(NO_DEBUG_STREAM_SINK);
      }

      // Resolve dropped indices to original rule texts (deduped)
      const droppedRules = response && validationPassed ? droppedIndices.map((i) => existingRules[i - 1]) : [];

      // Write parsed output to the dump
      if (response && validationPassed) {
        appendDebug(
          dumpPath,
          `\n=== Maintenance Output ===\nPortrait (${response.portrait.length}):\n${response.portrait.join("\n")}\n\nDropped (${droppedRules.length}):\n${droppedRules.join("\n") || "(none)"}\n`,
        );
      } else {
        appendDebug(dumpPath, "\n=== Maintenance Output ===\n(aborted — no valid result)\n");
      }

      // Validation loop exhausted — abort Phase 1
      if (!validationPassed) {
        phase1Aborted = true;
      }

      if (response && validationPassed) {
        writePortrait(portraitDir, response.portrait);
        if (droppedRules.length > 0) {
          appendDropped(portraitDir, droppedRules);
        }
        totalDropped = droppedRules.length;
        // Commit Phase 1 immediately so the cleaned portrait + dropped rules
        // survive even if Phase 2 backfill is cancelled or fails midway.
        commitPortrait(
          portraitDir,
          `portrait: maintenance cleaned${totalDropped > 0 ? `, ${totalDropped} dropped` : ""}`,
        );
      }
    }

    // === Phase 2: Backfill ===
    if (phase1Aborted) {
      // Restore counter and update state on abort
      portraitState.rulesInsertedSinceMaintenance = originalCounter;
      portraitState.lastMaintenanceRun = new Date().toISOString();
      portraitState.pipelinePhase = "idle";
      portraitState.maintenanceStatus = "";
      portraitState.llmTokens = 0;
      portraitState.llmWords = 0;
      savePortraitState(portraitDir, portraitState);
      setCachedPipelineState(portraitState);
      return "👤 Maintenance aborted. Phase 1 LLM call failed or was paused.";
    }

    const currentRules = parsePortraitRules(readPortrait(portraitDir) ?? "");
    let freeSlots = settings.ruleLimit - currentRules.length;

    if (freeSlots > 0) {
      const evictedRules = readEvicted(portraitDir);
      const rateLimitMs = settings.rateLimitMs;

      // Footer: backfilling M rules (M = min(slots to fill, evicted available))
      const backfillStatus = `backfilling ${Math.min(freeSlots, evictedRules.length)} rules...`;
      if (evictedRules.length > 0) {
        setMaintenanceStatus(backfillStatus);
      }

      // Debug dump: one file per backfill run, all batches appended (input + streamed output).
      // null when debugDumpLimit <= 0 — builder's appendDebug calls no-op then.
      const backfillDumpPath = openDebugDump(portraitDir, "backfill", settings.debugDumpLimit);

      while (freeSlots > 0 && evictedRules.length > 0 && !cancelCheck()) {
        const batch = evictedRules.splice(0, settings.maintenanceBackfillBatchSize);
        // buildPortrait throws "PAUSED" when the user pauses from the retry dialog — treat that
        // the same as a failure (restore batch, stop backfill) so maintenance completes
        // gracefully instead of surfacing "Maintenance failed: PAUSED".
        let result: BuildResult | undefined;
        try {
          result = await buildPortrait(portraitDir, batch, {
            skipPersist: true,
            modelOverride,
            maxTokensOverride: maintenanceMaxTokens, // token cap for maintenance (null = model limit)
            timeoutOverride: maintenanceTimeoutMs, // timeout for maintenance (null = no timeout)
            debugDumpPath: backfillDumpPath ?? undefined,
          });
        } catch (err) {
          if (getErrorMessage(err) === "PAUSED") {
            evictedRules.unshift(...batch);
            break;
          }
          throw err;
        }

        if (result) {
          // Apply changes manually (skipPersist means buildPortrait didn't persist)
          writePortrait(portraitDir, result.rules);

          // Mechanically evicted rules go back to evicted pool
          evictedRules.push(...result.evictedRules);
          // Persist evicted pool + dropped rules now so each batch's progress
          // is committed (and survives a cancelled backfill).
          writeEvicted(portraitDir, evictedRules);
          if (result.droppedRules.length > 0) {
            appendDropped(portraitDir, result.droppedRules);
          }

          totalPromoted += result.inserted;
          totalMechEvicted += result.evictedRules.length;
          totalDropped += result.droppedRules.length;

          freeSlots = settings.ruleLimit - result.rules.length;

          // Commit after each batch so backfill progress survives a cancel
          commitPortrait(portraitDir, `portrait: maintenance backfill, ${result.inserted} promoted`);
        } else {
          // buildPortrait returned undefined — callPortraitLlm already retried 3×
          // and offered user dialog. Restore batch and stop backfill.
          evictedRules.unshift(...batch);
          break;
        }

        // Rate limit between batches
        if (rateLimitMs > 0) {
          await new Promise((r) => setTimeout(r, rateLimitMs));
        }
      }

      // Ensure the evicted pool is current after the loop (covers the break-on-failure
      // case where the batch was restored, and the no-iteration case).
      writeEvicted(portraitDir, evictedRules);
      // Capture any trailing evicted.md change (e.g. restored pool) in a final commit.
      commitPortrait(portraitDir, "portrait: maintenance backfill complete");
    }

    // Update state — reset phase to idle (clears maintenance status from footer)
    portraitState.lastMaintenanceRun = new Date().toISOString();
    portraitState.pipelinePhase = "idle";
    portraitState.maintenanceStatus = "";
    portraitState.llmTokens = 0;
    portraitState.llmWords = 0;
    savePortraitState(portraitDir, portraitState);
    setCachedPipelineState(portraitState);

    // Special message when portrait was empty and nothing to backfill
    if (existingRules.length === 0 && totalPromoted === 0) {
      return "👤 Maintenance complete. Portrait is empty, no evicted rules to backfill.";
    }

    const parts = [`${totalDropped} rules dropped`, `${totalPromoted} promoted from evicted`];
    if (totalMechEvicted > 0) parts.push(`${totalMechEvicted} mechanically evicted`);
    return `👤 Maintenance complete. ${parts.join(", ")}.`;
  } finally {
    // Always release the module-level sink so non-maintenance calls don't update our footer
    setLlmProgressSink(NO_LLM_PROGRESS_SINK);
  }
}
