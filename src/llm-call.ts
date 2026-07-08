// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "./globals.js";
import {
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  agentLoop,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { appendDebug } from "./debug.js";
import { reportError } from "./error.js";
import { getPortraitSettings } from "./settings-ui.js";
import { withCoordinator } from "./snippets/vendored/subscribe-to-dialog-coordinator.js";

/**
 * Captured LLM model and registry (set via captureModel on session_start/turn_end/model_select).
 * Module-scoped: lost on /reload but recaptured on next session_start before first timer tick.
 */
let _model: Model<Api> | null = null;
let _modelRegistry: ModelRegistry | null = null;

/** Set captured model and registry — called from index. ts captureModel callback */
export function setCapturedModel(model: Model<Api>, modelRegistry: ModelRegistry): void {
  _model = model;
  _modelRegistry = modelRegistry;
}

interface CapturedModel {
  model: Model<Api>;
  modelRegistry: ModelRegistry;
}

function resolveModel(
  modelOverride: string | undefined,
): { model: CapturedModel["model"]; registry: CapturedModel["modelRegistry"] } | { error: string } {
  const settings = getPortraitSettings();
  if (!_modelRegistry) return { error: "No model registry available (model not captured yet from session)" };

  // If modelOverride provided or portraitModel configured, resolve it via registry
  const modelStr = modelOverride || settings.model;
  if (modelStr) {
    const slashIdx = modelStr.indexOf("/");
    if (slashIdx <= 0) {
      return { error: `Invalid portrait model format: '${modelStr}' — expected provider/model-id` };
    }
    const provider = modelStr.slice(0, slashIdx);
    const modelId = modelStr.slice(slashIdx + 1);
    const resolved = _modelRegistry.find(provider, modelId);
    if (resolved) return { model: resolved, registry: _modelRegistry };
    const available = _modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
    const modelHint =
      available.length > 0
        ? ` Available models: ${available.join(", ")}`
        : " No models registered — check the model setting (/portrait:settings) and enabledModels";
    return { error: `Portrait model '${modelStr}' not found in registry.${modelHint}` };
  }

  // Fall back to main model captured from session
  if (!_model) return { error: "No model captured — run a turn or select a model before using portrait" };
  return { model: _model, registry: _modelRegistry };
}

/** Sentinel returned when user chooses to pause profiling from the retry dialog */
export const PAUSED = Symbol("PAUSED");

/** Progress info emitted from the streaming LLM call to the module-level sink. */
export interface LlmProgressInfo {
  /** Output tokens reported by the provider during streaming (0 if unsupported). */
  tokens: number;
  /** Word count accumulated from streamed deltas (text + thinking + tool-call). */
  words: number;
}

/**
 * Module-level progress sink. Set by the orchestrator (maintenance/pipeline) so that
 * every callPortraitLlm invocation — building, extraction, post-extraction, maintenance
 * reports streaming progress without per-call param threading.
 */
let _progressSink: ((info: LlmProgressInfo) => void) | null = null;

/** Install/clear the module-level progress sink. Pass null to disable. */
export function setLlmProgressSink(sink: ((info: LlmProgressInfo) => void) | null): void {
  _progressSink = sink;
}

/** Sentinel for setLlmProgressSink — disable (clear) the installed progress sink. */
export const NO_LLM_PROGRESS_SINK: ((info: LlmProgressInfo) => void) | null = null;

/**
 * Structured event emitted from the streaming loop for debug dumps (progressive flush).
 * Unthrottled — every delta is delivered so the full streamed output is captured,
 * including partial output produced before an abort/retry.
 */
export type DebugStreamEvent =
  | { type: "attempt"; attempt: number }
  | { type: "delta"; kind: string; text: string }
  | { type: "end"; ok: boolean; error?: string };

let _debugStreamSink: ((event: DebugStreamEvent) => void) | null = null;

/** Install/clear a debug stream sink to capture streamed output (progressive flush). */
export function setDebugStreamSink(sink: ((event: DebugStreamEvent) => void) | null): void {
  _debugStreamSink = sink;
}

/** Sentinel for setDebugStreamSink — clear the installed debug stream sink. */
export const NO_DEBUG_STREAM_SINK: ((event: DebugStreamEvent) => void) | null = null;

/** Wrap a prompt into a single-user-message array for callPortraitLlm. */
export function buildSingleUserMessage(prompt: string): AgentMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    },
  ];
}

