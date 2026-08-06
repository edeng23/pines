/**
 * Boot splash: the germination animation, played while the daemon connects.
 * A seed falls, grows through the forest's sprite stages, neighbors sprout,
 * the wordmark rises — and the agents that never slept light their crowns,
 * counted from the live forest the hello just delivered.
 *
 * Any key skips. Disabled by config `boot: "off"`, env PINES_BOOT=off, a
 * non-TTY, or a terminal too small to stage it.
 */
import { loadConfig } from "../shared/config.js";
import { WORDMARK, WORDMARK_SGR } from "./forest/wordmark.js";

const R = "\x1b[0m";
const MUT = "38;5;248";
const FNT = "38;5;240";
const TEAL = "1;38;5;44";
const YEL = "33";
const G1 = "38;5;65";
const G2 = "38;5;71";
const G3 = "38;5;108";
const TRUNK = "38;5;95";

/** Pine sprite growth stages (rows top→down; the last row is the trunk). */
const PINE: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [["▲", G2], ["╹", TRUNK]],
  [[" ▲", G3], ["▟█▙", G2], [" ╹", TRUNK]],
  [["  ▲", G3], [" ▟█▙", G2], ["▟███▙", G1], ["  ╹", TRUNK]],
  [["   ▲", G3], ["  ▟█▙", G2], [" ▟███▙", G2], ["▟█████▙", G1], ["   ╹", TRUNK]],
];

class Cv {
  private ch: string[][];
  private sg: string[][];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.ch = Array.from({ length: h }, () => new Array<string>(w).fill(" "));
    this.sg = Array.from({ length: h }, () => new Array<string>(w).fill(""));
  }
  put(x: number, y: number, text: string, s = ""): void {
    x = Math.round(x);
    y = Math.round(y);
    if (y < 0 || y >= this.h) return;
    for (let i = 0; i < text.length; i++) {
      const cx = x + i;
      if (cx < 0 || cx >= this.w || text[i] === " ") continue;
      this.ch[y]![cx] = text[i]!;
      this.sg[y]![cx] = s;
    }
  }
  lines(): string[] {
    return this.ch.map((row, y) => {
      let out = "";
      let cur: string | null = null;
      for (let x = 0; x < this.w; x++) {
        const s = this.sg[y]![x]!;
        if (s !== cur) {
          out += (cur !== null ? R : "") + (s ? `\x1b[${s}m` : "");
          cur = s;
        }
        out += row[x];
      }
      return (out + (cur ? R : "")).replace(/\s+$/, "");
    });
  }
}

export interface BootFrame {
  lines: string[];
  ms: number;
}

function drawPine(cv: Cv, x: number, y: number, stage: number): void {
  const rows = PINE[Math.max(0, Math.min(3, stage))]!;
  rows.forEach(([t, c], i) => cv.put(x, y - rows.length + 1 + i, t, c));
}

function drawMark(cv: Cv, x: number, y: number, upTo: number): void {
  // The wordmark is one string per row; reveal left-to-right by columns.
  WORDMARK.forEach((row, r) => cv.put(x, y + r, row.slice(0, upTo), WORDMARK_SGR[r]!));
}

function ground(cv: Cv, y: number): void {
  for (let x = 1; x < cv.w - 1; x += 6) cv.put(x, y, "⠁", FNT);
}

interface Stage {
  gy: number;
  cx: number;
  my: number;
  spots: ReadonlyArray<readonly [number, number]>;
}

function stageOf(w: number, h: number): Stage {
  const cx = Math.floor(w / 2);
  return {
    gy: Math.floor(h * 0.72),
    cx,
    my: Math.floor(h * 0.22),
    spots: [
      [cx - 18, 1],
      [cx + 14, 2],
      [cx - 30, 0],
      [cx + 26, 1],
      [cx + 38, 0],
      [cx - 40, 1],
    ],
  };
}

const TAG = "your conversations are trees";
const MARK_W = WORDMARK[0].length;

