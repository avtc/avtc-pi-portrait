#!/usr/bin/env node
// prepublishOnly guard: blocks npm publish if avtc-pi-* deps are dev symlinks.
// Symlinked companions are NOT embedded by bundledDependencies (npm skips symlinks).
// Run `rm -rf node_modules && npm install --ignore-scripts` before publishing.
import fs from "node:fs";

if (!fs.existsSync("node_modules")) process.exit(0);

const entries = fs.readdirSync("node_modules").filter((e) => e.startsWith("avtc-pi-"));
const symlinks = entries.filter((e) => {
  try {
    return fs.lstatSync(`node_modules/${e}`).isSymbolicLink();
  } catch {
    return false;
  }
});

if (symlinks.length) {
  console.error("\nCannot publish: dev symlinks found in node_modules.");
  console.error("   Run: rm -rf node_modules && npm install --ignore-scripts");
  console.error("   Then: npm publish");
  console.error("   After: node scripts/link-dev.mjs\n");
  for (const s of symlinks) console.error(`   ${s}`);
  process.exit(1);
}
