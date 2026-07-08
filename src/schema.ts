// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Portrait settings schema (20 settings), rendered via the `/portrait:settings` command
 * (avtc-pi-settings-ui). Settings live in `~/.pi/agent/avtc-pi-portrait-settings.json` (global-only).
 *
 * Duration settings store milliseconds as plain numbers (settings-ui convention); they are named
 * with an `Ms` suffix. Off-able durations use a `null` preset (null = unbounded/off).
 */

import { type SettingsSchema, settingsFilePaths } from "avtc-pi-settings-ui";

/** The portrait settings (shape declared here; defaults live in {@link PORTRAIT_SCHEMA}). */
export interface PortraitSettings {
  enabled: boolean;
  intervalMs: number | null; // recurring interval between background collections (null = manual-only)
  startupDelayMs: number; // one-time delay after app start before the first collection
  ruleLimit: number;
  model: string | null; // "provider/id" | null (null = session model)
  thinkingLevel: string;
  maxTokens: number;
  timeoutMs: number | null; // extraction/building LLM call timeout (null = no limit)
  retries: number;
  buildingBatchSize: number;
  maxAgeDays: number;
  debugDumpLimit: number;
  postExtractionEnabled: boolean;
  postExtractionModel: string | null;
  rateLimitMs: number; // minimum spacing between LLM calls
  maintenanceModel: string | null;
  maintenanceEveryNRulesInserted: number;
  maintenanceBackfillBatchSize: number;
  maintenanceMaxTokens: number;
  maintenanceTimeoutMs: number | null; // maintenance run timeout (null = off / no maintenance deadline)
}

/** Env var used by settings-ui for serialization + reload survival. */
export const PORTRAIT_SETTINGS_ENV_VAR = "PI_SETTINGS_PORTRAIT";

