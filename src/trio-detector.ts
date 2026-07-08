// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  extractAssistantText,
  extractContent,
  isApproval,
  isContinuation,
  isExtensionMessage,
  stripSkillBlocks,
} from "./filtering.js";

/** Raw parsed session entry. */
export interface SessionEntry {
  type: string;
  message?: AgentMessage;
}

/**
 * Stateful trio detector that processes session entries incrementally.
 * Shared between countPendingTrios (bg scan) and streamAndExtract (extraction).
 *
 * Emits a trio whenever it sees: assistant → user → assistant
 * where the user message is not a continuation, approval, or extension-generated message.
 */
export class TrioDetector {
  private lastAssistant: string | null = null;
  private lastUser: string | null = null;

  /**
   * Process a single session entry. Returns the completed trio if one was found,
   * or null otherwise. After a trio is emitted, lastUser is cleared so each
   * user message completes at most one trio.
   */
  process(entry: SessionEntry): { agentBefore: string; userFeedback: string; agentAfter: string } | null {
    if (entry.type !== "message" || !entry.message) return null;

    const msg = entry.message;

    if (msg.role === "assistant") {
      const text = extractAssistantText(msg.content);
      if (text) {
        if (
          this.lastAssistant &&
          this.lastUser &&
          !isContinuation(this.lastUser) &&
          !isApproval(this.lastUser) &&
          !isExtensionMessage(this.lastUser)
        ) {
          // Complete trio found
          const agentBefore = this.lastAssistant;
          const userFeedback = this.lastUser;
          const agentAfter = text;
          // Clear to match extraction logic: one user message = one trio
          this.lastUser = null;
          this.lastAssistant = text;
          return { agentBefore, userFeedback, agentAfter };
        }
        this.lastAssistant = text;
      }
    } else if (msg.role === "user" || (msg.role === "toolResult" && msg.toolName === "ask_user_question")) {
      let content = extractContent(msg.content);
      content = stripSkillBlocks(content);
      if (content && !isContinuation(content) && !isExtensionMessage(content)) {
        this.lastUser = content;
      }
    }

    return null;
  }

  /**
   * Reset detector state. Available for reuse scenarios (e.g. clearing state
   * between sessions when reusing one instance across multiple files).
   * Currently callers create a fresh instance per file, but reset() is kept
   * to support future optimization without changing call sites.
   */
  reset(): void {
    this.lastAssistant = null;
    this.lastUser = null;
  }
}
