// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import { reportError } from "./error.js";
import { checkoutHead } from "./git.js";
import type { PortraitPipelineState, ScanCheckpoints } from "./types.js";
import { DEFAULT_PIPELINE_STATE } from "./types.js";

export const PORTRAIT_MD_HEADER = `# User Portrait

Anticipate what the user will ask, flag, or correct. Before producing output, check:
- Does this output follow the user's known expectations?
- Are there concerns the user typically raises that this output doesn't address?
- Would the user need to ask follow-up questions, or is this already complete?

## Anticipation Rules
`;

export const EVICTED_MD_HEADER = `# Evicted Portrait Rules
`;

export const DROPPED_MD_HEADER = `# Dropped Portrait Rules
`;

export function readPortrait(portraitDir: string): string | undefined {
  const filePath = path.join(portraitDir, "portrait.md");
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    // Basic corruption check: must contain the header
    if (!content.includes("## Anticipation Rules")) {
      reportError("portrait.md corrupted, restoring from git", "storage error");
      if (checkoutHead(portraitDir, "portrait.md")) {
        return fs.readFileSync(filePath, "utf-8");
      }
    }
    return content;
  } catch {
    return undefined;
  }
}

export function writePortrait(portraitDir: string, rules: string[]): void {
  const filePath = path.join(portraitDir, "portrait.md");
  const content = PORTRAIT_MD_HEADER + (rules.length > 0 ? `${rules.join("\n")}\n` : "");
  atomicWriteFile(filePath, content);
}

/** Read a newline-delimited rule list from {portraitDir}/{filename}.md, stripping markdown headers (lines starting with #). Returns [] when the file is absent/unreadable. */
function readRuleListFile(portraitDir: string, filename: string): string[] {
  const filePath = path.join(portraitDir, filename);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith("##"))
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readEvicted(portraitDir: string): string[] {
  return readRuleListFile(portraitDir, "evicted.md");
}

export function readDropped(portraitDir: string): string[] {
  return readRuleListFile(portraitDir, "dropped.md");
}

/** Read existing content (or fallback to header when absent) and append new rules, skipping those already present. Writes nothing if all rules already exist. */
function appendRulesDedup(filePath: string, rules: string[], fallbackHeader: string): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    content = fallbackHeader;
  }
  // Deduplicate: skip rules already present (stripping markdown headers)
  const existingLines = new Set(
    content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  const newRules = rules.filter((r) => !existingLines.has(r.trim()));
  if (newRules.length === 0) return;
  content += `${newRules.join("\n")}\n`;
  atomicWriteFile(filePath, content);
}

export function appendEvicted(portraitDir: string, rules: string[]): void {
  appendRulesDedup(path.join(portraitDir, "evicted.md"), rules, EVICTED_MD_HEADER);
}

export function appendDropped(portraitDir: string, rules: string[]): void {
  // No cap — keep all dropped rules
  appendRulesDedup(path.join(portraitDir, "dropped.md"), rules, DROPPED_MD_HEADER);
}

export function writeEvicted(portraitDir: string, rules: string[]): void {
  const filePath = path.join(portraitDir, "evicted.md");
  const content = rules.length > 0 ? `${EVICTED_MD_HEADER + rules.join("\n")}\n` : EVICTED_MD_HEADER;
  atomicWriteFile(filePath, content);
}

export function writeDropped(portraitDir: string, rules: string[]): void {
  const filePath = path.join(portraitDir, "dropped.md");
  const content = rules.length > 0 ? `${DROPPED_MD_HEADER + rules.join("\n")}\n` : DROPPED_MD_HEADER;
  atomicWriteFile(filePath, content);
}

export function parsePortraitRules(content: string): string[] {
  const headerEnd = content.indexOf("## Anticipation Rules\n");
  if (headerEnd < 0) return [];
  const rulesSection = content.slice(headerEnd + "## Anticipation Rules\n".length);
  return rulesSection
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.trim())
    .filter(Boolean);
}

export function loadScanCheckpoints(portraitDir: string): ScanCheckpoints {
  const filePath = path.join(portraitDir, "processed-sessions.json");
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const raw: ScanCheckpoints = JSON.parse(content);
    // Backfill lastByte for old checkpoints missing the field
    for (const key of Object.keys(raw)) {
      if (raw[key].lastByte === undefined) {
        raw[key].lastByte = 0;
      }
    }
    return raw;
  } catch {
    return {};
  }
}

export function saveScanCheckpoints(portraitDir: string, checkpoints: ScanCheckpoints): void {
  const filePath = path.join(portraitDir, "processed-sessions.json");
  atomicWriteFile(filePath, JSON.stringify(checkpoints, null, 2));
}

