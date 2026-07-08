// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Root portrait logger.
 *
 * Thin wrapper over the shared `avtc-pi-logger` library. The implementation (file backend,
 * rotation, retention, level formatting) lives in the library; this module only owns the
 * portrait singleton.
 *
 * Logs land at `~/.pi/logs/avtc-pi-portrait/<YYYY-MM-DD>.log` (date-partitioned, with size
 * roll-over + age-based retention — all handled by the library). Best-effort: a logging failure
 * never throws to the host.
 *
 * Scope: only fork-state propagation code uses this logger. Existing portrait code
 * (reportError / console.* paths) is deliberately NOT retrofitted.
 */

import { createLogger } from "avtc-pi-logger";

/** No custom logger options — use library defaults. */
const NO_LOGGER_OPTIONS: Parameters<typeof createLogger>[1] = null;

/** Root portrait logger — writes to ~/.pi/logs/avtc-pi-portrait/<date>.log (best-effort). */
export const log = createLogger("avtc-pi-portrait", NO_LOGGER_OPTIONS);
