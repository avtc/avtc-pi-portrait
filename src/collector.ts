// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "./globals.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getBgScanCheckpointsPath, getPortraitDir, getSessionDirs } from "./config.js";
import { appendDebug, openDebugDump } from "./debug.js";
import { extractContent } from "./filtering.js";
import { setCachedPipelineState } from "./footer.js";
import { buildSingleUserMessage, callPortraitLlm, PAUSED } from "./llm-call.js";
import { EXTRACTION_PROMPT, POST_EXTRACTION_PROMPT } from "./prompts.js";
import { getPortraitSettings } from "./settings-ui.js";
import { loadPortraitState, loadScanCheckpoints, savePortraitState, saveScanCheckpoints } from "./storage.js";
import { TrioDetector } from "./trio-detector.js";
import type {
  BgScanCheckpoints,
  ExtractionResult,
  InteractionSequence,
  PortraitPipelineState,
  ScanCheckpoint,
  ScanCheckpoints,
  ScanResults,
} from "./types.js";

interface DiscoveredFile {
  path: string;
  size: number;
  source: "main" | "subagent";
  checkpoint: ScanCheckpoint | undefined;
  mtimeMs: number;
}

export function discoverFiles(sessionDirs: string[], cutoff: number): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  for (const sessionDir of sessionDirs) {
    if (!fs.existsSync(sessionDir)) continue;
    const projects = fs.readdirSync(sessionDir);
    for (const project of projects) {
      const projectDir = path.join(sessionDir, project);
      if (!fs.statSync(projectDir).isDirectory()) continue;
      const sessionFiles = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
      for (const f of sessionFiles) {
        const fullPath = path.join(projectDir, f);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size === 0 || stat.mtimeMs < cutoff) continue;
          const source: "main" | "subagent" = sessionDir.includes("subagent") ? "subagent" : "main";
          files.push({ path: fullPath, size: stat.size, source, checkpoint: undefined, mtimeMs: stat.mtimeMs });
        } catch {
          // File deleted or unreadable
        }
      }
    }
  }
  // Sort all files by mtime descending — most recent sessions scanned first
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

export const DEFAULT_MAX_FILES_PER_CYCLE = 10;
export const DEFAULT_MAX_RESULTS = Infinity;

