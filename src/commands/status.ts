// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "../globals.js";
import * as os from "node:os";
import * as path from "node:path";
import { getPortraitDir } from "../config.js";
import { getPortraitSettings } from "../settings-ui.js";
import { loadPortraitState, parsePortraitRules, readDropped, readEvicted, readPortrait } from "../storage.js";

export function getStatus(): string {
  const portraitDir = getPortraitDir();
  const settings = getPortraitSettings();
  const state = globalThis.__piPortrait;

  const lockStatus = state?.lockHeld ? `holding (PID ${process.pid})` : "not holding";

  const portrait = readPortrait(portraitDir);
  const activeRules = portrait ? parsePortraitRules(portrait) : [];
  const evicted = readEvicted(portraitDir);
  const dropped = readDropped(portraitDir);
  const pipelineState = loadPortraitState(portraitDir);

  const stateLabel = state?.timer
    ? pipelineState.pipelinePhase === "idle"
      ? "idle — polling for new sessions"
      : pipelineState.pipelinePhase === "scanning"
        ? `scanning ${pipelineState.scanSessionKB}/${pipelineState.scanRemainingKB} KB`
        : "processing"
    : "paused";

  const triosLabel =
    pipelineState.totalKnownTrios > 0
      ? `${pipelineState.triosProcessed}/${pipelineState.totalKnownTrios} (${Math.round((pipelineState.triosProcessed / pipelineState.totalKnownTrios) * 100)}%)`
      : "0/0";

  const lines = [
    "👤 Portrait Profiling",
    "──────────────────────",
    `Lock: ${lockStatus}`,
    `State: ${stateLabel}`,
    "",
    "Storage:",
    `  Portrait entries: ${activeRules.length} active, ${evicted.length} evicted, ${dropped.length} dropped`,
    `  Rule limit: ${activeRules.length}/${settings.ruleLimit}`,
    "",
    "Files:",
    `  ${path.join(portraitDir, "portrait.md")}`,
    `  ${path.join(portraitDir, "evicted.md")}`,
    `  ${path.join(portraitDir, "dropped.md")}`,
    "",
    `Trios processed: ${triosLabel}`,
    `Last update: ${pipelineState.lastPipelineRun ?? "never"}`,
  ];

  if (pipelineState.lastMaintenanceRun) {
    lines.push(`Last maintenance: ${pipelineState.lastMaintenanceRun}`);
  }
  if (settings.maintenanceEveryNRulesInserted > 0) {
    lines.push(
      `Maintenance counter: ${pipelineState.rulesInsertedSinceMaintenance ?? 0}/${settings.maintenanceEveryNRulesInserted}`,
    );
  }

  if (pipelineState.lastProcessedFile) {
    // Show relative path from sessions dir
    const sessionsDir = path.join(os.homedir(), ".pi", "agent");
    const relPath = path.relative(sessionsDir, pipelineState.lastProcessedFile).replace(/\\/g, "/");
    const progress = pipelineState.scanProgress;
    let progressLabel = `line ${pipelineState.lastProcessedLine}`;
    if (progress && progress.totalBytes > 0) {
      const kbRead = Math.round(progress.bytesRead / 1024);
      const kbTotal = Math.round(progress.totalBytes / 1024);
      progressLabel += ` (${kbRead}/${kbTotal} KB)`;
    }
    lines.push(`Last file: ${relPath} (${progressLabel})`);
  }

  if (pipelineState.lastError) {
    lines.push("");
    lines.push(`⚠️ Last cycle had errors: ${pipelineState.lastError}`);
  }

  return lines.join("\n");
}
