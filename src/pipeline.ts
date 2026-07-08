// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "./globals.js";
import { buildPortrait } from "./builder.js";
import { countPendingTrios, discoverFiles, scanSessions } from "./collector.js";
import { getPortraitDir, getSessionDirs } from "./config.js";
import { reportError } from "./error.js";
import { setCachedPipelineState } from "./footer.js";
import { type LlmProgressInfo, NO_LLM_PROGRESS_SINK, setLlmProgressSink } from "./llm-call.js";
import { NO_CANCEL_CHECK, runMaintenance } from "./maintenance-core.js";
import type { PortraitSettings } from "./schema.js";
import { loadPortraitState, savePortraitState } from "./storage.js";
import { getErrorMessage } from "./utils.js";

/** Sentinel: no build options (use defaults) */
const NO_BUILD_OPTIONS: undefined = undefined;

/** Process a single scan result per cycle (maxResults=1) — one session at a time in the eviction loop. */
const SINGLE_RESULT = 1;

type Settings = PortraitSettings;

/** Module-level reference to the in-flight bg trio counter — prevents concurrent spawns.
 * Note: if runPipelineLoop is called twice rapidly, the second call skips bg scan
 * spawn (pendingBgScan is non-null) and gets a stale totalKnownTrios from the first.
 * This is non-critical: the trio counter is an estimation for UI progress only.
 */
let pendingBgScan: Promise<void> | null = null;

/** Reset pendingBgScan — for test isolation. */
export function resetPipelineState(): void {
  pendingBgScan = null;
}

/** Stats returned from the shared pipeline loop. */
export interface PipelineStats {
  totalSequences: number;
  totalInserted: number;
  totalEvicted: number;
}

/**
 * Shared processing loop: scan → rateLimit → build → rateLimit.
 * Used by both runProfilingCycle (timer) and collect (manual command).
 *
 * Handles: MB progress reset, trio counter reset + bg spawn, rate limiting, finalization.
 *
 * @param settings - portrait settings
 * @param maxSequences - max sequences to process (Infinity for no limit)
 * @param shouldCancel - called before each iteration; return true to stop (cancellation, etc.)
 */