export function loadPortraitState(portraitDir: string): PortraitPipelineState {
  const filePath = path.join(portraitDir, "portrait-state.json");
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = JSON.parse(content);
    // Validate types before merging
    const validPaused = typeof raw.paused === "boolean" ? raw.paused : DEFAULT_PIPELINE_STATE.paused;
    const validPhase = ["idle", "scanning", "processing", "maintaining"].includes(raw.pipelinePhase)
      ? raw.pipelinePhase
      : DEFAULT_PIPELINE_STATE.pipelinePhase;
    return {
      ...DEFAULT_PIPELINE_STATE,
      paused: validPaused,
      pausedAt: typeof raw.pausedAt === "string" ? raw.pausedAt : DEFAULT_PIPELINE_STATE.pausedAt,
      pausedBy: raw.pausedBy && typeof raw.pausedBy.pid === "number" ? raw.pausedBy : DEFAULT_PIPELINE_STATE.pausedBy,
      lastPipelineRun:
        typeof raw.lastPipelineRun === "string" ? raw.lastPipelineRun : DEFAULT_PIPELINE_STATE.lastPipelineRun,
      lastScanTimestamp:
        typeof raw.lastScanTimestamp === "string" ? raw.lastScanTimestamp : DEFAULT_PIPELINE_STATE.lastScanTimestamp,
      lastProcessedFile:
        typeof raw.lastProcessedFile === "string" ? raw.lastProcessedFile : DEFAULT_PIPELINE_STATE.lastProcessedFile,
      lastProcessedLine:
        typeof raw.lastProcessedLine === "number" && Number.isFinite(raw.lastProcessedLine)
          ? raw.lastProcessedLine
          : DEFAULT_PIPELINE_STATE.lastProcessedLine,
      scanProgress: DEFAULT_PIPELINE_STATE.scanProgress, // Not persisted — runtime only
      scanRemainingKB:
        typeof raw.scanRemainingKB === "number" && Number.isFinite(raw.scanRemainingKB)
          ? raw.scanRemainingKB
          : // Migrate old variable name: scanTotalKB → scanRemainingKB
            typeof raw.scanTotalKB === "number" && Number.isFinite(raw.scanTotalKB)
            ? raw.scanTotalKB
            : DEFAULT_PIPELINE_STATE.scanRemainingKB,
      scanSessionKB:
        typeof raw.scanSessionKB === "number" && Number.isFinite(raw.scanSessionKB)
          ? raw.scanSessionKB
          : // Migrate old variable name: scanCumulativeKB → scanSessionKB
            typeof raw.scanCumulativeKB === "number" && Number.isFinite(raw.scanCumulativeKB)
            ? raw.scanCumulativeKB
            : DEFAULT_PIPELINE_STATE.scanSessionKB,
      triosProcessed:
        typeof raw.triosProcessed === "number" && Number.isFinite(raw.triosProcessed)
          ? raw.triosProcessed
          : DEFAULT_PIPELINE_STATE.triosProcessed,
      totalKnownTrios:
        typeof raw.totalKnownTrios === "number" && Number.isFinite(raw.totalKnownTrios)
          ? raw.totalKnownTrios
          : DEFAULT_PIPELINE_STATE.totalKnownTrios,
      pipelinePhase: validPhase,
      maintenanceStatus: DEFAULT_PIPELINE_STATE.maintenanceStatus, // Runtime-only — not persisted
      llmTokens: DEFAULT_PIPELINE_STATE.llmTokens, // Runtime-only — not persisted
      llmWords: DEFAULT_PIPELINE_STATE.llmWords, // Runtime-only — not persisted
      remainingFiles:
        typeof raw.remainingFiles === "number" && Number.isFinite(raw.remainingFiles)
          ? raw.remainingFiles
          : DEFAULT_PIPELINE_STATE.remainingFiles,
      lastError: typeof raw.lastError === "string" ? raw.lastError : DEFAULT_PIPELINE_STATE.lastError,
      rulesInsertedSinceMaintenance:
        typeof raw.rulesInsertedSinceMaintenance === "number" &&
        Number.isFinite(raw.rulesInsertedSinceMaintenance) &&
        Number.isInteger(raw.rulesInsertedSinceMaintenance) &&
        raw.rulesInsertedSinceMaintenance >= 0
          ? raw.rulesInsertedSinceMaintenance
          : DEFAULT_PIPELINE_STATE.rulesInsertedSinceMaintenance,
      lastMaintenanceRun:
        typeof raw.lastMaintenanceRun === "string" ? raw.lastMaintenanceRun : DEFAULT_PIPELINE_STATE.lastMaintenanceRun,
    };
  } catch {
    return { ...DEFAULT_PIPELINE_STATE };
  }
}

export function savePortraitState(portraitDir: string, state: PortraitPipelineState): void {
  const filePath = path.join(portraitDir, "portrait-state.json");
  atomicWriteFile(filePath, JSON.stringify(state, null, 2));
}

function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}