export async function scanSessions(
  portraitDir: string,
  state: PortraitPipelineState,
  maxFilesPerCycle: number,
  maxResults: number,
): Promise<ScanResults> {
  const checkpoints = loadScanCheckpoints(portraitDir);
  const settings = getPortraitSettings();
  const maxAgeMs = settings.maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const sessionDirs = getSessionDirs();

  // Discover all files and calculate KB progress
  // Y (total remaining) = FilesTotal - CheckpointKB (already scanned in prior cycles)
  // X (session progress) = KB processed since this cycle started (starts at 0)
  const allFiles = discoverFiles(sessionDirs, cutoff);
  for (const f of allFiles) {
    f.checkpoint = checkpoints[f.path];
  }
  setCachedPipelineState(state); // Persist immediately so footer shows MB from scan start

  let filesProcessed = 0;
  let triosProcessed = state.triosProcessed;
  const totalKnownTrios = state.totalKnownTrios;
  const results: ExtractionResult[] = [];
  let sessionKB = state.scanSessionKB; // Continue accumulating from prior scanSessions calls
  let lastFooterUpdate = 0; // Throttle footer updates across all files

  for (const file of allFiles) {
    // Catch-up batching: stop after maxFilesPerCycle
    if (filesProcessed >= maxFilesPerCycle) {
      saveScanCheckpoints(portraitDir, checkpoints);
      const remaining = allFiles.length - allFiles.indexOf(file);
      return { results, triosProcessed, totalKnownTrios, remainingFiles: remaining };
    }

    const _lastByte = file.checkpoint?.lastByte ?? 0;

    // Stream file from checkpoint, extracting trios immediately
    let scanResult: { triosFound: number; totalNonEmpty: number; bytesScanned: number };
    try {
      scanResult = await streamAndExtract({
        sessionFile: file.path,
        fileSize: file.size,
        source: file.source,
        state,
        portraitDir,
        checkpoints,
        onProgress: (_trioCount: number, totalNonEmpty: number, bytesRead: number) => {
          // Progress callback — update session KB for footer
          state.lastProcessedFile = file.path;
          state.lastProcessedLine = totalNonEmpty;
          state.scanProgress = { bytesRead, totalBytes: file.size };
          state.scanSessionKB = sessionKB + Math.round(bytesRead / 1024);
          // Throttle footer updates to ~1 per second (across all files)
          const now = Date.now();
          if (now - lastFooterUpdate >= 1000) {
            lastFooterUpdate = now;
            setCachedPipelineState(state);
          }
        },
        onTrio: async (trioResult) => {
          results.push(trioResult);
          triosProcessed++;
          // Update footer with live trio count only (totalKnownTrios is managed by bg scanner)
          state.triosProcessed = triosProcessed;
          setCachedPipelineState(state);
        },
        maxTrios: maxResults - results.length,
      });
    } catch (err) {
      // Only handle file-not-found/access errors — let everything else bubble up
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("ENOENT") || msg.includes("EPERM") || msg.includes("EBUSY") || msg.includes("EACCES")) {
        delete checkpoints[file.path];
        continue;
      }
      throw err;
    }

    const { totalNonEmpty, bytesScanned } = scanResult;
    filesProcessed++;

    // Update checkpoint if scan advanced
    const prevByte = file.checkpoint?.lastByte ?? 0;
    const newByte = prevByte + bytesScanned;
    if (newByte > prevByte) {
      checkpoints[file.path] = { lastByte: newByte };
      sessionKB += Math.round(bytesScanned / 1024);
    }

    state.lastProcessedFile = file.path;
    state.lastProcessedLine = totalNonEmpty;
    state.scanProgress = undefined; // Done with this file
    state.scanSessionKB = sessionKB;
    setCachedPipelineState(state); // Immediate footer update at file boundary

    // Stop early if we have enough results
    if (results.length >= maxResults) {
      saveScanCheckpoints(portraitDir, checkpoints);
      state.triosProcessed = triosProcessed;
      const remaining = allFiles.length - allFiles.indexOf(file) - 1;
      return { results, triosProcessed, totalKnownTrios, remainingFiles: remaining };
    }

    // Yield to event loop every 10 files
    if (filesProcessed % 10 === 0) {
      await Promise.resolve();
    }
  }

  saveScanCheckpoints(portraitDir, checkpoints);
  state.triosProcessed = triosProcessed;

  return { results, triosProcessed, totalKnownTrios, remainingFiles: 0 };
}

/** Load bg scan checkpoints from dedicated file (avoids race with main state file) */
function loadBgScanCheckpoints(): BgScanCheckpoints {
  const filePath = getBgScanCheckpointsPath();
  try {
    const raw: Record<string, unknown> = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || raw === null) return {};
    // Migrate old field names and clean up orphans
    for (const key of Object.keys(raw)) {
      const cp = raw[key] as Record<string, number | undefined>;
      if (cp.lastByte === undefined) cp.lastByte = cp.lastLine ?? 0;
      if (cp.extractionCheckpointByte === undefined) cp.extractionCheckpointByte = cp.extractionCheckpointLine ?? 0;
      // Remove orphan old fields after migration
      delete cp.lastLine;
      delete cp.extractionCheckpointLine;
    }
    return raw as BgScanCheckpoints;
  } catch {
    return {};
  }
}

