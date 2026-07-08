// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The single, canonical portrait settings handle.
 *
 * Registered once here (rather than in `index.ts`) so every module reads settings through the same
 * accessor. {@link initPortraitSettings} is called from the extension's activate function (where
 * `pi` is available); until then the handle is `undefined`, which is fine because all reads happen
 * at runtime (after activate). Callers read {@link getPortraitSettings}; no consumer re-parses or
 * re-normalizes the env var.
 *
 * Storage is global-only (`~/.pi/agent/avtc-pi-portrait-settings.json`): portrait settings are operator
 * preferences, not per-project. In single-file (stateless) mode settings read fresh from disk on
 * every getSettings() call, so changes made by another instance (or by hand) propagate immediately.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCommand, type SettingsHandle } from "avtc-pi-settings-ui";
import { PORTRAIT_SCHEMA, PORTRAIT_SETTINGS_ENV_VAR, type PortraitSettings } from "./schema.js";

let handle: SettingsHandle<PortraitSettings> | undefined;

/**
 * Test-only override for the settings read (DI/mock pattern): when set, {@link getPortraitSettings}
 * returns this instead of the real handle. Set up in tests before the SUT runs; cleared by
 * {@link _resetGetPortraitSettings}.
 */
let _getSettingsOverride: (() => PortraitSettings) | null = null;

/** Test-only: inject a mock settings source (pass `null` to restore the real handle). */
export function _setGetPortraitSettings(fn: (() => PortraitSettings) | null): void {
  _getSettingsOverride = fn;
}

/** Test-only: clear the mock override (restore real-handle reads). */
export function _resetGetPortraitSettings(): void {
  _getSettingsOverride = null;
}

/**
 * Register the /portrait:settings command + modal and create the settings handle. Must be called
 * from the extension's activate function (needs `pi`). Global-only: reads fresh from the global
 * file on every read (no in-memory buffer), and loads at registration + every session_start.
 */
export function initPortraitSettings(pi: ExtensionAPI): void {
  handle = registerSettingsCommand<PortraitSettings>(pi, PORTRAIT_SCHEMA, {
    commandName: "portrait:settings",
    title: "Portrait Settings",
    titleRight: "avtc-pi-portrait",
    storageLevels: ["global"],
    envVar: PORTRAIT_SETTINGS_ENV_VAR,
  });
}

/** Read the current portrait settings (normalized by the schema; fresh from disk in global mode). */
export function getPortraitSettings(): PortraitSettings {
  if (_getSettingsOverride) return _getSettingsOverride();
  if (!handle) throw new Error("portrait settings not initialized — initPortraitSettings not called");
  return handle.getSettings();
}
