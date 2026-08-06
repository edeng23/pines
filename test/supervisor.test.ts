import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { bundledPiEntryPath, piVersion, Supervisor } from "../src/daemon/supervisor.js";

describe("supervisor spawn transactions", () => {
  it("locates the version-matched pi bundled with pines", () => {
    expect(bundledPiEntryPath()).toMatch(/pi-coding-agent[/\\]dist[/\\]cli\.js$/);
    expect(existsSync(bundledPiEntryPath())).toBe(true);
  });

  it("does not retain a ghost tree when PTY creation fails", async () => {
    const supervisor = new Supervisor(() => {
      throw new Error("simulated PTY creation failure");
    });
    try {
      expect(() => supervisor.spawnAgent({ cwd: process.cwd() })).toThrow();
      expect(supervisor.trees.size).toBe(0);
    } finally {
      await supervisor.shutdown();
    }
  });
});

describe("piVersion", () => {
  it("reports the bundled pi's manifest version when no override is set", async () => {
    const savedEnv = process.env.PINES_PI_BIN;
    delete process.env.PINES_PI_BIN;
    try {
      const v = await piVersion();
      expect(v).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      if (savedEnv !== undefined) process.env.PINES_PI_BIN = savedEnv;
    }
  });

  it("reports 'custom' for an override that will not answer --version", async () => {
    // fake-pi ignores argv, prints its banner, and never exits — the probe
    // must give up on it rather than borrow the bundled version.
    process.env.PINES_PI_BIN = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;
    try {
      const v = await piVersion();
      expect(v).toBe("custom");
    } finally {
      delete process.env.PINES_PI_BIN;
    }
  });
});
