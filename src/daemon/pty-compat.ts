/**
 * node-pty 1.1.0's published macOS prebuild ships spawn-helper without any
 * execute bits. The native binding then fails every spawn with the opaque
 * "posix_spawnp failed" error. Repair the helper defensively at runtime so
 * installs still work when lifecycle scripts were disabled by the package
 * manager.
 */
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let checked = false;
const require = createRequire(import.meta.url);

/** Ensure one helper is executable. Returns true when its mode was changed. */
export function ensureExecutable(path: string): boolean {
  if (process.platform === "win32" || !existsSync(path)) return false;
  const mode = statSync(path).mode;
  try {
    accessSync(path, constants.X_OK);
    return false;
  } catch {
    // The current user cannot execute it. Add execute permission alongside
    // each existing read permission rather than replacing other mode bits.
  }
  chmodSync(path, mode | 0o111);
  accessSync(path, constants.X_OK);
  return true;
}

/** Repair the helper used by this installation of node-pty, once per process. */
export function ensureNodePtyReady(): void {
  if (checked || process.platform === "win32") return;

  const entry = require.resolve("node-pty");
  const root = join(dirname(entry), "..");
  const candidates = [
    join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ];
  const helper = candidates.find(existsSync);
  if (!helper) {
    checked = true;
    return; // Future node-pty versions may no longer use this helper.
  }

  try {
    ensureExecutable(helper);
    checked = true;
  } catch (err) {
    throw new Error(
      `node-pty helper is not executable (${helper}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