/** Save bg scan checkpoints to dedicated file */
function saveBgScanCheckpoints(checkpoints: BgScanCheckpoints): void {
  const filePath = getBgScanCheckpointsPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(checkpoints), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Fast background scan: count total pending trios across all remaining files.
 * No LLM calls — parses entries and detects complete trios immediately.
 * Maintains its own checkpoint map so it doesn't re-scan on each /collect.
 * Uses extraction checkpoints (lastByte) to know which region is pending.
 * Yields to event loop periodically to avoid blocking.
 */
export async function countPendingTrios(portraitDir: string, maxAgeDays: number | undefined): Promise<number> {
  const settings = getPortraitSettings();
  const maxAgeMs = (maxAgeDays ?? settings.maxAgeDays) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const sessionDirs = getSessionDirs();

  const allFiles = discoverFiles(sessionDirs, cutoff);
  const extractionCheckpoints = loadScanCheckpoints(portraitDir);
  const _state = loadPortraitState(portraitDir);
  const bgCheckpoints = loadBgScanCheckpoints();

  let totalTrios = 0;
  let changed = false;

  for (let i = 0; i < allFiles.length; i++) {
    // Yield to event loop every 5 files, check cancellation
    if (i % 5 === 0 && i > 0) {
      await Promise.resolve();
      // Save checkpoints every 50 files to avoid losing progress on crash
      if (i % 50 === 0 && changed) saveBgScanCheckpoints(bgCheckpoints);
      const gstate = globalThis.__piPortrait;
      if (gstate?.collectCancelled || gstate?.bgScanCancelled) {
        // Save partial progress
        if (changed) saveBgScanCheckpoints(bgCheckpoints);
        return totalTrios;
      }
      // Update running total for live footer display
      const updated = loadPortraitState(portraitDir);
      updated.totalKnownTrios = totalTrios;
      savePortraitState(portraitDir, updated);
      // Update cache without overwriting phase (collect owns phase)
      const cached = globalThis.__piPortraitPipelineState;
      if (cached) {
        cached.totalKnownTrios = totalTrios;
      }
    }

    const file = allFiles[i];
    const extCp = extractionCheckpoints[file.path];
    const extCheckedByte = extCp?.lastByte ?? 0;
    const bgCp = bgCheckpoints[file.path];

    // If extraction checkpoint hasn't changed since last bg scan, use cached count
    if (bgCp && bgCp.extractionCheckpointByte === extCheckedByte) {
      totalTrios += bgCp.triosCount;
      continue;
    }

    // Extraction advanced — must re-scan from new checkpoint.
    // Cached count is stale (included trios now in extracted region).

    try {
      const fileStream = fs.createReadStream(file.path, { encoding: "utf-8", start: extCheckedByte });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      let fileTrios = 0;
      let bytesScanned = 0;
      const detector = new TrioDetector();

      for await (const line of rl) {
        if (!line.trim()) {
          bytesScanned += 1; // just the newline
          continue;
        }

        // Yield to event loop every ~50 lines for cancellation checks
        bytesScanned += Buffer.byteLength(line, "utf-8") + 1;

        try {
          const entry = JSON.parse(line);
          const trio = detector.process(entry);
          if (trio) fileTrios++;
        } catch {
          // Malformed line — skip
        }
      }

      // Update bg checkpoint
      bgCheckpoints[file.path] = {
        lastByte: bytesScanned,
        triosCount: fileTrios,
        extractionCheckpointByte: extCheckedByte,
      };
      changed = true;

      totalTrios += fileTrios;
    } catch {
      // File unreadable — skip
    }
  }

  // Save bg scan checkpoints
  if (changed) {
    saveBgScanCheckpoints(bgCheckpoints);
  }

  return totalTrios;
}

/**
 * Stream a session file line-by-line, building entries and extracting trios incrementally.
 * Returns immediately when maxResults trios are found, without reading the rest of the file.
 */
interface StreamAndExtractOptions {
  sessionFile: string;
  fileSize: number;
  source: "main" | "subagent";
  state: PortraitPipelineState;
  portraitDir: string;
  checkpoints: ScanCheckpoints;
  onProgress: (trios: number, totalNonEmpty: number, bytesRead: number) => void;
  onTrio: (result: ExtractionResult) => Promise<void>;
  maxTrios: number;
}

async function streamAndExtract(
  opts: StreamAndExtractOptions,
): Promise<{ triosFound: number; totalNonEmpty: number; bytesScanned: number }> {
  const { sessionFile, source, portraitDir, checkpoints, onProgress, onTrio, maxTrios } = opts;

  const checkpointByte = checkpoints[sessionFile]?.lastByte ?? 0;
  const fileStream = fs.createReadStream(sessionFile, { encoding: "utf-8", start: checkpointByte });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let triosFound = 0;
  let bytesRead = 0; // bytes read since resume (for progress)

  // Trio detection is delegated to TrioDetector (shared with countPendingTrios)
  // to keep the two paths consistent. bytePos is tracked separately for checkpointing.
  const detector = new TrioDetector();
  let lastUserBytePos = 0;

  // Helper to save checkpoint mid-file (after each trio extraction)
  function saveMidFileCheckpoint(bytePos: number) {
    checkpoints[sessionFile] = {
      lastByte: checkpointByte + bytePos,
    };
    saveScanCheckpoints(portraitDir, checkpoints);
  }

  // Helper to try extracting a complete trio (agent→user→agent)
  async function tryExtractTrio(trio: {
    agentBefore: string;
    userFeedback: string;
    agentAfter: string;
  }): Promise<boolean> {
    const settings = getPortraitSettings();
    const { notes, summary, dumpPath } = await callExtractionLlm(
      { agentBefore: trio.agentBefore, userFeedback: trio.userFeedback, agentAfter: trio.agentAfter },
      settings.debugDumpLimit,
    );
    const validated = settings.postExtractionEnabled
      ? await postExtractRules(notes, summary, dumpPath, settings.postExtractionModel || undefined)
      : notes;
    if (validated.length > 0) {
      const result: ExtractionResult = { behaviorNotes: validated, sessionPath: sessionFile, source };
      await onTrio(result);
      triosFound++;
    }
    // Advance checkpoint past this user turn (even if no notes — prevents re-extraction)
    saveMidFileCheckpoint(lastUserBytePos);
    return triosFound >= maxTrios;
  }

  for await (const line of rl) {
    if (!line.trim()) continue;

    const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
    bytesRead += lineBytes;

    // Parse entry — SessionMessageEntry wraps AgentMessage inside a `message` field
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message") {
        // Track bytePos of user messages for checkpointing (TrioDetector doesn't track this)
        const msg = entry.message;
        if (msg.role === "user" || (msg.role === "toolResult" && msg.toolName === "ask_user_question")) {
          lastUserBytePos = bytesRead - lineBytes;
        }
        // Delegate trio detection to TrioDetector
        const trio = detector.process(entry);
        if (trio) {
          const limitReached = await tryExtractTrio(trio);
          onProgress(triosFound, bytesRead, bytesRead);
          if (limitReached) {
            fileStream.destroy();
            return { triosFound, totalNonEmpty: bytesRead, bytesScanned: bytesRead };
          }
        }
      }
    } catch (err) {
      // PAUSED (user paused from the LLM retry dialog) must propagate up to the pipeline —
      // do NOT swallow it here as a malformed line, or the scan continues and the retry
      // dialog re-appears after the user already chose to pause.
      if (err instanceof Error && err.message === "PAUSED") throw err;
      // Malformed line — skip
    }

    // Report progress every ~50 lines worth of bytes
    if (bytesRead % (50 * 200) < lineBytes) {
      // ~every 50 lines (avg 200 bytes/line)
      onProgress(triosFound, bytesRead, bytesRead);
    }
  }

  // Final pass: try to extract any remaining complete trio
  // (no-op if lastAssistant/lastUser already cleared)

  fileStream.destroy();
  return { triosFound, totalNonEmpty: bytesRead, bytesScanned: bytesRead };
}

