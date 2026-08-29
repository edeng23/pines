/** User configuration: ~/.pines/config.json (all fields optional). */
import { readFileSync } from "node:fs";
import { configPath } from "./paths.js";

/** Default local embedding model (384-d, ~23 MB, offline after first download). */
export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

export interface PinesConfig {
  /** Prefix key in attached (pi) view, e.g. "ctrl+t" (default) or "ctrl+]". */
  prefixKey?: string;
  /** Max concurrent live pi processes (default 12). */
  maxLiveAgents?: number;
  /** Path/name of the pi binary (default "pi" on PATH; env PINES_PI_BIN wins). */
  piBin?: string;
  /** Boot splash animation: "off" disables it (env PINES_BOOT=off also works). */
  boot?: "on" | "off";
  /**
   * Attention notifications when an agent finishes, needs input, or crashes
   * while you aren't watching it (default "terminal"):
   * - "terminal": BEL plus a desktop toast via OSC escapes (kitty/iTerm2/
   *   WezTerm/Ghostty/foot/Warp; tmux needs `allow-passthrough on`).
   * - "bell": BEL only (tmux window flag, macOS Terminal badge).
   * - "system": spawn the OS notifier (osascript / notify-send).
   * - "off": silence.
   */
  notify?: "off" | "bell" | "terminal" | "system";
  /**
   * Embedding model for semantic layout / similarity. Must produce vectors of
   * one consistent dimension; "Xenova/bge-small-en-v1.5" is a known-good 384-d
   * quality upgrade. Changing this triggers a full re-embed on next start.
   */
  embedModel?: string;
}

let cached: PinesConfig | undefined;

export function loadConfig(): PinesConfig {
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(configPath(), "utf8")) as PinesConfig;
  } catch {
    cached = {};
  }
  return cached;
}

/** "ctrl+t" → 0x14. Returns undefined for unsupported specs. */
export function prefixByte(spec: string | undefined): number | undefined {
  if (!spec) return undefined;
  const m = /^ctrl\+([a-z\]\\^_])$/i.exec(spec.trim());
  if (!m) return undefined;
  const ch = m[1]!.toLowerCase();
  if (ch >= "a" && ch <= "z") return ch.charCodeAt(0) - 96;
  return { "]": 0x1d, "\\": 0x1c, "^": 0x1e, _: 0x1f }[ch];
}
