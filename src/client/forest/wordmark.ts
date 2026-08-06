/**
 * The pines wordmark: a three-row block-letter mark, colored like the
 * canopy — pale where the light hits the top, deep at the base. One
 * definition shared by the sidebar header and the boot splash so the brand
 * never drifts.
 */

export const WORDMARK: readonly [string, string, string] = [
  "█▀▄ ▀█▀ █▄ █ █▀▀ ▄▀▀",
  "█▀▀  █  █ ▀█ █▀▀ ▀▀▄",
  "█   ▄█▄ █  █ ▀▀▀ ▄▄▀",
];
export const WORDMARK_W = WORDMARK[0].length;

/** Canopy gradient, top row → bottom row. */
export const WORDMARK_SGR: readonly [string, string, string] = [
  "1;38;5;108",
  "1;38;5;71",
  "1;38;5;65",
];

/** The three foliage rows + trunk of the mascot pine, with their colors. */
export const MASCOT: ReadonlyArray<readonly [string, string]> = [
  ["  ▲", "38;5;108"],
  [" ▟█▙", "38;5;71"],
  ["▟███▙", "38;5;65"],
  ["  ╹", "38;5;95"],
];
