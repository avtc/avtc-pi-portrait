// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "../globals.js";
import { getPortraitDir } from "../config.js";
import { loadPortraitState, savePortraitState } from "../storage.js";

export function pauseProfiling(): string {
  const state = globalThis.__piPortrait;

  if (!state?.lockHeld) {
    return "👤 Portrait profiling is not active in this session (locked by another).";
  }

  // Pause timer
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  // Save pause state
  const portraitDir = getPortraitDir();
  const pipelineState = loadPortraitState(portraitDir);
  pipelineState.paused = true;
  pipelineState.pausedAt = new Date().toISOString();
  pipelineState.pausedBy = { pid: process.pid };
  savePortraitState(portraitDir, pipelineState);

  return "👤 Portrait profiling paused.";
}
