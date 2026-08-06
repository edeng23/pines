/**
 * Status vocabulary shared by every forest style, the sidebar, and the status
 * bar: one glyph and one color per lifecycle state.
 *
 * Styles may dress a tree up however they like, but they all reach for these
 * two functions for the state itself — a tree's color and animation mean the
 * same thing in every option.
 */
import { MUTED } from "../theme.js";

export const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

export function statusSgr(t: { status: string; seen: boolean }): string {
  switch (t.status) {
    case "running":
      return "33"; // yellow
    case "waiting":
      return t.seen ? "32" : "38;5;44"; // green ○ once acknowledged, teal ● before
    case "crashed":
      return "31";
    case "completed":
      return "32"; // green, undimmed — dim colors sink below visibility on dark themes
    default:
      return MUTED; // dormant
  }
}

export function statusGlyph(t: { status: string; seen: boolean }, spinnerFrame: number): string {
  switch (t.status) {
    case "running":
      return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
    case "waiting":
      return t.seen ? "○" : "●";
    case "crashed":
      return "●";
    case "completed":
      return "✓"; // distinguishes from waiting ○ now both are full green
    default:
      return "·";
  }
}
