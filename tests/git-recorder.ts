// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { GitExec } from "../src/git.js";

// Recording git runner for the test layer — an injectable git seam for src/git.js.
// Installed via `setGitExec(runner)`, it captures `git commit -m "…"` messages and the committed
// portrait.md content (mirroring `git show HEAD:portrait.md`), keyed by cwd. All other git commands
// are no-ops.
//
// To stay faithful to production `commitPortrait`, `git diff --cached --quiet` simulates git's
// "are there staged changes?" check: it throws (exit 1, → commit proceeds) only when the staged
// portrait.md differs from the last committed one, and returns success (exit 0, → commit skipped)
// otherwise. This way commitPortrait records exactly the commits real git would.
const commitsByDir = new Map<string, string[]>();
const headPortraitByDir = new Map<string, string>();

export interface RecordingGit {
  runner: GitExec;
  getLatestCommit(dir: string): string;
  getCommitLog(dir: string): string;
  getHeadPortrait(dir: string): string;
  resetDir(dir: string): void;
}

export function installRecordingGit(): RecordingGit {
  const readPortrait = (cwd: string): string =>
    fs.existsSync(path.join(cwd, "portrait.md")) ? fs.readFileSync(path.join(cwd, "portrait.md"), "utf-8") : "";

  const runner: GitExec = (cmd, opts) => {
    const cwd = opts?.cwd ?? process.cwd();
    if (cmd.includes("git add")) {
      // Track what is staged (portrait.md is what the diff/commit cares about).
      headPortraitByDir.set(`${cwd}::staged`, readPortrait(cwd));
      return "";
    }
    if (cmd.includes("diff --cached --quiet")) {
      const staged = headPortraitByDir.get(`${cwd}::staged`) ?? "";
      const head = headPortraitByDir.get(cwd) ?? "";
      if (staged !== head) {
        // Staged changes exist → commitPortrait falls through to its commit call.
        throw new Error("mock git: staged changes present");
      }
      // No staged changes → commitPortrait skips (no commit recorded).
      return "";
    }
    if (cmd.includes("commit -m")) {
      const staged = headPortraitByDir.get(`${cwd}::staged`) ?? readPortrait(cwd);
      const m = cmd.match(/commit -m\s+"([\s\S]*?)"/);
      if (m) {
        const list = commitsByDir.get(cwd) ?? [];
        list.push(m[1]);
        commitsByDir.set(cwd, list);
        // The committed portrait.md content is what was staged.
        headPortraitByDir.set(cwd, staged);
      }
    }
    // init / config / checkout / status / etc. → no-op
    return "";
  };
  return {
    runner,
    getLatestCommit: (dir) => {
      const list = commitsByDir.get(dir) ?? [];
      return list.length > 0 ? list[list.length - 1] : "";
    },
    // Mirror `git log` order: newest first.
    getCommitLog: (dir) => (commitsByDir.get(dir) ?? []).slice().reverse().join("\n"),
    getHeadPortrait: (dir) => headPortraitByDir.get(dir) ?? "",
    resetDir: (dir) => {
      commitsByDir.delete(dir);
      headPortraitByDir.delete(dir);
      headPortraitByDir.delete(`${dir}::staged`);
    },
  };
}