/**
 * Build a tool call summary.
 * - read/grep/find/ls/web_search/web_fetch/recall: compact summary only
 * - write/edit: full content (what agent wrote — user may correct this)
 * - bash: full command
 * - ask_user_question: full question text
 * - todo tools / plan_tracker / phase_ready / fork: compact summary
 * - subagent: task description + agent name
 * - unknown: compact summary
 */
export function summarizeToolCall(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return `[${name}]`;
  const a = args as Record<string, unknown>;
  switch (name) {
    case "read":
      return `[read: ${a.path || "?"}${a.offset ? `:${a.offset}` : ""}]`;
    case "grep":
      return `[grep: "${a.pattern || "?"}" in ${a.path || "?"}]`;
    case "find":
      return `[find: ${a.pattern || "?"} in ${a.path || "?"}]`;
    case "ls":
      return `[ls: ${a.path || "?"}]`;
    case "write": {
      const content = a.content || "";
      return `[write: ${a.path || "?"}]\n${content}`;
    }
    case "edit": {
      const edits = (a.edits as Array<{ oldText?: string; newText?: string }> | undefined) || [];
      const diffs = edits.map((e) => `---\n${e.oldText || ""}\n+++\n${e.newText || ""}`).join("\n");
      return `[edit: ${a.path || "?"}]\n${diffs}`;
    }
    case "bash":
      return `[bash: ${a.command || "?"}]`;
    case "ask_user_question": {
      const questions = (a.questions as Array<{ question?: string; options?: string[] }> | undefined) || [];
      const qText = questions.map((q) => `${q.question || "?"} (${(q.options || []).join("/")})`).join("; ");
      return `[ask_user_question: ${qText}]`;
    }
    case "subagent": {
      const task = a.task || "?";
      const agent = a.agent || "?";
      return `[subagent: ${agent}] ${task}`;
    }
    case "web_search":
      return `[web_search: ${a.query || "?"}]`;
    case "web_fetch":
      return `[web_fetch: ${a.url || "?"}]`;
    case "recall":
      return `[recall: ${a.id || "?"}]`;
    case "plan_tracker":
      return `[plan_tracker: ${a.action || "?"}]`;
    case "phase_ready":
      return "[phase_ready]";
    case "fork":
      return "[fork]";
    case "todo_init":
    case "todo_add":
    case "todo_update":
    case "todo_complete":
    case "todo_list":
      return `[${name}]`;
    default: {
      const argsStr = JSON.stringify(args);
      const truncated = argsStr.length > 200 ? `${argsStr.substring(0, 200)}...` : argsStr;
      return `[${name}: ${truncated}]`;
    }
  }
}

