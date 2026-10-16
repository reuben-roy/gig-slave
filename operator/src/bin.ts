#!/usr/bin/env node
// Bootstrap: check the Node version before loading anything that needs Node 22+. Old-fashioned syntax on purpose.
var major = parseInt(String(process.versions.node).split(".")[0], 10);
if (!(major >= 22)) {
  console.error("This tool needs Node.js 22 or later. You have " + process.versions.node + ".");
  process.exit(1);
} else {
  import("./cli.js")
    .then(function (m) {
      return m.runCli(process.argv.slice(2), m.defaultIO());
    })
    .then(function (code: number) {
      process.exitCode = code;
    })
    .catch(function (err: unknown) {
      console.error("Something went wrong: " + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    });
}
