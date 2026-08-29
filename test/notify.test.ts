import { describe, expect, it } from "vitest";
import {
  buildToastSeq,
  detectOscBackend,
  sanitizeOscText,
  shouldNotify,
  wrapTmuxPassthrough,
} from "../src/client/notify.js";

describe("detectOscBackend", () => {
  it("recognizes kitty via KITTY_WINDOW_ID or TERM", () => {
    expect(detectOscBackend({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
    expect(detectOscBackend({ TERM: "xterm-kitty" })).toBe("kitty");
  });

  it("recognizes OSC 9 terminals via TERM_PROGRAM or TERM", () => {
    expect(detectOscBackend({ TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
    expect(detectOscBackend({ TERM_PROGRAM: "WezTerm" })).toBe("osc9");
    expect(detectOscBackend({ TERM_PROGRAM: "ghostty" })).toBe("osc9");
    expect(detectOscBackend({ TERM_PROGRAM: "WarpTerminal" })).toBe("osc9");
    expect(detectOscBackend({ TERM: "foot" })).toBe("osc9");
  });

  it("returns none for unknown terminals", () => {
    expect(detectOscBackend({})).toBe("none");
    expect(detectOscBackend({ TERM: "xterm-256color" })).toBe("none");
    expect(detectOscBackend({ TERM_PROGRAM: "Apple_Terminal" })).toBe("none");
  });
});

describe("sanitizeOscText", () => {
  it("strips control characters that could terminate the sequence", () => {
    expect(sanitizeOscText("a\x1b]9;evil\x07b\x9cc")).toBe("a ]9;evil b c");
  });

  it("keeps ordinary text, dashes, and unicode", () => {
    expect(sanitizeOscText("fix-auth · done ✓")).toBe("fix-auth · done ✓");
  });
});

describe("wrapTmuxPassthrough", () => {
  it("wraps in DCS tmux; with every ESC doubled", () => {
    expect(wrapTmuxPassthrough("\x1b]9;hi\x1b\\")).toBe(
      "\x1bPtmux;\x1b\x1b]9;hi\x1b\x1b\\\x1b\\",
    );
  });
});

describe("buildToastSeq", () => {
  it("emits OSC 9 with title folded into the body line", () => {
    expect(buildToastSeq("pines", "auth finished", { TERM_PROGRAM: "iTerm.app" })).toBe(
      "\x1b]9;pines: auth finished\x1b\\",
    );
  });

  it("emits two-part OSC 99 for kitty", () => {
    expect(buildToastSeq("pines", "auth finished", { KITTY_WINDOW_ID: "1" })).toBe(
      "\x1b]99;i=1:d=0;pines\x1b\\\x1b]99;i=1:p=body;auth finished\x1b\\",
    );
  });

  it("returns null when the terminal has no known dialect", () => {
    expect(buildToastSeq("pines", "auth finished", { TERM: "xterm-256color" })).toBeNull();
  });

  it("wraps for tmux passthrough when $TMUX is set", () => {
    const seq = buildToastSeq("pines", "hi", {
      TERM_PROGRAM: "WezTerm",
      TMUX: "/tmp/tmux-1000/default,42,0",
    });
    expect(seq).toBe("\x1bPtmux;\x1b\x1b]9;pines: hi\x1b\x1b\\\x1b\\");
  });

  it("cannot be escaped by hostile payload text", () => {
    const seq = buildToastSeq("pines", "x\x1b\\;rm -rf\x07", { TERM_PROGRAM: "iTerm.app" });
    // Exactly one OSC introducer (ours) and one terminator (ours, at the end).
    expect(seq!.match(/\x1b/g)).toHaveLength(2);
    expect(seq!.endsWith("\x1b\\")).toBe(true);
  });
});

describe("shouldNotify", () => {
  const tree = { treeId: "t1" };

  it("always notifies when the terminal is blurred", () => {
    expect(shouldNotify("blurred", { ...tree, attachedTreeId: null })).toBe(true);
    expect(shouldNotify("blurred", { ...tree, attachedTreeId: "t1" })).toBe(true);
  });

  it("stays quiet when the user is provably watching (known-focused)", () => {
    expect(shouldNotify("focused", { ...tree, attachedTreeId: null })).toBe(false);
    expect(shouldNotify("focused", { ...tree, attachedTreeId: "t1" })).toBe(false);
  });

  it("notifies when a different agent's pi covers the screen", () => {
    expect(shouldNotify("focused", { ...tree, attachedTreeId: "t2" })).toBe(true);
    expect(shouldNotify("unknown", { ...tree, attachedTreeId: "t2" })).toBe(true);
  });

  it("errs on ringing when the terminal never reports focus", () => {
    // Apple Terminal / tmux without focus-events: "minimized" and "watching"
    // are indistinguishable — a missed finish costs more than a spare ping.
    expect(shouldNotify("unknown", { ...tree, attachedTreeId: null })).toBe(true);
    expect(shouldNotify("unknown", { ...tree, attachedTreeId: "t1" })).toBe(false);
  });
});