export const PORTRAIT_SCHEMA: SettingsSchema = {
  settings: [
    // ── General tab ──────────────────────────────────────────────────────────
    {
      id: "enabled",
      label: "Enabled",
      description: "Master switch for the portrait extension (background collection + injection).",
      type: "boolean",
      defaultValue: true,
    },
    {
      id: "intervalMs",
      label: "Collection interval",
      description:
        "How often the background collector runs (scans sessions, extracts/builds the portrait). Off = manual-only (collect via /portrait:collect). Lower = fresher portrait, more LLM cost.",
      type: "duration",
      defaultValue: null, // off by default — manual-only
      min: 1000, // 1s minimum — the collect lock prevents overlapping work regardless
      presets: ["1m", "5m", "10m", "30m", ["Off", null]],
    },
    {
      id: "startupDelayMs",
      label: "Startup delay",
      description: "One-time delay after the app starts before the first background collection.",
      type: "duration",
      defaultValue: 2000, // 2s
      min: 0,
      presets: ["0s", "2s", "10s", "30s"],
    },
    {
      id: "ruleLimit",
      label: "Rule limit",
      description: "Maximum number of portrait rules kept (highest-value first).",
      type: "number",
      defaultValue: 200,
      min: 1,
      presets: [50, 100, 200, 500],
    },
    {
      id: "maxAgeDays",
      label: "Max age (days)",
      description: "Portrait rules older than this are pruned during maintenance.",
      type: "number",
      defaultValue: 30,
      min: 1,
      presets: [7, 14, 30, 90],
    },

    // ── Building tab ─────────────────────────────────────────────────────────
    {
      id: "model",
      label: "Extraction/building model",
      description: "Model used for extraction + building LLM calls. Default = the session model.",
      type: "model",
      defaultValue: null,
    },
    {
      id: "thinkingLevel",
      label: "Thinking level",
      description: "Reasoning depth for extraction/building LLM calls.",
      type: "thinking-level",
      defaultValue: "high",
    },
    {
      id: "maxTokens",
      label: "Max tokens",
      description: "Maximum output tokens per extraction/building LLM call.",
      type: "number",
      defaultValue: 8192,
      min: 1,
      presets: [2048, 4096, 8192, 16384],
    },
    {
      id: "timeoutMs",
      label: "Call timeout",
      description: "Aborts an extraction/building LLM call if it runs longer than this. Infinite = no limit.",
      type: "duration",
      defaultValue: 180_000, // 3m
      min: 1,
      presets: ["1m", "3m", "10m", ["Infinite", null]],
    },
    {
      id: "retries",
      label: "Retries",
      description:
        "How many times to retry a failed extraction/building LLM call before giving up (0 = one attempt, no retries).",
      type: "number",
      defaultValue: 3,
      min: 0,
      presets: [0, 1, 3, 5],
    },
    {
      id: "buildingBatchSize",
      label: "Building batch size",
      description: "How many extraction trios to process per building LLM call.",
      type: "number",
      defaultValue: 1,
      min: 1,
      presets: [1, 3, 5, 10],
    },
    {
      id: "rateLimitMs",
      label: "Rate limit",
      description: "Minimum spacing between LLM calls (prevents rate-limit / cost spikes).",
      type: "duration",
      defaultValue: 5000, // 5s
      min: 0,
      presets: ["0s", "1s", "5s", "30s"],
    },
    {
      id: "debugDumpLimit",
      label: "Debug dump limit",
      description: "Maximum debug dump files kept under <cwd>/.pi/portrait/debug/ (0 = no dumps).",
      type: "number",
      defaultValue: 0,
      min: 0,
      presets: [0, 10, 50, 200],
    },
    {
      id: "postExtractionEnabled",
      label: "Post-extraction enabled",
      description: "Review and refine extracted rules (keep, rewrite, or drop) before they enter the portrait.",
      type: "boolean",
      defaultValue: false,
    },
    {
      id: "postExtractionModel",
      label: "Post-extraction model",
      description: "Model for the post-extraction pass. Default = the session model.",
      type: "model",
      defaultValue: null,
    },

    // ── Maintenance tab ──────────────────────────────────────────────────────
    {
      id: "maintenanceModel",
      label: "Maintenance model",
      description: "Model used for maintenance (pruning, merging, re-ranking). Default = the session model.",
      type: "model",
      defaultValue: null,
    },
    {
      id: "maintenanceEveryNRulesInserted",
      label: "Maintenance frequency",
      description: "Run maintenance after every N rules inserted (0 = maintenance runs never).",
      type: "number",
      defaultValue: 200,
      min: 0,
      presets: [0, 50, 200, 500],
    },
    {
      id: "maintenanceBackfillBatchSize",
      label: "Maintenance backfill batch size",
      description: "How many rules to re-evaluate per maintenance backfill LLM call.",
      type: "number",
      defaultValue: 20,
      min: 1,
      presets: [1, 3, 5, 10, 20],
    },
    {
      id: "maintenanceMaxTokens",
      label: "Maintenance max tokens",
      description: "Maximum output tokens per maintenance LLM call (0 = provider default).",
      type: "number",
      defaultValue: 0,
      min: 0,
      presets: [0, 2048, 8192, 16384],
    },
    {
      id: "maintenanceTimeoutMs",
      label: "Maintenance timeout",
      description:
        "Aborts a maintenance run if it runs longer than this. Off = no deadline (maintenance runs to completion).",
      type: "duration",
      defaultValue: 3_600_000, // 1h
      min: 1,
      presets: ["10m", "30m", "1h", ["Off", null]],
    },
  ],
  tabs: [
    {
      label: "General",
      settingIds: ["enabled", "intervalMs", "startupDelayMs", "ruleLimit", "maxAgeDays"],
    },
    {
      label: "Building",
      settingIds: [
        "model",
        "thinkingLevel",
        "maxTokens",
        "timeoutMs",
        "retries",
        "buildingBatchSize",
        "rateLimitMs",
        "debugDumpLimit",
        "postExtractionEnabled",
        "postExtractionModel",
      ],
    },
    {
      label: "Maintenance",
      settingIds: [
        "maintenanceModel",
        "maintenanceEveryNRulesInserted",
        "maintenanceBackfillBatchSize",
        "maintenanceMaxTokens",
        "maintenanceTimeoutMs",
      ],
    },
  ],
  ...settingsFilePaths("avtc-pi-portrait"),
};
