// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { reportError } from "./error.js";
import { DROPPED_MD_HEADER, EVICTED_MD_HEADER } from "./storage.js";

// --- testability seam -------------------------------------------------------
// Every git invocation routes through this module-level slot. Default = real `execSync`.
// Tests swap it once (e.g. with a recorder/mock that returns canned output or records commit
// messages) to avoid spawning `git` subprocesses — mirroring avtc-pi-featyard's
// `setGitRunner`. Restore with `resetGitExec()`.
export type GitExec = (cmd: string, opts?: { cwd?: string; stdio?: unknown }) => string;

const defaultGitExec: GitExec = (cmd, opts) =>
  execSync(cmd, {
    ...(opts ?? {}),
    stdio: (opts?.stdio as "pipe" | "ignore" | "inherit") ?? "pipe",
  }) as unknown as string;

let gitExec: GitExec = defaultGitExec;

/** Test seam — replace how this module shells out to git. Restore with `resetGitExec()`. */
export function setGitExec(runner: GitExec): void {
  gitExec = runner;
}

/** Restore the real `execSync`-backed git runner. */
export function resetGitExec(): void {
  gitExec = defaultGitExec;
}

/**
 * Whether the `git` binary is available on PATH. Checked once and cached for the process
 * lifetime (git doesn't appear/disappear mid-process).
 *
 * Git is portrait's OPTIONAL audit layer: `portrait.md` is written/read via plain `fs`, so the
 * feature works without git. When git is absent, `initGit`/`commitPortrait`/`checkoutHead`
 * silently no-op (no error spam) rather than firing `reportError` on every call. When git IS
 * present but a specific operation fails (corrupt repo, permissions, hook rejection), the
 * existing per-call error reporting is preserved — a real failure of an available tool should
 * surface, whereas the absence of an optional dependency should not.
 */
let _gitAvailable: boolean | undefined;

function isGitAvailable(): boolean {
  if (_gitAvailable !== undefined) return _gitAvailable;
  try {
    execSync("git --version", { stdio: "pipe" });
    _gitAvailable = true;
  } catch {
    _gitAvailable = false;
  }
  return _gitAvailable;
}

export function initGit(portraitDir: string): void {
  // No git → silently skip the audit layer (portrait.md is written/read via fs regardless).
  if (!isGitAvailable()) return;
  const gitPath = path.join(portraitDir, ".git");
  if (!fs.existsSync(gitPath)) {
    try {
      gitExec("git init", { cwd: portraitDir, stdio: "pipe" });
      gitExec('git config user.email "portrait@local"', { cwd: portraitDir, stdio: "pipe" });
      gitExec('git config user.name "Portrait"', { cwd: portraitDir, stdio: "pipe" });
      // Create .gitignore
      fs.writeFileSync(
        path.join(portraitDir, ".gitignore"),
        ".portrait-lock\nprocessed-sessions.json\nportrait-state.json\ndebug/\n",
        "utf-8",
      );
      // Create evicted.md and dropped.md with headers so git add always succeeds
      fs.writeFileSync(path.join(portraitDir, "evicted.md"), EVICTED_MD_HEADER, "utf-8");
      fs.writeFileSync(path.join(portraitDir, "dropped.md"), DROPPED_MD_HEADER, "utf-8");
      gitExec("git add .gitignore evicted.md dropped.md", { cwd: portraitDir, stdio: "pipe" });
      gitExec('git commit -m "init: portrait git repo"', { cwd: portraitDir, stdio: "pipe" });
    } catch (err) {
      reportError(`Failed to initialize git repo: ${err}`, "git error");
    }
  }
}

export function commitPortrait(portraitDir: string, message: string): boolean {
  // No git → the audit layer is unavailable; the file was already written by writePortrait, so
  // treat this as a successful no-op (nothing to audit) rather than erroring every commit.
  if (!isGitAvailable()) return true;
  try {
    // Only stage files that exist — dropped.md may not exist in repos created before the feature was added
    const files = ["portrait.md", "evicted.md", "dropped.md"]
      .filter((f) => fs.existsSync(path.join(portraitDir, f)))
      .join(" ");
    gitExec(`git add ${files}`, { cwd: portraitDir, stdio: "pipe" });
    // Skip the commit if nothing is staged (no-op run). `git diff --cached --quiet`
    // exits 0 when there are no staged changes — treat that as success, not an error.
    try {
      gitExec("git diff --cached --quiet", { cwd: portraitDir, stdio: "pipe" });
      return true; // nothing staged — nothing to commit
    } catch {
      // exit 1 = staged changes exist — fall through to commit
    }
    // Shell-escape the message to prevent injection — escape all shell metacharacters
    const escaped = message.replace(/["'`$\\;!&|()<>{}[\]~*?\n\r]/g, "");
    gitExec(`git commit -m "${escaped}"`, { cwd: portraitDir, stdio: "pipe" });
    return true;
  } catch (err) {
    // Check if repo is corrupted
    try {
      gitExec("git status", { cwd: portraitDir, stdio: "pipe" });
    } catch {
      // Git repo corrupted — reinitialize
      reportError("Git repo corrupted, reinitializing", "git error");
      try {
        initGit(portraitDir);
      } catch {
        return false;
      }
    }
    // Git works but commit failed — report to user
    reportError(`Git commit failed: ${err instanceof Error ? err.message : String(err)}`, "git error");
    return false;
  }
}

export function checkoutHead(portraitDir: string, file: string): boolean {
  // No git → no HEAD to check out from. Returns false (no fallback available); callers already
  // handle a false return (readPortrait serves the on-disk content as-is).
  if (!isGitAvailable()) return false;
  try {
    // Validate file is a simple filename (no path traversal or shell injection)
    if (!/^[a-zA-Z0-9._-]+$/.test(file)) {
      reportError(`Invalid filename for checkout: ${file}`, "git error");
      return false;
    }
    gitExec(`git checkout HEAD -- ${file}`, { cwd: portraitDir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
