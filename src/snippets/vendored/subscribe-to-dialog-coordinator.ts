// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Dialog coordinator forwarding — drop-in integration with avtc-pi-ui-components DialogCoordinator.
 *
 * Copy this file into your extension's src/snippets/vendored/ directory, then:
 *   1. Call subscribeToDialogCoordinator(pi) in your extension entry point
 *   2. Call withCoordinator(fn) around any blocking ctx.ui.* call
 *
 * If avtc-pi-ui-components is not installed or the coordinator event never fires,
 * all functions pass through (no-op).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Shared VALUE, stored on globalThis so it survives jiti `moduleCache: false` re-imports
 * (which create distinct module instances and would otherwise split a module-level
 * `let` between the setter in subscribeToDialogCoordinator() and the getter in
 * withCoordinator()).
 *
 * `coordinator` is idempotent across subscribers — there is one DialogCoordinator,
 * so one object. Listener unsubs are NOT shared: each subscribeToDialogCoordinator()
 * call owns its own local closure unsubs.
 */
interface DialogCoordinatorForwardingState {
  coordinator: { enqueueOrShow<T>(fn: () => Promise<T>): Promise<T> } | null;
}
const STATE_KEY = "__piDialogCoordinatorForwarding";
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: DialogCoordinatorForwardingState };
function _state(): DialogCoordinatorForwardingState {
  const g = globalThis as GlobalWithState;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = { coordinator: null };
  }
  const state = g[STATE_KEY];
  return state;
}

/**
 * Reset module state — called during test cleanup.
 */
export function _resetState(): void {
  _state().coordinator = null;
}

/**
 * Subscribe to dialog-coordinator:ready event emitted by avtc-pi-ui-components.
 * Call once per extension entry point.
 *
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 */
export function subscribeToDialogCoordinator(pi: ExtensionAPI): void {
  if (!pi.events) return; // graceful no-op for incomplete test mocks

  const unsubs: Array<() => void> = [];

  // Listen for dialog-coordinator:ready (emitted by avtc-pi-ui-components in session_start)
  unsubs.push(
    pi.events.on("dialog-coordinator:ready", (data: unknown) => {
      const api = data as {
        coordinator?: { enqueueOrShow<T>(fn: () => Promise<T>): Promise<T> };
      };
      if (api?.coordinator && typeof api.coordinator.enqueueOrShow === "function") {
        _state().coordinator = api.coordinator;
      }
    }),
  );

  // Reset on session shutdown (fires before reload) — clean ONLY this subscriber's
  // EventBus listener (pi.on listeners are torn down by pi), then clear shared value
  // (hygiene; provider re-emits on next session_start).
  pi.on("session_shutdown", () => {
    for (const unsub of unsubs) {
      if (typeof unsub === "function") unsub();
    }
    unsubs.length = 0;
    _state().coordinator = null;
  });
}

/**
 * Wrap an async UI call with dialog coordination.
 * The call is serialized through the shared queue: if another dialog is currently
 * showing, this call waits and is shown only after the active dialog resolves.
 * If no coordinator is installed, the call is executed immediately (no-op).
 *
 * @param fn - Async function that blocks on user input (e.g. ctx.ui.select, ctx.ui.custom)
 * @returns A promise that resolves with whatever `fn` returns.
 */
export async function withCoordinator<T>(fn: () => Promise<T>): Promise<T> {
  const coordinator = _state().coordinator;
  if (coordinator) {
    return coordinator.enqueueOrShow(fn);
  }
  return fn();
}
