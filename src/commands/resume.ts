// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "../globals.js";
import { getPortraitDir } from "../config.js";
import { reportError } from "../error.js";
import { loadPortraitState, savePortraitState } from "../storage.js";

export function resumeProfiling(): string {
  const state = globalThis.__piPortrait;

  if (!state?.lockHeld) {
    return "👤 Portrait profiling is not active in this session (locked by another).";
  }

  // Clear pause state
  const portraitDir = getPortraitDir();
  const pipelineState = loadPortraitState(portraitDir);
  pipelineState.paused = false;
  pipelineState.pausedAt = null;
  pipelineState.pausedBy = null;
  savePortraitState(portraitDir, pipelineState);

  // Start profiling timer (delegates to shared startProfilingTimer from index.ts)
  // This avoids circular dependency — resume.ts doesn't import from index.ts
  const startProfilingTimer = globalThis.__piPortraitStartProfilingTimer;
  if (typeof startProfilingTimer === "function") {
    startProfilingTimer();
  }

  // Trigger immediate pipeline cycle after resume
  const runCycle = globalThis.__piPortraitRunProfilingCycle;
  if (typeof runCycle === "function") {
    runCycle().catch((err: unknown) => {
      reportError(`Resume cycle failed: ${err}`, "resume error");
    });
  }

  return "👤 Portrait profiling resumed.";
}