/**
 * Build a tool result summary based on tool type.
 * - write/edit: skip (content is in the tool call, result is just confirmation)
 * - bash: skip (command is in the tool call, output is noise)
 * - subagent: full result (delegated work output)
 * - read/grep/find/ls/web_search/web_fetch/recall: skip (research material — tool call summary is enough)
 * - todo tools / plan_tracker / phase_ready / ask_user_question / fork: skip
 * - unknown: skip (tool call summary is enough)
 */
export function summarizeToolResult(content: unknown, toolName: string | undefined): string {
  const text = extractContent(content);
  if (!text) return "";

  // Skip tools where result is confirmation/workflow noise or research material
  // (tool call summary already provides enough context)
  if (
    toolName &&
    (toolName === "write" ||
      toolName === "edit" ||
      toolName === "read" ||
      toolName === "grep" ||
      toolName === "find" ||
      toolName === "ls" ||
      toolName === "web_search" ||
      toolName === "web_fetch" ||
      toolName === "recall" ||
      toolName === "bash" ||
      toolName.startsWith("todo_") ||
      toolName === "plan_tracker" ||
      toolName === "phase_ready" ||
      toolName === "ask_user_question" ||
      toolName === "fork")
  ) {
    return "";
  }

  // Subagent: full result (delegated work output)
  if (toolName === "subagent") {
    return text;
  }

  // All other tools: skip (tool call summary provides enough context)
  return "";
}

interface ExtractionSummary {
  agentBefore: string;
  userFeedback: string;
  agentAfter: string;
}

interface ExtractionCapture {
  notes: string[];
  summary: ExtractionSummary;
}

interface ExtractionLlmResult {
  notes: string[];
  summary: ExtractionSummary;
  dumpPath: string | null;
}

async function callExtractionLlm(sequence: InteractionSequence, dumpLimit: number): Promise<ExtractionLlmResult> {
  const userText = `<agent-before>
${sequence.agentBefore}
</agent-before>

<user-feedback>
${sequence.userFeedback}
</user-feedback>

<agent-after>
${sequence.agentAfter}
</agent-after>`;

  // Debug dump: write what the extractor agent sees (system prompt + user message).
  // openDebugDump returns null when debugDumpLimit <= 0 (dumps disabled) — appendDebug then no-ops.
  const dumpPath = openDebugDump(getPortraitDir(), "extraction", dumpLimit);
  appendDebug(
    dumpPath,
    `=== Extraction Agent Input ===
--- SYSTEM PROMPT ---
${EXTRACTION_PROMPT}

--- TOOL ---
${JSON.stringify({ name: "return_extraction", description: "Return extracted behavior notes with interaction summary.", input_schema: { type: "object", properties: { summary: { type: "object", properties: { agentBefore: { type: "string" }, userFeedback: { type: "string" }, agentAfter: { type: "string" } }, required: ["agentBefore", "userFeedback", "agentAfter"] }, behaviorNotes: { type: "array", items: { type: "string" } } }, required: ["summary", "behaviorNotes"] } }, null, 2)}

--- USER MESSAGE ---
${userText}
`,
  );

  // Define return tool
  let captured: ExtractionCapture | null = null;

  const returnExtractionTool: AgentTool = {
    name: "return_extraction",
    label: "Return extraction",
    description: "Return extracted behavior notes with interaction summary.",
    parameters: Type.Object({
      summary: Type.Object({
        agentBefore: Type.String(),
        userFeedback: Type.String(),
        agentAfter: Type.String(),
      }),
      behaviorNotes: Type.Array(Type.String()),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const typedParams = params as { summary: ExtractionSummary; behaviorNotes: string[] };
      if (
        !typedParams.summary?.agentBefore?.trim() ||
        !typedParams.summary.userFeedback?.trim() ||
        !typedParams.summary.agentAfter?.trim()
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "The summary is required with all three fields (agentBefore, userFeedback, agentAfter) non-empty.",
            },
          ],
          details: undefined,
        };
      }
      captured = { notes: typedParams.behaviorNotes, summary: typedParams.summary };
      return {
        content: [{ type: "text" as const, text: `Extracted ${typedParams.behaviorNotes.length} notes` }],
        details: undefined,
      };
    },
  };

  // Build messages
  const messages = buildSingleUserMessage(userText);

  // Call shared LLM helper
  const result = await callPortraitLlm<ExtractionCapture>(
    messages,
    EXTRACTION_PROMPT,
    returnExtractionTool,
    () => captured ?? undefined,
    "Previous extraction failed. Please return valid JSON using return_extraction.",
    undefined,
    undefined,
    undefined,
  );

  if (result === PAUSED) throw new Error("PAUSED");
  if (!result) {
    appendDebug(dumpPath, "\n=== Extraction Agent Output ===\n(none)\n");
    return { notes: [], summary: { agentBefore: "", userFeedback: "", agentAfter: "" }, dumpPath };
  }
  const { notes, summary } = result;
  const rulesLines = notes.join("\n") || "(none)";
  const extractionOutput = [
    "\n=== Extraction Agent Output ===",
    `Agent before: ${summary.agentBefore}`,
    `User feedback: ${summary.userFeedback}`,
    `Agent after: ${summary.agentAfter}`,
    "Rules:",
    rulesLines,
    "",
  ].join("\n");
  appendDebug(dumpPath, extractionOutput);
  return { notes, summary, dumpPath };
}

