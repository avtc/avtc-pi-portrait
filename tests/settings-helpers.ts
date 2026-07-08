// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Test helpers for portrait settings.
 *
 * Settings defaults live in {@link PORTRAIT_SCHEMA} (the single source of truth); tests must never
 * re-declare them. {@link defaultPortraitSettings} derives a complete settings object from the
 * schema so the SUT reads real, normalized defaults. {@link setupTestSettings} wires it into the
 * settings accessor via the mock-DI hook ({@link _setGetPortraitSettings}) and {@link teardownTestSettings}
 * restores the real handle.
 */

import { PORTRAIT_SCHEMA, type PortraitSettings } from "../src/schema.js";
import { _resetGetPortraitSettings, _setGetPortraitSettings } from "../src/settings-ui.js";

/**
 * Build a full portrait settings object from the schema defaults (overrides applied on top).
 * Derives from {@link PORTRAIT_SCHEMA} rather than re-declaring defaults.
 */
export function defaultPortraitSettings(overrides: Partial<PortraitSettings> | null): PortraitSettings {
  const fromSchema = Object.fromEntries(
    PORTRAIT_SCHEMA.settings.map((s) => [s.id, s.defaultValue]),
  ) as unknown as PortraitSettings;
  return overrides ? { ...fromSchema, ...overrides } : fromSchema;
}

/**
 * Wire the portrait settings accessor to return schema-derived defaults (plus overrides) for the
 * duration of a test. Pair with {@link teardownTestSettings} in `afterEach`.
 */
export function setupTestSettings(overrides: Partial<PortraitSettings> | null): PortraitSettings {
  const settings = defaultPortraitSettings(overrides);
  _setGetPortraitSettings(() => settings);
  return settings;
}

/** Restore the real settings handle (clear the test override). */
export function teardownTestSettings(): void {
  _resetGetPortraitSettings();
}
