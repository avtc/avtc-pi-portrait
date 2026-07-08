// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Shared utility functions for portrait profiling.
 */

/** Extract error message from unknown error */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
