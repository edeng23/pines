import { describe, expect, it } from "vitest";
import { endingFrames, growthFrames } from "../src/client/boot.js";

const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");

describe("boot splash frames", () => {
  it("grows to the full wordmark and tagline", () => {
    const frames = growthFrames(100, 28);
    expect(frames.length).toBeGreaterThan(15);
    const last = frames[frames.length - 1]!.lines.map(plain).join("\n");
    expect(last).toContain("█▀▄ ▀█▀"); // wordmark
    expect(last).toContain("your conversations are trees");
    for (const f of frames) {
      expect(f.lines).toHaveLength(28);
      for (const l of f.lines) expect(plain(l).length).toBeLessThanOrEqual(100);
    }
  });

  it("counts the agents that never slept — honestly at 0 and 1", () => {
    const two = endingFrames(100, 28, 2).at(-1)!.lines.map(plain).join("\n");
    expect(two).toContain("2 agents never slept");
    const one = endingFrames(100, 28, 1).at(-1)!.lines.map(plain).join("\n");
    expect(one).toContain("1 agent never slept");
    const zero = endingFrames(100, 28, 0).at(-1)!.lines.map(plain).join("\n");
    expect(zero).not.toContain("never slept");
  });
});
