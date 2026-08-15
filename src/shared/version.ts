/**
 * This install's own version, and the one comparison that matters at runtime:
 * is the daemon on the socket running the same build we are?
 *
 * The daemon is long-lived and nothing about upgrading an npm package restarts
 * it, so `pines` and `pines server` routinely end up as two different builds
 * talking over one socket. PROTOCOL_VERSION does not catch that — it only
 * changes when the wire shapes do, which a bug fix inside the daemon never
 * does. The build version is the signal for "the code you installed is not the
 * code that is running".
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Sentinel for a package.json we could not read; never compares as stale. */
export const UNKNOWN_VERSION = "unknown";

let cached: string | undefined;

/** Version of the pines install this module was loaded from. */
export function pinesVersion(): string {
  if (cached === undefined) {
    try {
      // dist/shared/version.js → dist/../package.json (same hop under src/).
      cached = (require("../../package.json") as { version?: string }).version ?? UNKNOWN_VERSION;
    } catch {
      cached = UNKNOWN_VERSION;
    }
  }
  return cached;
}

/**
 * True when `daemonVersion` is not this build.
 *
 * `undefined` counts as stale: daemons predating this field never report one,
 * and those are exactly the builds a client needs to notice. When our own
 * version is unreadable we compare nothing — flagging every daemon stale on a
 * broken package.json would restart daemons for no reason.
 */
export function isStaleDaemon(daemonVersion: string | undefined, mine = pinesVersion()): boolean {
  if (mine === UNKNOWN_VERSION) return false;
  return daemonVersion !== mine;
}
