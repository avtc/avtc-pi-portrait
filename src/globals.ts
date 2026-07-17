// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Typed globalThis extensions for pi-portrait.
 *
 * Several cross-module functions are stashed on globalThis to avoid circular imports
 * (e.g. resume.ts → index.ts would loop). The state object `__piPortrait` also survives
 * `/reload`. These declarations make every access type-safe instead of `globalThis as any`.
 */

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { PortraitPipelineState, PortraitState } from "./types.js";

/** Options passed to the captured `ui.select` helper (mirrors ctx.ui.select options used by portrait). */
export interface PortraitUiSelectOptions {
  withAttention?: boolean;
}

/** Signature of the captured `ui.select` (bound to ctx.ui) stored on PortraitState. */
export type PortraitUiSelect = (
  title: string,
  options: string[],
  opts?: PortraitUiSelectOptions,
) => Promise<string | undefined>;

/** Signature of the captured `ui.notify` (bound to ctx.ui) stored on PortraitState. */
export type PortraitUiNotify = (message: string, type?: "info" | "warning" | "error") => void;

/** Captured LLM model + registry (set from session_start / turn_end / model_select events). */
export interface CapturedModel {
  model: Model<Api>;
  registry: ModelRegistry;
}

/**
 * Minimal structural shape of the pi session context that portrait consumes.
 *
 * This mirrors {@link ExtensionContext} but is declared locally so portrait's internal
 * types do not depend on importing the full SDK context structurally across packages.
 */
export interface PortraitSessionContext {
  ui: ExtensionContext["ui"];
  hasUI: boolean;
  cwd: string;
  model: Model<Api> | undefined;
  modelRegistry: ModelRegistry | undefined;
}

/** Functions stashed on globalThis during init to avoid circular imports with index.ts. */
export interface PortraitGlobalFunctions {
  __piPortraitStartProfilingTimer?: () => void;
  __piPortraitRunProfilingCycle?: () => Promise<void>;
  __piPortraitReportError?: (errorMsg: string, source: string) => void;
  __piPortraitAcquireCollectLock?: () => Promise<boolean>;
  __piPortraitReleaseCollectLock?: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __piPortrait: PortraitState | undefined;
  var __piPortraitPipelineState: PortraitPipelineState | undefined;
  var __piPortraitStartProfilingTimer: (() => void) | undefined;
  var __piPortraitRunProfilingCycle: (() => Promise<void>) | undefined;
  var __piPortraitReportError: ((errorMsg: string, source: string) => void) | undefined;
  var __piPortraitAcquireCollectLock: (() => Promise<boolean>) | undefined;
  var __piPortraitReleaseCollectLock: (() => void) | undefined;
}
