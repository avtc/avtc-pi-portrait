// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Report a portrait profiling error to the user via ui.notify and state file.
 * Delegates to the globalThis-registered function set during extension init.
 */
import "./globals.js";
export function reportError(errorMsg: string, source: string): void {
  const reporter = globalThis.__piPortraitReportError;
  if (typeof reporter === "function") {
    reporter(errorMsg, source);
  }
  // Fallback: if reporter not registered yet, errors are silently dropped
  // This can happen during early init before session_start fires
}
