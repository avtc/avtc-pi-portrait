// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "./globals.js";
import * as fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLockPath } from "./config.js";
import type { PortraitPipelineState } from "./types.js";
import { DEFAULT_PIPELINE_STATE } from "./types.js";

/** Stashed ctx for timer access — refreshed on session_start, cleared on session_shutdown. */
let _ctx: ExtensionContext | null = null;

/** Timer ID for periodic status updates. */
let _statusTimer: ReturnType<typeof setInterval> | null = null;

/** Store ctx for status timer access and restart timer if stopped. Called from session_start. */
export function setFooterCtx(ctx: ExtensionContext): void {
  _ctx = ctx;
  if (!_statusTimer) {
    startStatusTimer();
  }
}

/** Clear stashed ctx and stop status timer. Called from session_shutdown event handler. */
export function clearFooterCtx(): void {
  _ctx = null;
  if (_statusTimer) {
    clearInterval(_statusTimer);
    _statusTimer = null;
  }
}

/**
 * Update the in-memory pipeline state cache and refresh the status widget.
 *
 * Called by the pipeline/collector after each save to portrait-state.json.
 * The globalThis key is per-process — only the instance running the pipeline
 * has its cache updated, so other instances won't see active progress.
 */
export function setCachedPipelineState(pipelineState: PortraitPipelineState): void {
  globalThis.__piPortraitPipelineState = pipelineState;
  updateStatus();
}

function getCachedPipelineState(): PortraitPipelineState {
  return globalThis.__piPortraitPipelineState ?? { ...DEFAULT_PIPELINE_STATE };
}

/** Initialize status display. Called once at extension load. */
export function initFooter(): void {
  startStatusTimer();
}

function startStatusTimer(): void {
  if (_statusTimer) return;

  const update = () => updateStatus();

  // Update status periodically (every 5 seconds)
  _statusTimer = setInterval(update, 5000);
  update(); // Initial render
}

function updateStatus(): void {
  if (!_ctx?.ui?.setStatus) return;

  const widgetState = getWidgetState();
  _ctx.ui.setStatus("portrait", `👤 ${widgetState}`);
}

function getWidgetState(): string {
  const globalState = globalThis.__piPortrait;
  const cachedPipelineState = getCachedPipelineState();

  // Active pipeline — show progress regardless of lock state.
  // The in-memory cache is only updated by the local pipeline via
  // setCachedPipelineState(), so only the instance running collection
  // will see this branch.
  const phase = cachedPipelineState.pipelinePhase;
  if (phase === "scanning" || phase === "processing" || phase === "maintaining") {
    return formatProgress(cachedPipelineState);
  }

  // Not holding lock
  if (!globalState?.lockHeld) {
    const lockPath = getLockPath();
    try {
      const lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      if (lockData.pid) {
        return `locked by PID ${lockData.pid}`;
      }
    } catch {
      // Lock doesn't exist
    }
    return "idle";
  }

  // Paused — only show when pipeline is truly idle
  if (cachedPipelineState.paused) {
    if (cachedPipelineState.pausedBy) {
      const { pid } = cachedPipelineState.pausedBy;
      return `paused by PID ${pid}`;
    }
    return "paused";
  }

  return formatProgress(cachedPipelineState);
}

// Shared progress display used by both lock-holder and non-lock-holder branches.
function formatProgress(sf: PortraitPipelineState): string {
  const phase = sf.pipelinePhase;

  // Streamed progress for the active LLM call. Prefer provider-reported output
  // tokens; fall back to the word count when the provider doesn't stream usage.
  // Appended to whichever status line is currently shown.
  let progressPart = "";
  if (sf.llmTokens > 0) progressPart = ` · ${sf.llmTokens} tokens`;
  else if (sf.llmWords > 0) progressPart = ` · ${sf.llmWords} words`;

  // Maintenance — show descriptive status text set by runMaintenance
  if (phase === "maintaining") {
    return `${sf.maintenanceStatus || "maintaining..."}${progressPart}`;
  }

  const trios = sf.triosProcessed;
  const total = sf.totalKnownTrios;

  // Build trio part
  let trioPart = "";
  if (total > 0) trioPart = `profiling ${trios}/${total}`;
  else if (trios > 0) trioPart = `profiling ${trios}/??`;
  else if (phase === "scanning" || phase === "processing") trioPart = "profiling 0/0";

  // Scan part (MB) — per-session progress: scanSessionKB / scanRemainingKB
  // scanSessionKB: KB scanned in the current collect cycle (resets to 0 on each /collect)
  // scanRemainingKB: KB remaining after extraction checkpoints (total - checkpointed)
  // Display resets on each /collect — progress is relative to the current session,
  // not cumulative across sessions. This shows how much of the remaining work is done.
  let scanPart = "";
  const remainingKB = sf.scanRemainingKB;
  const sessionKB = sf.scanSessionKB;
  if (remainingKB > 0) {
    const sessionMB = (sessionKB / 1024).toFixed(1);
    const remainingMB = (remainingKB / 1024).toFixed(1);
    scanPart = `${sessionMB}/${remainingMB} MB`;
  }

  // Combine
  if (trioPart && scanPart) return `${trioPart} · ${scanPart}${progressPart}`;
  if (trioPart) return `${trioPart}${progressPart}`;
  if (scanPart) return `${scanPart}${progressPart}`;

  // Fallbacks
  if (sf.llmTokens > 0) return `${sf.llmTokens} tokens`;
  if (sf.llmWords > 0) return `${sf.llmWords} words`;
  if (phase === "scanning") return "scanning...";
  if (phase === "processing") return "profiling...";
  return "idle";
}
