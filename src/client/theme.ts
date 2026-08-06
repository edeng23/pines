/**
 * Grayscale tiers as explicit 256-color grays.
 *
 * SGR 90 (bright black) is whatever the user's theme says it is — on many
 * popular dark themes that's nearly the background color, which made elision
 * rows, gutter dots, and sidebar metadata unreadable. Fixed xterm-256 grays
 * render consistently everywhere (we already rely on 256 color for the teal
 * attention dot).
 */

/** Secondary text: elisions, headers, ages, hints, placeholders. */
export const MUTED = "38;5;248";

/** Structure: rails, lineage edges, divider, boring node dots. Darker than
 * MUTED so content reads above structure, but never below visibility. */
export const FAINT = "38;5;243";

/**
 * Decoration only: graph paper, contour rings. Below FAINT so structure still
 * reads above it, but not so far below that it disappears — 238 was tuned on
 * a light terminal and sank into the background on a dark one.
 */
export const GRID = "38;5;240";

/** Foliage. Mid-green so it holds up on light and dark grounds alike; the
 * status colors stay reserved for state, so a tree can look like a tree
 * without claiming to be a status. */
export const LEAF = "38;5;71";

/** Bare wood: a session with no process behind it has no needles left. */
export const BARK = "38;5;101";
