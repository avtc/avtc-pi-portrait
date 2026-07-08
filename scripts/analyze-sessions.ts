#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * analyze-sessions — Analyze recent session files for trio detection.
 *
 * Uses the same filtering logic as the production code (filtering.ts, trio-detector.ts).
 *
 * Usage:
 *   npx tsx scripts/analyze-sessions.ts [days-back]
 *
 * Defaults to 3 days if no argument provided.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONTINUATION_PATTERNS, EXTENSION_MESSAGE_PATTERNS } from "../src/filtering.js";
import { TrioDetector } from "../src/trio-detector.js";

const daysBack = parseInt(process.argv[2] || "3", 10);
const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
// Exclude the current session file to avoid contaminating results with our own output
const excludeFiles = new Set(["2026-06-13T08-25-59-808Z_019ec016-7d00-76cd-841e-c00110edf37e.jsonl"]);

function findRecentFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const subFiles = fs.readdirSync(fullPath).filter((f) => f.endsWith(".jsonl"));
        for (const f of subFiles) {
          if (excludeFiles.has(f)) continue;
          const file = path.join(fullPath, f);
          const fstat = fs.statSync(file);
          if (fstat.mtimeMs >= cutoff) {
            results.push(file);
          }
        }
      }
    } catch {
      /* skip */
    }
  }
  return results.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

const files = findRecentFiles(sessionsDir);
console.log(`Found ${files.length} session files (last ${daysBack} days)\n`);

let totalFiles = 0;
let totalSequences = 0;
let totalUserMessages = 0;
let totalAssistantMessages = 0;
const countedUserMsgs: { msg: string; file: string }[] = [];

for (const file of files) {
  const content = fs.readFileSync(file, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  const detector = new TrioDetector();
  let fileSequences = 0;
  let fileUserMsgs = 0;
  let fileAssistantMsgs = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message") {
        const msg = entry.message;
        if (msg.role === "user" || (msg.role === "toolResult" && msg.toolName === "ask_user_question")) {
          fileUserMsgs++;
        } else if (msg.role === "assistant") {
          fileAssistantMsgs++;
        }
        const trio = detector.process(entry);
        if (trio) {
          fileSequences++;
          if (countedUserMsgs.length < 10000) {
            countedUserMsgs.push({ msg: trio.userFeedback.substring(0, 200), file: path.basename(file) });
          }
        }
      }
    } catch {
      /* skip malformed lines */
    }
  }

  totalFiles++;
  totalSequences += fileSequences;
  totalUserMessages += fileUserMsgs;
  totalAssistantMessages += fileAssistantMsgs;

  const relPath = file.replace(`${sessionsDir}/`, "").replace(/\\/g, "/");
  console.log(`${relPath}`);
  console.log(`  Sequences: ${fileSequences} | Users: ${fileUserMsgs} | Assistants: ${fileAssistantMsgs}`);
}

console.log("\n=== TOTALS ===");
console.log(`Files: ${totalFiles}`);
console.log(`Sequences (counted): ${totalSequences}`);
console.log(`User messages: ${totalUserMessages}`);
console.log(`Assistant messages: ${totalAssistantMessages}`);

// Aggregate by first 20 chars
console.log("\n=== AGGREGATION BY FIRST 20 CHARS ===");
const prefixes: Record<string, { count: number; examples: string[] }> = {};
for (const m of countedUserMsgs) {
  const prefix = m.msg.trim().substring(0, 20).replace(/\n/g, " ");
  if (!prefixes[prefix]) prefixes[prefix] = { count: 0, examples: [] };
  prefixes[prefix].count++;
  if (prefixes[prefix].examples.length < 2) {
    prefixes[prefix].examples.push(m.msg.substring(0, 100).replace(/\n/g, " "));
  }
}
const sorted = Object.entries(prefixes).sort((a, b) => b[1].count - a[1].count);
for (const [prefix, data] of sorted) {
  console.log(`[${data.count}x] "${prefix}..."`);
  for (const ex of data.examples) {
    console.log(`      → ${ex}`);
  }
}

console.log("\n=== CONTINUATION PATTERNS ===");
for (const pattern of CONTINUATION_PATTERNS) {
  console.log(`  ${pattern}`);
}

console.log("\n=== ACTIVE PATTERNS ===");
for (const pattern of EXTENSION_MESSAGE_PATTERNS) {
  console.log(`  ${pattern}`);
}