/** The growth: seed → pine → forest → wordmark + tagline. */
export function growthFrames(w: number, h: number): BootFrame[] {
  const { gy, cx, my, spots } = stageOf(w, h);
  const frames: BootFrame[] = [];
  const F = (ms: number, draw: (cv: Cv) => void): void => {
    const cv = new Cv(w, h);
    ground(cv, gy + 1);
    draw(cv);
    frames.push({ lines: cv.lines(), ms });
  };
  for (let i = 0; i < 5; i++) {
    const y = Math.floor((gy - 3) * ((i + 1) / 5)) + 2;
    F(60, (cv) => cv.put(cx, Math.min(y, gy), "·", MUT));
  }
  for (let s = 0; s < 4; s++) {
    for (let r = 0; r < 3; r++) F(90, (cv) => drawPine(cv, cx - s, gy, s));
  }
  spots.forEach((_, k) => {
    F(100, (cv) => {
      drawPine(cv, cx - 3, gy, 3);
      spots.slice(0, k + 1).forEach(([sx, st]) => drawPine(cv, sx, gy, st));
    });
  });
  for (let k = 4; k <= MARK_W + 4; k += 4) {
    F(70, (cv) => {
      drawPine(cv, cx - 3, gy, 3);
      spots.forEach(([sx, st]) => drawPine(cv, sx, gy, st));
      drawMark(cv, cx - Math.floor(MARK_W / 2), my, k);
      if (k > MARK_W) cv.put(cx - Math.floor(TAG.length / 2), my + 4, TAG, MUT);
    });
  }
  return frames;
}

/** The ending: crowns of the still-running agents wink on, the line lands. */
export function endingFrames(w: number, h: number, agents: number): BootFrame[] {
  const { gy, cx, my, spots } = stageOf(w, h);
  const frames: BootFrame[] = [];
  const all: Array<[readonly [number, number], string, string]> = [
    [spots[1]!, "◐", YEL],
    [spots[3]!, "●", TEAL],
    [spots[0]!, "◐", YEL],
  ];
  const lit = all.slice(0, Math.min(agents, 3));
  const slept =
    agents > 0 ? `${agents} agent${agents === 1 ? "" : "s"} never slept` : "";
  const F = (ms: number, litCount: number, line: boolean): void => {
    const cv = new Cv(w, h);
    ground(cv, gy + 1);
    drawPine(cv, cx - 3, gy, 3);
    spots.forEach(([sx, st]) => drawPine(cv, sx, gy, st));
    lit.slice(0, litCount).forEach(([[sx, st], g, sgrc]) =>
      cv.put(sx + st, gy - (st + 2), g, sgrc),
    );
    drawMark(cv, cx - Math.floor(MARK_W / 2), my, MARK_W);
    cv.put(cx - Math.floor(TAG.length / 2), my + 4, TAG, MUT);
    if (line && slept) cv.put(cx - Math.floor(slept.length / 2), my + 5, slept, TEAL);
    frames.push({ lines: cv.lines(), ms });
  };
  lit.forEach((_, k) => F(150, k + 1, false));
  if (slept) F(150, lit.length, true);
  if (frames.length === 0) F(400, 0, false); // no agents: a beat on the forest
  frames.push({ ...frames[frames.length - 1]!, ms: agents > 0 ? 900 : 500 });
  return frames;
}

export interface BootHandle {
  /** Play the ending (with the live agent count) and clean up. */
  finish(getAgents: () => number): Promise<void>;
}

const NOOP: BootHandle = { finish: async () => {} };

/**
 * Start the splash immediately (it masks the daemon connect); call
 * `finish()` once the forest is known. Never throws — a broken splash must
 * not take the app down.
 */
export function startBoot(out: NodeJS.WriteStream, stdin: NodeJS.ReadStream): BootHandle {
  try {
    const cfg = loadConfig() as { boot?: string };
    const enabled =
      out.isTTY &&
      stdin.isTTY &&
      process.env.PINES_BOOT !== "off" &&
      cfg.boot !== "off" &&
      (out.columns ?? 0) >= 70 &&
      (out.rows ?? 0) >= 20;
    if (!enabled) return NOOP;

    let skipped = false;
    const onData = (): void => {
      skipped = true;
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
    out.write("\x1b[?1049h\x1b[?25l");

    // The whole terminal is the stage — the layout centers itself, so a
    // wide screen gets a wide forest, not a box in the corner.
    const w = out.columns!;
    const h = out.rows!;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const play = async (frames: BootFrame[]): Promise<void> => {
      for (const f of frames) {
        if (skipped) return;
        out.write("\x1b[H" + f.lines.map((l) => l + "\x1b[K").join("\r\n"));
        await sleep(f.ms);
      }
    };
    const growth = play(growthFrames(w, h));

    return {
      async finish(getAgents: () => number): Promise<void> {
        try {
          await growth;
          if (!skipped) await play(endingFrames(w, h, getAgents()));
        } finally {
          stdin.off("data", onData);
          out.write("\x1b[2J\x1b[H");
        }
      },
    };
  } catch {
    return NOOP;
  }
}