export async function runPipelineLoop(
  settings: Settings,
  maxSequences: number,
  shouldCancel: () => boolean,
): Promise<PipelineStats> {
  const portraitDir = getPortraitDir();
  const pipelineState = loadPortraitState(portraitDir);
  const rateLimitMs = settings.rateLimitMs;
  const batchSize = settings.buildingBatchSize;

  // Install progress sink: extraction + building LLM calls update the footer live.
  // Counters reset per attempt inside attemptWithRetries; we just mirror them to the cache.
  const progressSink = (info: LlmProgressInfo) => {
    pipelineState.llmTokens = info.tokens;
    pipelineState.llmWords = info.words;
    setCachedPipelineState(pipelineState);
  };
  setLlmProgressSink(progressSink);

  try {
    // Reset progress counters
    pipelineState.totalKnownTrios = 0;
    pipelineState.triosProcessed = 0;
    pipelineState.scanSessionKB = 0; // Session progress resets to 0

    // Pre-compute remaining KB (after checkpoints) before setting phase,
    // so footer shows "0.0/Remaining MB" immediately on collect start
    const maxAgeMs = settings.maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;
    const sessionDirs = getSessionDirs();
    const allFiles = discoverFiles(sessionDirs, cutoff);
    const filesTotalKB = Math.round(allFiles.reduce((sum, f) => sum + f.size, 0) / 1024);
    const checkpointKB = Math.round(allFiles.reduce((sum, f) => sum + (f.checkpoint?.lastByte ?? 0), 0) / 1024);
    pipelineState.scanRemainingKB = filesTotalKB - checkpointKB;

    // Set pipeline phase to scanning
    pipelineState.pipelinePhase = "scanning";
    savePortraitState(portraitDir, pipelineState);
    setCachedPipelineState(pipelineState);

    // Spawn background trio counter (non-blocking)
    // Skip if one is already running — previous result is still valid
    if (!pendingBgScan) {
      pendingBgScan = countPendingTrios(portraitDir, settings.maxAgeDays)
        .then((total) => {
          const updated = loadPortraitState(portraitDir);
          updated.totalKnownTrios = total;
          savePortraitState(portraitDir, updated);
          const cached = globalThis.__piPortraitPipelineState;
          if (cached) {
            cached.totalKnownTrios = total;
          }
        })
        .catch(() => {
          /* bg scan failure is non-critical */
        })
        .finally(() => {
          pendingBgScan = null;
        });
    }

    let totalSequences = 0;
    let totalInserted = 0;
    let totalEvicted = 0;
    let remaining = 1;

    while (remaining > 0 && totalSequences < maxSequences && !shouldCancel()) {
      const scanResults = await scanSessions(portraitDir, pipelineState, 100, SINGLE_RESULT);
      remaining = scanResults.remainingFiles;

      if (scanResults.results.length === 0) break;
      totalSequences += scanResults.results.length;

      // Cooldown after extraction LLM calls
      if (rateLimitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
      }

      pipelineState.pipelinePhase = "processing";
      savePortraitState(portraitDir, pipelineState);
      setCachedPipelineState(pipelineState);

      const candidates = scanResults.results.flatMap((r) => r.behaviorNotes);
      if (candidates.length > 0) {
        for (let i = 0; i < candidates.length; i += batchSize) {
          const batch = candidates.slice(i, i + batchSize);
          const result = await buildPortrait(portraitDir, batch, NO_BUILD_OPTIONS);
          // Clear streamed counters once the call completes
          pipelineState.llmTokens = 0;
          pipelineState.llmWords = 0;
          if (result) {
            totalInserted += result.inserted;
            totalEvicted += result.evicted;
            // Increment maintenance counter
            pipelineState.rulesInsertedSinceMaintenance =
              (pipelineState.rulesInsertedSinceMaintenance ?? 0) + result.inserted;
            savePortraitState(portraitDir, pipelineState);
            setCachedPipelineState(pipelineState);
          }
        }
        // Cooldown after builder LLM calls
        if (rateLimitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
        }
      }

      // Back to scanning for next file
      if (remaining > 0 && totalSequences < maxSequences && !shouldCancel()) {
        pipelineState.pipelinePhase = "scanning";
        savePortraitState(portraitDir, pipelineState);
        setCachedPipelineState(pipelineState);
      }
    }

    // Finalize state — load fresh to merge any bg scan updates
    const finalState = loadPortraitState(portraitDir);
    // Merge bg scan totalKnownTrios if it completed
    if (finalState.totalKnownTrios > pipelineState.totalKnownTrios) {
      pipelineState.totalKnownTrios = finalState.totalKnownTrios;
    }
    // Set finalization fields directly on pipelineState (which is what gets saved)
    pipelineState.lastPipelineRun = new Date().toISOString();
    pipelineState.lastScanTimestamp = new Date().toISOString();
    pipelineState.pipelinePhase = "idle";
    pipelineState.remainingFiles = 0;
    pipelineState.llmTokens = 0;
    pipelineState.llmWords = 0;
    savePortraitState(portraitDir, pipelineState);
    setCachedPipelineState(pipelineState);

    // Auto-maintenance check
    if (
      settings.maintenanceEveryNRulesInserted > 0 &&
      (pipelineState.rulesInsertedSinceMaintenance ?? 0) >= settings.maintenanceEveryNRulesInserted &&
      !shouldCancel()
    ) {
      try {
        await runMaintenance(NO_CANCEL_CHECK);
      } catch (error) {
        reportError(`Auto-maintenance failed: ${getErrorMessage(error)}`, "maintenance error");
      }
    }

    return { totalSequences, totalInserted, totalEvicted };
  } finally {
    // Release the sink so it doesn't outlive the collect cycle.
    // (Auto-maintenance, if it ran, already cleared+restored its own sink.)
    setLlmProgressSink(NO_LLM_PROGRESS_SINK);
  }
}
