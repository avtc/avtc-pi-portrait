// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Settings
import type { PortraitUiNotify, PortraitUiSelect } from "./globals.js";
import type { SqliteMutex } from "./snippets/vendored/sqlite-mutex.js";

export type { ThinkingLevel } from "@earendil-works/pi-ai";

// globalThis state
export interface PortraitState {
  lockHeld: boolean;
  /** The held main-lock SQLite mutex (release at teardown). null when not held. */
  mainMutex: SqliteMutex | null;
  timer: ReturnType<typeof setInterval> | null;
  lockPollTimer: ReturnType<typeof setInterval> | null;
  cachedPortrait: string | undefined;
  cachedPortraitLoadTime: Date | undefined;
  // Cancellation flag for /portrait:stop to interrupt /portrait:collect
  collectCancelled: boolean;
  // Cancellation flag for background trio counter (checked at yield points)
  bgScanCancelled: boolean;
  // Collect lock — guards the collection pipeline (timer or manual)
  collectLockHeld: boolean;
  /** The held collect-lock SQLite mutex (release when the collection ends). null when not held. */
  collectMutex: SqliteMutex | null;
  // UI methods captured from ctx.ui (bound) for timer/callback access
  uiNotify: PortraitUiNotify | null;
  uiSelect: PortraitUiSelect | null;
  // Cached pipeline state for footer
  cachedPipelineState: PortraitPipelineState | null;
  // Functions exposed for cross-module access (no circular imports)
  startProfilingTimer: (() => void) | null;
  runProfilingCycle: (() => Promise<void>) | null;
  reportError: ((errorMsg: string, source: string) => void) | null;
}

// Scan checkpoint (byte position of last extracted user turn)
export interface ScanCheckpoint {
  lastByte: number;
}

export interface ScanCheckpoints {
  [filePath: string]: ScanCheckpoint;
}

// Background trio counter checkpoints (persisted, own scan progress)
export interface BgScanCheckpoint {
  lastByte: number; // Bytes scanned by bg scanner from extraction checkpoint
  triosCount: number; // Trio count for this file
  extractionCheckpointByte: number; // Extraction checkpoint byte at time of scan
}

export interface BgScanCheckpoints {
  [filePath: string]: BgScanCheckpoint;
}

// Portrait pipeline state (persisted to portrait-state.json)
export interface PortraitPipelineState {
  paused: boolean;
  pausedAt: string | null;
  pausedBy: { pid: number } | null;
  lastPipelineRun: string | null;
  lastScanTimestamp: string | null;
  lastProcessedFile: string | null;
  lastProcessedLine: number;
  scanProgress: { bytesRead: number; totalBytes: number } | undefined;
  scanRemainingKB: number; // Remaining KB to scan (after checkpoints)
  scanSessionKB: number; // KB scanned in current collect session (resets on start/restart)
  triosProcessed: number;
  totalKnownTrios: number;
  pipelinePhase: "idle" | "scanning" | "processing" | "maintaining";
  maintenanceStatus: string; // Runtime-only: descriptive text shown in footer when phase === 'maintaining'
  llmTokens: number; // Runtime-only: streamed output-token count for the active LLM call (provider-reported)
  llmWords: number; // Runtime-only: streamed word count for the active LLM call (footer progress)
  remainingFiles: number;
  lastError: string | null;
  rulesInsertedSinceMaintenance: number;
  lastMaintenanceRun: string | null;
}

export const DEFAULT_PIPELINE_STATE: PortraitPipelineState = {
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
  maintenanceStatus: "",
  llmTokens: 0,
  llmWords: 0,
  remainingFiles: 0,
  lastError: null,
  rulesInsertedSinceMaintenance: 0,
  lastMaintenanceRun: null,
};

// LLM extraction
export interface ExtractionResult {
  behaviorNotes: string[];
  sessionPath: string;
  source: "main" | "subagent";
}

// Building LLM
export interface BuildingDecision {
  candidate: string;
  action: "insert" | "merge" | "skip";
  beforePosition?: number | string;
  evictPositions?: (number | string)[]; // 1-indexed portrait positions or candidate IDs
  mergePosition?: number; // 1-indexed existing rule to fold into (action: 'merge')
  text?: string; // merged rule text replacing the target (action: 'merge')
}

export interface BuildingResponse {
  decisions: BuildingDecision[];
}

// Scan results
export interface ScanResults {
  results: ExtractionResult[];
  triosProcessed: number;
  totalKnownTrios: number;
  remainingFiles: number;
}

// Interaction sequence (agent→user→agent trio)
export interface InteractionSequence {
  agentBefore: string;
  userFeedback: string;
  agentAfter: string;
}
