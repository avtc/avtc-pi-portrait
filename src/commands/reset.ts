// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "../globals.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPortraitDir } from "../config.js";
import { reportError } from "../error.js";
import { setCachedPipelineState } from "../footer.js";
import { commitPortrait } from "../git.js";
import { withCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import { loadPortraitState, savePortraitState, writeDropped, writeEvicted, writePortrait } from "../storage.js";
import { getErrorMessage } from "../utils.js";

export async function reset(): Promise<string> {
  const state = globalThis.__piPortrait;

  if (!state?.lockHeld) {
    return "👤 Portrait reset is not available in this session (locked by another).";
  }

  if (!state?.uiSelect) {
    return "👤 Portrait reset is not available in this session (no UI).";
  }
  const uiSelect = state.uiSelect;

  // Confirm via ui.select
  const confirmed = await withCoordinator(() =>
    uiSelect(
      "👤 Reset portrait? This will clear all rules and re-extract from session history on next collect. Git history preserved.",
      ["Yes, reset", "Cancel"],
    ),
  );

  if (confirmed !== "Yes, reset") {
    return "👤 Reset cancelled.";
  }

  const portraitDir = getPortraitDir();

  try {
    // Clear portrait.md to header only (atomic write)
    writePortrait(portraitDir, []);

    // Clear evicted.md (recreate with header so git add succeeds)
    writeEvicted(portraitDir, []);
    writeDropped(portraitDir, []);

    // Reset processed-sessions.json
    fs.writeFileSync(path.join(portraitDir, "processed-sessions.json"), "{}", "utf-8");

    // Reset trios counters in state
    const portraitState = loadPortraitState(portraitDir);
    portraitState.triosProcessed = 0;
    portraitState.totalKnownTrios = 0;
    portraitState.lastProcessedFile = null;
    portraitState.lastProcessedLine = 0;
    portraitState.lastPipelineRun = null;
    portraitState.lastScanTimestamp = null;
    portraitState.rulesInsertedSinceMaintenance = 0;
    portraitState.lastMaintenanceRun = null;
    savePortraitState(portraitDir, portraitState);
    setCachedPipelineState(portraitState);

    // Git commit (preserves history)
    await commitPortrait(portraitDir, "reset: cleared portrait for re-extraction");

    return "👤 Portrait reset. Run /portrait:collect to re-extract from session history. Previous rules preserved in git log.";
  } catch (error) {
    const msg = getErrorMessage(error);
    reportError(`Reset failed: ${msg}`, "reset error");
    return `👤 Reset failed: ${msg}`;
  }
}
