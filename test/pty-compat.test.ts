import { afterEach, describe, expect, it } from "vitest";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExecutable } from "../src/daemon/pty-compat.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("node-pty compatibility", () => {
  it("repairs a packaged spawn-helper with no execute bits", () => {
    dir = mkdtempSync(join(tmpdir(), "pines-pty-"));
    const helper = join(dir, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\nexit 0\n");
    chmodSync(helper, 0o644);

    if (process.platform === "win32") {
      expect(ensureExecutable(helper)).toBe(false);
      return;
    }

    expect(ensureExecutable(helper)).toBe(true);
    expect(statSync(helper).mode & 0o111).not.toBe(0);
    expect(() => accessSync(helper, constants.X_OK)).not.toThrow();
    expect(ensureExecutable(helper)).toBe(false);
  });
});
