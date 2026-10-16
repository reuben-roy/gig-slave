#!/usr/bin/env node
// Tiny bootstrap: check the Node version BEFORE loading anything that needs Node 22+.
// Keep this file to old-fashioned syntax and no static imports.
var REQUIRED_MAJOR = 22;

export function nodeTooOld(version: string): boolean {
  var major = parseInt(String(version).split(".")[0], 10);
  return !(major >= REQUIRED_MAJOR);
}

var current = process.versions.node;

// macOS-only is checked here rather than with package.json "os", which also blocked
// installing the monorepo on Vercel's Linux build machines.
if (process.platform !== "darwin") {
  console.error("");
  console.error("Hired Gun currently works on Macs only. Please run this command on a Mac.");
  console.error("");
  process.exit(1);
} else if (nodeTooOld(current)) {
  console.error("");
  console.error("Hired Gun needs a newer version of Node.js (" + REQUIRED_MAJOR + " or later). You have " + current + ".");
  console.error("");
  console.error("How to fix it:");
  console.error("  1. Go to https://nodejs.org and click the green LTS button to download the macOS installer.");
  console.error("  2. Open the downloaded file and click through the installer.");
  console.error("  3. Close this window, open a new Terminal window, and run the same command again.");
  console.error("");
  process.exit(1);
} else {
  import("./index.js").catch(function (err: unknown) {
    console.error("Something went wrong: " + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
