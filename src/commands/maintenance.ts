// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "../globals.js";
import { reportError } from "../error.js";
import { runMaintenance } from "../maintenance-core.js";
import { getErrorMessage } from "../utils.js";

export async function maintenance(shouldCancel: (() => boolean) | undefined): Promise<string> {
  const state = globalThis.__piPortrait;
  const acquireCollectLock = globalThis.__piPortraitAcquireCollectLock;
  const releaseCollectLock = globalThis.__piPortraitReleaseCollectLock;

  if (!state || !acquireCollectLock || !releaseCollectLock) {
    return "👤 Portrait maintenance is not available in this session.";
  }

  if (!(await acquireCollectLock())) {
    return "👤 Collection already in progress.";
  }

  state.collectCancelled = false;

  try {
    return await runMaintenance(shouldCancel);
  } catch (error) {
    const msg = getErrorMessage(error);
    reportError(`Maintenance failed: ${msg}`, "maintenance error");
    return `👤 Maintenance failed: ${msg}`;
  } finally {
    releaseCollectLock();
    state.collectCancelled = false;
  }
}