/**
 * Post-extraction validation: re-evaluate extracted rules using summarized interaction context.
 * Rules that pass quality gates are returned (possibly refined).
 * Rules that fail are silently dropped.
 * Appends results to the extraction dump file.
 */
async function postExtractRules(
  rules: string[],
  summary: ExtractionSummary,
  dumpPath: string | null,
  modelOverride: string | undefined,
): Promise<string[]> {
  if (rules.length === 0) return [];

  const rulesBlock = rules.join("\n");
  const interactionBlock = [
    `<agent-before>\n${summary.agentBefore}\n</agent-before>`,
    `<user-feedback>\n${summary.userFeedback}\n</user-feedback>`,
    `<agent-after>\n${summary.agentAfter}\n</agent-after>`,
    `<rules>\n${rulesBlock}\n</rules>`,
  ].join("\n\n");
  appendDebug(
    dumpPath,
    `\n=== Post-Extraction Input ===
--- SYSTEM PROMPT ---
${POST_EXTRACTION_PROMPT}

--- TOOL ---
${JSON.stringify({ name: "return_post_extraction", description: "Return validated behavior notes.", input_schema: { type: "object", properties: { behaviorNotes: { type: "array", items: { type: "string" } } }, required: ["behaviorNotes"] } }, null, 2)}

--- USER MESSAGE ---
${interactionBlock}
`,
  );

  // Define return tool (same schema as extraction)
  let extractedNotes: string[] | null = null;

  const returnTool: AgentTool = {
    name: "return_post_extraction",
    label: "Return post-extraction results",
    description: "Return validated behavior notes.",
    parameters: Type.Object({
      behaviorNotes: Type.Array(Type.String()),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const typedParams = params as { behaviorNotes: string[] };
      extractedNotes = typedParams.behaviorNotes;
      return {
        content: [{ type: "text" as const, text: `Validated ${typedParams.behaviorNotes.length} notes` }],
        details: undefined,
      };
    },
  };

  // Build messages
  const messages = buildSingleUserMessage(interactionBlock);

  // Call shared LLM helper
  const result = await callPortraitLlm<string[]>(
    messages,
    POST_EXTRACTION_PROMPT,
    returnTool,
    () => extractedNotes ?? undefined,
    "Previous post-extraction failed. Please return valid JSON using return_post_extraction.",
    modelOverride,
    undefined,
    undefined,
  );

  if (result === PAUSED) throw new Error("PAUSED");
  const validated = result ?? [];
  // Append to extraction dump file with kept/rejected breakdown
  const resultLines = validated.join("\n") || "(none)";
  appendDebug(dumpPath, `\n=== Post-Extraction Output ===\n${resultLines}\n`);
  return validated;
}
