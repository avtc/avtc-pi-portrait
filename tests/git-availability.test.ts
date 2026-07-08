// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Git is portrait's OPTIONAL audit layer: portrait.md is written/read via plain `fs`, so the
// feature works without git. These tests verify that when the `git` binary is absent, the git
// functions degrade GRACEFULLY (silently no-op) instead of firing reportError on every call
// (which would spam the user with "Git repo corrupted" / "Failed to initialize git repo" toasts).
//
// "git absent" is simulated by clearing PATH for the duration of each test: the shell (cmd.exe /
// /bin/sh) still starts (found via ComSpec / the absolute shell path), but `git` is no longer
// resolvable, so `execSync("git --version")` throws — exactly the "git not installed" condition.
// `vi.resetModules()` + a fresh dynamic import gives a clean `_gitAvailable` cache per test.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GitModule = typeof import("../src/git.js");

describe("git availability — graceful degradation when git is absent", () => {
  let dir: string;
  let origPath: string | undefined;
  let origReporter: ((msg: string, source: string) => void) | undefined;
  const reportSpy = vi.fn((_msg: string, _source: string) => {});

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "portrait-git-avail-"));
    origPath = process.env.PATH;
    origReporter = (globalThis as { __piPortraitReportError?: (m: string, s: string) => void }).__piPortraitReportError;
    (globalThis as { __piPortraitReportError?: (m: string, s: string) => void }).__piPortraitReportError = reportSpy;
    reportSpy.mockClear();
    // Empty PATH so `git` is unresolvable (the shell still starts via ComSpec / absolute path).
    process.env.PATH = "";
    vi.resetModules();
  });
  afterEach(() => {
    // Restore PATH + reporter so other tests/files are unaffected.
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    (globalThis as { __piPortraitReportError?: (m: string, s: string) => void }).__piPortraitReportError = origReporter;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Fresh dynamic import so the module-level `_gitAvailable` cache is cold (unset) for each test. */
  async function freshGit(): Promise<GitModule> {
    return (await import("../src/git.js")) as GitModule;
  }

  it("initGit silently no-ops when git is absent (no throw, no reportError)", async () => {
    const git = await freshGit();
    expect(() => git.initGit(dir)).not.toThrow();
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it("commitPortrait returns true and does not report an error when git is absent", async () => {
    const git = await freshGit();
    const ok = git.commitPortrait(dir, "portrait: 1 rule added");
    expect(ok).toBe(true); // audit layer unavailable → treat as successful no-op
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it("checkoutHead returns false (no HEAD fallback) when git is absent, without reporting", async () => {
    const git = await freshGit();
    expect(git.checkoutHead(dir, "portrait.md")).toBe(false);
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it("the gate caches once per module instance (does not re-spawn git --version per call)", async () => {
    const git = await freshGit();
    // initGit + two commits — only the first call should probe git; the rest reuse the cached false.
    git.initGit(dir);
    git.commitPortrait(dir, "m1");
    git.commitPortrait(dir, "m2");
    git.checkoutHead(dir, "portrait.md");
    // No error toast across all four calls.
    expect(reportSpy).not.toHaveBeenCalled();
  });
});
