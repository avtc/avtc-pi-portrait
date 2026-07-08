// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { getPortraitDir } from "../config.js";
import { reportError } from "../error.js";
import { setCachedPipelineState } from "../footer.js";
import "../globals.js";
import { runPipelineLoop } from "../pipeline.js";
import { getPortraitSettings } from "../settings-ui.js";
import { loadPortraitState, parsePortraitRules, readPortrait, savePortraitState } from "../storage.js";
import { getErrorMessage } from "../utils.js";

export async function collect(limit: number | undefined): Promise<string> {
  const state = globalThis.__piPortrait;
  const acquireCollectLock = globalThis.__piPortraitAcquireCollectLock;
  const releaseCollectLock = globalThis.__piPortraitReleaseCollectLock;

  if (!state || !acquireCollectLock || !releaseCollectLock) {
    return "👤 Portrait collecting is not available in this session.";
  }

  const portraitDir = getPortraitDir();

  // Acquire collect lock — prevents concurrent collection
  if (!(await acquireCollectLock())) {
    return "👤 Collection already in progress.";
  }

  // Reset cancellation flags at start
  state.collectCancelled = false;
  state.bgScanCancelled = false;

  const settings = getPortraitSettings();
  const maxSequences = limit ?? Infinity;
  const initialRuleCount = parsePortraitRules(readPortrait(portraitDir) ?? "").length;

  try {
    // No heartbeat callback under (SQLite mutex crash-releases on process death).
    const { totalSequences, totalInserted, totalEvicted } = await runPipelineLoop(
      settings,
      maxSequences,
      () => state.collectCancelled,
    );

    if (state.collectCancelled) {
      return `👤 Collection stopped. ${totalSequences} sequences collected, ${totalInserted} rules inserted, ${totalEvicted} evicted.`;
    }

    const activeRules = parsePortraitRules(readPortrait(portraitDir) ?? "");
    return `👤 Collected ${totalSequences} sequences. ${totalInserted} rules inserted, ${totalEvicted} evicted (was ${initialRuleCount}, now ${activeRules.length} active rules).`;
  } catch (error) {
    const portraitState = loadPortraitState(portraitDir);
    portraitState.pipelinePhase = "idle";
    savePortraitState(portraitDir, portraitState);
    setCachedPipelineState(portraitState);
    const msg = getErrorMessage(error);
    if (msg === "PAUSED") {
      // Persist pause state directly — pauseProfiling requires lockHeld
      // which this instance may not have (manual collect from non-lock-holder)
      portraitState.paused = true;
      portraitState.pausedAt = new Date().toISOString();
      portraitState.pausedBy = { pid: process.pid };
      savePortraitState(portraitDir, portraitState);
      if (state?.uiNotify) state.uiNotify("👤 Portrait profiling paused.", "info");
      return "👤 Portrait profiling paused.";
    }
    reportError(`Collection failed: ${msg}`, "collect error");
    return `👤 Collection failed: ${msg}`;
  } finally {
    releaseCollectLock();
    state.collectCancelled = false;
  }
}