/** Build a debug stream sink that flushes each streamed event (attempt/delta/end) into the dump file at dumpPath.
 * Deltas are prefixed with [thinking] / [message] / [toolcall] for readability while preserving stream order.
 * Accepts null (dumps disabled) — appendDebug no-ops, so the sink is harmless if installed. */
export function makeDebugStreamDumpSink(dumpPath: string | null): (event: DebugStreamEvent) => void {
  return (event) => {
    if (event.type === "attempt") {
      appendDebug(dumpPath, `\n--- stream attempt ${event.attempt} ---\n`);
    } else if (event.type === "delta") {
      const tag =
        event.kind === "thinking_delta" ? "[thinking]" : event.kind === "text_delta" ? "[message]" : "[toolcall]";
      appendDebug(dumpPath, `${tag} ${event.text}`);
    } else {
      appendDebug(dumpPath, `\n--- stream ended (${event.ok ? "ok" : `error: ${event.error ?? "?"}`}) ---\n`);
    }
  };
}

/**
 * Shared LLM call helper with retry + user dialog.
 *
 * @param messages - Initial messages array (mutated on retry with error context)
 * @param systemPrompt - System prompt for the agent context
 * @param tool - Tool definition with execute callback that captures the result
 * @param resultExtractor - Function to extract the result from the tool callback's captured state
 * @param errorContext - Message text added on retry after failure
 * @param modelOverride - Optional model override (provider/model-id)
 * @param maxTokensOverride - Optional max-tokens override. Pass null to omit the cap
 *  entirely (the provider/model limit applies — used by maintenance). Undefined uses settings.maxTokens.
 * @returns The extracted result, or undefined on failure
 */
export async function callPortraitLlm<T>(
  messages: AgentMessage[],
  systemPrompt: string,
  tool: AgentTool,
  resultExtractor: () => T | undefined,
  errorContext: string,
  modelOverride: string | undefined,
  maxTokensOverride: number | null | undefined,
  timeoutOverride: number | null | undefined,
): Promise<T | typeof PAUSED | undefined> {
  const settings = getPortraitSettings();

  // Capture model
  const resolved = resolveModel(modelOverride);
  if ("error" in resolved) {
    reportError(resolved.error, "LLM error");
    return undefined;
  }
  const { model, registry } = resolved;

  // Resolve API key
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    reportError("No API key available", "LLM error");
    return undefined;
  }

  // Resolve timeout: null disables it entirely (maintenance generates a full-portrait
  // output that routinely exceeds the configured per-call timeout). Otherwise fall
  // back to settings.timeoutMs for normal calls.
  const timeoutMs = timeoutOverride === null ? null : settings.timeoutMs;

  // Build context
  const context: AgentContext = {
    systemPrompt,
    messages: [],
    tools: [tool],
  };

  // Build config — maxTokens omitted entirely when maxTokensOverride is null
  // (maintenance wants the model's own limit). Otherwise use the override, falling
  // back to settings.maxTokens for normal calls.
  const maxTokens = maxTokensOverride === undefined ? settings.maxTokens : maxTokensOverride;
  const config: AgentLoopConfig = {
    model,
    apiKey: auth.apiKey,
    headers: auth.headers,
    ...(maxTokens === null ? {} : { maxTokens }),
    reasoning: settings.thinkingLevel as ThinkingLevel,
    convertToLlm: (msgs: AgentMessage[]) => msgs as unknown as Message[],
    toolExecution: "sequential" as const,
  };

  // Execute with retry (Decision 24: configurable via settings.retries, default 3)
  const maxRetries = settings.retries;

  // Initial attempt with retries
  let { result, lastError } = await attemptWithRetries(
    messages,
    context,
    config,
    timeoutMs,
    maxRetries,
    resultExtractor,
    errorContext,
  );
  if (result !== undefined) return result;

  // After 3 failures: show user dialog (Decision 24)
  const state = globalThis.__piPortrait;
  if (state?.uiSelect) {
    const uiSelect = state.uiSelect;
    if (state?.uiNotify) state.uiNotify(`Portrait LLM failed: ${lastError ?? "unknown"}`, "error");
    while (true) {
      const choice = await withCoordinator(() =>
        uiSelect("Portrait LLM failed", ["Continue retrying", "Pause profiling to investigate"], {
          withAttention: true,
        }),
      );
      if (choice === "Pause profiling to investigate" || choice === undefined) {
        return PAUSED;
      }
      ({ result, lastError } = await attemptWithRetries(
        messages,
        context,
        config,
        timeoutMs,
        maxRetries,
        resultExtractor,
        errorContext,
      ));
      if (result !== undefined) return result;
      // Loop continues, re-offering dialog
    }
  }

  reportError(`LLM call failed after retries: ${lastError ?? "unknown"}`, "LLM error");
  return undefined;
}

