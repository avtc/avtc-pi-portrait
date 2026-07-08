// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "./log.js";

const persistLog = log.child("persistence");

export const PORTRAIT_CACHE_TYPE = "portrait-cache";

/** Snapshot of the cached portrait, to propagate to forked subagent children. */
export interface PortraitCacheSnapshot {
  content: string;
}

/**
 * Persist the current cached portrait as a CustomEntry. No-op when undefined/empty.
 *
 * Failure model:
 *  - Programming error (`pi`/`pi.appendEntry` missing) → **throw** (fail loud; a live
 *  ExtensionAPI always exposes appendEntry). No `?.` guarding.
 *  - Environmental error (`appendEntry` call fails: disk full, permission, I/O) → caught,
 *  logged via `persistLog.warn`, and degraded (cache stays valid in memory).
 */
export function persistCacheSnapshot(pi: ExtensionAPI, cache: string | undefined): void {
  if (!cache) return;
  // Programming error — fail loud. Explicit check (no `?.`).
  if (pi === undefined || pi === null || typeof pi.appendEntry !== "function") {
    throw new Error("persistCacheSnapshot: pi.appendEntry unavailable (broken ExtensionAPI contract)");
  }
  try {
    pi.appendEntry(PORTRAIT_CACHE_TYPE, { content: cache } satisfies PortraitCacheSnapshot);
  } catch (err) {
    // Environmental (disk full, permission, I/O) — log and degrade; cache is still valid in memory.
    persistLog.warn(`Failed to persist portrait-cache snapshot: ${err}`);
  }
}

/**
 * Walk the session branch in reverse; return the latest `portrait-cache` snapshot, or undefined.
 *
 * Failure model:
 *  - Programming error (`ctx.sessionManager`/`getBranch` missing) → **throw** (fail loud; no `?.`).
 *  - Environmental error (`getBranch` throws on corrupt session / I/O, or malformed entry) →
 *  caught, logged, returns undefined → caller falls back to `readPortrait` (the file read).
 *
 * NOTE: do NOT add the avtc-pi-todo `PI_SUBAGENT_PARENT_PID` guard here — a forked subagent child
 * MUST restore the parent's snapshot (that is the entire point of this feature).
 */
export function restoreCacheSnapshot(ctx: ExtensionContext): PortraitCacheSnapshot | undefined {
  // Programming error — fail loud. Explicit check (no `?.`).
  if (
    ctx === undefined ||
    ctx === null ||
    ctx.sessionManager === undefined ||
    ctx.sessionManager === null ||
    typeof ctx.sessionManager.getBranch !== "function"
  ) {
    throw new Error("restoreCacheSnapshot: ctx.sessionManager.getBranch unavailable (broken contract)");
  }
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as { type: string; customType?: string; data?: unknown };
      if (entry.type === "custom" && entry.customType === PORTRAIT_CACHE_TYPE) {
        const content = (entry.data as PortraitCacheSnapshot | undefined)?.content;
        if (typeof content === "string" && content.length > 0) return { content };
        persistLog.warn("Found portrait-cache CustomEntry with missing/invalid content; falling back to file");
        return undefined;
      }
    }
    return undefined;
  } catch (err) {
    persistLog.warn(`Failed to restore portrait-cache snapshot: ${err}`);
    return undefined;
  }
}
