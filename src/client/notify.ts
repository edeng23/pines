/**
 * Attention notifications: tell the user an agent finished, needs input, or
 * crashed — but only when they could have missed it.
 *
 * Delivery (config `notify`, default "terminal"):
 *  - "bell":     BEL only. Universal transport; tmux turns it into a window
 *                flag (monitor-bell), macOS Terminal badges the Dock.
 *  - "terminal": BEL plus a desktop toast via OSC escape codes — kitty
 *                speaks OSC 99, iTerm2/WezTerm/Ghostty/foot/Warp speak
 *                OSC 9 — wrapped for tmux passthrough (needs
 *                `allow-passthrough on`, tmux ≥ 3.3). The BEL rides along
 *                because a toast can be swallowed silently (alert filtering,
 *                OS notification permission, Focus mode).
 *  - "system":   spawn the OS notifier (osascript / notify-send), which works
 *                in any terminal but not over SSH.
 *  - "off":      nothing.
 *
 * Suppression: the client tracks terminal focus via CSI ?1004 focus
 * reporting. A known-focused terminal notifies only when the finished tree
 * is hidden behind a different attached pi — forest/tree views already
 * surface status changes themselves (teal dot, crash toast). Blurred, or
 * unknown (a terminal that never reports focus), rings.
 */
import { spawn } from "node:child_process";

export type NotifyMode = "off" | "bell" | "terminal" | "system";
export type FocusState = "unknown" | "focused" | "blurred";

export const FOCUS_ENABLE = "\x1b[?1004h";
export const FOCUS_DISABLE = "\x1b[?1004l";
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";
export const BELL = "\x07";

export type OscBackend = "kitty" | "osc9" | "none";

/** Which toast escape dialect the hosting terminal understands, if any. */
export function detectOscBackend(env: NodeJS.ProcessEnv = process.env): OscBackend {
  if (env.KITTY_WINDOW_ID || (env.TERM ?? "").includes("kitty")) return "kitty";
  if (/iTerm|WezTerm|ghostty|WarpTerminal/i.test(env.TERM_PROGRAM ?? "")) return "osc9";
  if (/wezterm|ghostty|foot/i.test(env.TERM ?? "")) return "osc9";
  return "none";
}

/** OSC payload text: strip C0/C1 controls so it cannot terminate the sequence. */
export function sanitizeOscText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, " ");
}

/**
 * tmux swallows OSC it doesn't understand; a DCS `tmux;` wrapper (with every
 * ESC doubled) passes it to the outer terminal when `allow-passthrough` is on.
 */
export function wrapTmuxPassthrough(seq: string): string {
  return "\x1bPtmux;" + seq.replaceAll("\x1b", "\x1b\x1b") + "\x1b\\";
}

/** The toast escape sequence for this terminal, or null if it has none. */
export function buildToastSeq(
  title: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const t = sanitizeOscText(title);
  const b = sanitizeOscText(body);
  let seq: string | null = null;
  switch (detectOscBackend(env)) {
    case "kitty":
      seq = `\x1b]99;i=1:d=0;${t}\x1b\\\x1b]99;i=1:p=body;${b}\x1b\\`;
      break;
    case "osc9":
      // OSC 9 carries a single line — no separate title field.
      seq = `\x1b]9;${t}: ${b}\x1b\\`;
      break;
    case "none":
      return null;
  }
  return env.TMUX ? wrapTmuxPassthrough(seq) : seq;
}

/**
 * Suppress only when the user is provably looking: terminal known-focused on
 * the forest/tree views (teal dot, crash toast) or on that very agent's pi.
 * Unknown focus means a terminal without ?1004 support (Apple Terminal; tmux
 * without `focus-events on`) — there "minimized" and "watching" look
 * identical, so err on ringing: a redundant ping beats a missed finish.
 */
export function shouldNotify(
  focus: FocusState,
  opts: { treeId: string; attachedTreeId: string | null },
): boolean {
  if (focus === "blurred") return true;
  const watchingIt = opts.attachedTreeId === opts.treeId;
  if (focus === "focused") return opts.attachedTreeId !== null && !watchingIt;
  return !watchingIt;
}

/** OS-level toast: fire-and-forget, silent when the notifier is missing. */
export function systemNotify(title: string, body: string): void {
  try {
    let proc;
    if (process.platform === "darwin") {
      // JSON escaping (\" and \\) is valid AppleScript string escaping too.
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`;
      proc = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
    } else if (process.platform === "linux") {
      proc = spawn("notify-send", ["--", title, body], { stdio: "ignore", detached: true });
    } else {
      return;
    }
    proc.on("error", () => {});
    proc.unref();
  } catch {
    // no notifier on this box — the status dot still tells the story
  }
}