/** Count words (whitespace-separated tokens) in a string. Exported for testing. */
export function countWords(s: string): number {
  const trimmed = s.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Exponential backoff delay (ms) after a failed attempt.
 * Sequence: 1s, 2s, 4s, 8s,... capped at 10s. Exported for testing.
 * @param attempt - 0-indexed attempt number that just failed.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 10_000);
}

/**
 * Attempt LLM call with up to maxRetries attempts.
 * Creates fresh AbortSignal per attempt.
 * Caps message array length to prevent unbounded growth.
 * Reports streaming progress (tokens from provider usage + words from deltas) to the
 * module-level sink, throttled to PROGRESS_THROTTLE_MS, with a final forced flush.
 * @returns { result } if extraction succeeded, or { lastError } with the final error message.
 */
export async function attemptWithRetries<T>(
  messages: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  timeoutMs: number | null,
  maxRetries: number,
  resultExtractor: () => T | undefined,
  errorContext: string,
): Promise<{ result?: T; lastError?: string }> {
  let lastError: string | undefined;
  const maxMessages = 20; // Cap to prevent unbounded growth
  const PROGRESS_THROTTLE_MS = 500;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Fresh signal per attempt (don't reuse AbortSignal across retries).
    // timeoutMs === null means no timeout — agentLoop's signal is optional, so we
    // pass undefined and the call runs to completion (used by maintenance).
    const signal = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
    _debugStreamSink?.({ type: "attempt", attempt: attempt + 1 });
    // Reset progress counters at the start of each attempt
    let tokensSoFar = 0;
    let wordsSoFar = 0;
    let lastProgressFire = 0;
    /** Do not force progress flush — use time-based throttle */
    const PROGRESS_NO_FORCE = false;
    const fireProgress = (force: boolean) => {
      if (!_progressSink) return;
      const now = Date.now();
      if (force || now - lastProgressFire >= PROGRESS_THROTTLE_MS) {
        lastProgressFire = now;
        _progressSink({ tokens: tokensSoFar, words: wordsSoFar });
      }
    };
    try {
      const stream = agentLoop(messages, context, config, signal);
      for await (const event of stream) {
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          // Word accumulation + provider-reported output tokens from text/thinking/tool-call deltas.
          // `partial.usage.output` gives a running token count when the provider streams usage.
          if (sub.type === "text_delta" || sub.type === "thinking_delta" || sub.type === "toolcall_delta") {
            if (typeof sub.delta === "string") {
              wordsSoFar += countWords(sub.delta);
              _debugStreamSink?.({ type: "delta", kind: sub.type, text: sub.delta });
            }
            const usage = sub.partial?.usage;
            if (usage && typeof usage.output === "number" && usage.output > tokensSoFar) {
              tokensSoFar = usage.output;
            }
          }
          fireProgress(PROGRESS_NO_FORCE);
        }
      }
      await stream.result();
      // Final flush so callers see the complete count
      fireProgress(true);

      const res = resultExtractor();
      if (res !== undefined) {
        _debugStreamSink?.({ type: "end", ok: true });
        return { result: res };
      }
      // Tool was never called — treat as an error (not an exception)
      lastError = "LLM did not call the required extraction tool";
      _debugStreamSink?.({ type: "end", ok: false, error: lastError });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      _debugStreamSink?.({ type: "end", ok: false, error: lastError });
    }

    // Prepare for the next attempt (applies to BOTH failure paths: thrown errors AND
    // "tool not called"). Without this, a tool-not-called failure would loop with no pause
    // and no nudge — exhausting every retry instantly and re-showing the dialog immediately
    // after the user picks "Continue retrying".
    if (attempt < maxRetries - 1) {
      // Cap messages to prevent unbounded growth
      if (messages.length > maxMessages) {
        messages.splice(0, messages.length - maxMessages);
      }
      messages.push({
        role: "user",
        content: [{ type: "text", text: `${errorContext}\nLast error: ${lastError}` }],
        timestamp: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
  return { lastError };
}
