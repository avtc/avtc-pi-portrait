// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Shared filtering logic for detecting continuation, approval, and extension-generated messages.
 * Used by collector.ts (bg scan + extraction) and scripts/analyze-sessions.ts.
 */

// ── Continuation messages ──

/**
 * Bare continuation phrases injected by the framework (not meaningful user input).
 * These trigger phase transitions or compaction follow-ups.
 */
export const CONTINUATION_PATTERNS: RegExp[] = [
  /^continue$/i, // bare continue (agent-lifecycle, compaction)
  /^commit$/i, // bare commit (phase transition)
  /^please continue$/i, // empty response auto-retry (agent-lifecycle.ts)
  /^commit then proceed$/i, // commit + continue (phase transition)
  /^commit your changes$/i, // commit request (phase transition)
  /^commit files you have changed$/i, // commit request (phase transition)
];

export function isContinuation(text: string): boolean {
  const t = text.trim();
  return CONTINUATION_PATTERNS.some((p) => p.test(t));
}

// ── Approval phrases ──

/**
 * Short user confirmations that represent genuine decisions (not extension-generated).
 * Excludes continuation messages which are tracked in CONTINUATION_PATTERNS.
 */
const APPROVAL_PHRASES = ["yes", "ok", "good", "looks good", "go ahead", "approved", "proceed", "apply"];

export function isApproval(content: string): boolean {
  const normalized = content
    .trim()
    .toLowerCase()
    .replace(/[?.!,]/g, "");
  return APPROVAL_PHRASES.includes(normalized);
}

// ── Extension message patterns ──

/**
 * Extension-generated follow-up patterns (not user input, not continuation).
 * Derived from scanning all session files + source code analysis:
 * - 'Plan review complete...' (26) — plan-review-iteration handoff (review-context.ts)
 * - 'TODO #N: ...' (9) — compaction follow-up with task details (compaction.ts)
 * - 'Continuing work on feature: ...' (19) — kanban auto-agent lifecycle
 * - '▶ N: ...' (44) — pi-todo context reset follow-up (handlers.ts)
 * - '[Pending dialog — ...' — compaction dialog restoration
 * - 'Run design/plan review iteration #N' — review loop follow-up (phase-ready.ts)
 * - 'Context was compacted...' — compaction restoration message (compact-message.ts)
 * - 'Context was reset between tasks...' — plan-tracker task continuation (plan-tracker.ts)
 * - 'Work on feature:...' — kanban auto-agent lifecycle (auto-agent-lifecycle.ts)
 */
export const EXTENSION_MESSAGE_PATTERNS: RegExp[] = [
  /^Plan review complete/i, // buildExecutionHandoffMessage (review-context.ts)
  /^Design review complete/i, // design-review handoff
  /^Feature review complete/i, // feature-review handoff
  /^Code review complete/i, // code-review handoff
  /^TODO #\d/i, // compaction TODO re-injection (compaction.ts)
  /^Continuing work on feature:/i, // kanban auto-agent (auto-agent-lifecycle.ts)
  /^▶ \d+:/, // pi-todo context reset follow-up (handlers.ts)
  /^\[Pending dialog/i, // compaction dialog restoration (compaction.ts)
  /^Run design review iteration/i, // design review loop follow-up (phase-ready.ts)
  /^Run plan review iteration/i, // plan review loop follow-up (phase-ready.ts)
  /^Context was compacted/i, // compaction restoration message (compact-message.ts)
  /^Context was reset between tasks/i, // plan-tracker task continuation (plan-tracker.ts)
  /^Work on feature:/i, // kanban auto-agent lifecycle (auto-agent-lifecycle.ts)
];

export function isExtensionMessage(text: string): boolean {
  const t = text.trim();
  return EXTENSION_MESSAGE_PATTERNS.some((p) => p.test(t));
}

// ── Content extraction helpers ──

/**
 * Extract only text content from an assistant entry (tool calls stripped).
 */
export function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: string[] = [];
  for (const c of content as Array<{ type?: string; text?: string }>) {
    if (c.type === "text" && c.text?.trim()) {
      parts.push(c.text.trim());
    }
  }
  return parts.join("\n");
}

/**
 * Extract text content from a message (handles string or array format).
 */
export function extractContent(content: string | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : (c as { text?: string }).text || "")).join("\n");
  }
  return "";
}

/**
 * Strip skill injection blocks and /skill: prefixes from content.
 * Handles both complete blocks (<skill>...</skill>) and unclosed blocks (<skill>...to end).
 */
export function stripSkillBlocks(content: string): string {
  // First try complete blocks with closing tag
  let stripped = content.replace(/<skill\s+name="[^"]*"[^>]*>[\s\S]*?<\/skill>/g, "");
  // Then handle unclosed blocks (skill tag to end of string)
  stripped = stripped.replace(/<skill\s+name="[^"]*"[^>]*>[\s\S]*/g, "");
  stripped = stripped.trim();
  stripped = stripped.replace(/^\s*\/skill:[^\s]*\s*/i, "").trim();
  return stripped;
}
