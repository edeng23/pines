#!/usr/bin/env node
/**
 * Install-time counterpart to src/daemon/pty-compat.ts. Runtime performs the
 * same repair because package managers may disable lifecycle scripts.
 */
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Never fail the install: this is an optimisation, not a requirement. node-pty
// may not be resolvable yet (install ordering), the tree may be read-only, or
// the platform may not ship a helper at all. pty-compat.ts repairs it at
// runtime regardless, so a failure here costs nothing.
if (process.platform !== "win32") {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("node-pty");
    const root = join(dirname(entry), "..");
    const candidates = [
      join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      join(root, "build", "Release", "spawn-helper"),
    ];
    const helper = candidates.find(existsSync);
    if (helper) {
      const mode = statSync(helper).mode;
      if ((mode & 0o111) === 0) {
        chmodSync(helper, mode | 0o111);
        process.stdout.write(`pines: repaired node-pty helper permissions (${helper})\n`);
      }
    }
  } catch {
    // Deliberately silent — runtime handles it.
  }
}
