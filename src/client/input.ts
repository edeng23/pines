/**
 * Raw stdin router: extracts SGR mouse sequences (CSI < b;x;y M/m) from the
 * byte stream and emits logical keys. Terminals may coalesce multiple
 * keystrokes into one data event, so callers must not receive "Ctrl+t f" as
 * one opaque chunk.
 *
 * We own the stdin loop (pi-tui has no mouse support at all); mouse reporting
 * is enabled only in forest/tree views, never while attached to a pi.
 */
import { EventEmitter } from "node:events";

export interface MouseEvent {
  kind: "press" | "release" | "drag" | "move" | "wheel-up" | "wheel-down";
  button: 0 | 1 | 2;
  /** 1-based terminal cell coords as reported; converted to 0-based here. */
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface InputEvents {
  key: [string];
  mouse: [MouseEvent];
}

const MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const CSI_KEY_RE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/;

export class InputRouter extends EventEmitter<InputEvents> {
  private buf = "";

  feed(chunk: Buffer | string): void {
    this.buf += chunk.toString("utf8" as BufferEncoding);
    this.drain();
  }

  private drain(): void {
    while (this.buf.length > 0) {
      if (this.buf.startsWith("\x1b[<")) {
        const m = MOUSE_RE.exec(this.buf);
        if (m) {
          this.buf = this.buf.slice(m[0].length);
          this.emit("mouse", decodeSgr(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === "M"));
          continue;
        }
        // Partial mouse sequence: wait for more bytes (bounded).
        if (this.buf.length < 24 && /^\x1b\[<[\d;]*$/.test(this.buf)) {
          return;
        }
      }

      if (this.buf.startsWith("\x1b")) {
        const key = CSI_KEY_RE.exec(this.buf)?.[0];
        if (key) {
          this.buf = this.buf.slice(key.length);
          this.emit("key", key);
          continue;
        }
        // Preserve a CSI/SS3 sequence split across stdin data events.
        if (
          this.buf.length < 64 &&
          (/^\x1b\[[0-?]*[ -/]*$/.test(this.buf) || this.buf === "\x1bO")
        ) {
          return;
        }
      }

      const codePoint = this.buf.codePointAt(0)!;
      const key = String.fromCodePoint(codePoint);
      this.buf = this.buf.slice(key.length);
      this.emit("key", key);
    }
  }
}

function decodeSgr(b: number, x1: number, y1: number, press: boolean): MouseEvent {
  const shift = (b & 4) !== 0;
  const alt = (b & 8) !== 0;
  const ctrl = (b & 16) !== 0;
  const motion = (b & 32) !== 0;
  const x = x1 - 1;
  const y = y1 - 1;
  if (b >= 64) {
    return {
      kind: (b & 1) === 0 ? "wheel-up" : "wheel-down",
      button: 0,
      x,
      y,
      shift,
      alt,
      ctrl,
    };
  }
  const raw = b & 3;
  const button = (raw === 3 ? 0 : raw) as 0 | 1 | 2;
  if (motion) {
    // raw 3 with motion = pointer move with no button held.
    return { kind: raw === 3 ? "move" : "drag", button, x, y, shift, alt, ctrl };
  }
  return { kind: press ? "press" : "release", button, x, y, shift, alt, ctrl };
}

export const MOUSE_ENABLE = "\x1b[?1002h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1002l";
/** Match Pi's enhanced input mode while attached, without changing its stack. */
export const GUEST_INPUT_ENABLE = "\x1b[>4;0m\x1b[=7u\x1b[?2004h";
/** Restore normal shell/Pines input after leaving Pi. */
export const GUEST_INPUT_DISABLE = "\x1b[?2004l\x1b[=0u\x1b[>4;0m";
export const ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[?25l";
export const ALT_SCREEN_LEAVE = "\x1b[?25h\x1b[?1049l";
export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";
