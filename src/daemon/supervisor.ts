/**
 * Supervisor: the daemon's registry of trees and their (optional) live agents.
 *
 * A *tree* is a pi session; an *agent* is a pi process currently bound to one.
 * Trees are dormant by default — an agent exists only when the user spawned,
 * resumed, or branched-with-spawn. Detaching a client never stops an agent.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentProc, type AgentProcOptions } from "./agents.js";
import { socketPath } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import type { TreeStatus, TreeSummary } from "../shared/types.js";

export interface TreeRecord {
  treeId: string;
  sessionPath: string | null;
  sessionId: string | null;
  name: string | null;
  cwd: string | null;
  parentSessionPath: string | null;
  status: TreeStatus;
  seen: boolean;
  /** Archived: hidden from clients' default forest view; no live agent allowed. */
  archived: boolean;
  leafId: string | null;
  nodeCount: number;
  x: number;
  y: number;
  mtime: number;
  agent?: AgentProc;
  /** True once this tree's pines extension has connected (exact status source). */
  extensionConnected: boolean;
  /** PTY activity fallback for status when no extension reports (e.g. fake pi). */
  lastOutputAt: number;
  /** Exit code of the most recent agent process, once one has exited. */
  lastExitCode: number | null;
  /** Fork point: entry id in the parent session this tree branched from. */
  parentEntryId: string | null;
}

export interface SupervisorEvents {
  /** A tree changed in a way clients care about. */
  update: [TreeRecord];
  /** Raw agent output to fan out to attached clients. */
  output: [string, string]; // treeId, data
  /** Agent process exited. */
  exit: [string, number | null]; // treeId, code
}

export const DEFAULT_MAX_LIVE_AGENTS = 12;
const ACTIVITY_QUIET_MS = 2000;

export function maxLiveAgents(): number {
  return loadConfig().maxLiveAgents ?? DEFAULT_MAX_LIVE_AGENTS;
}

function packageRoot(): string {
  // dist/daemon/supervisor.js → package root (same shape under src/ via tsx)
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function extensionEntryPath(): string {
  return join(packageRoot(), "src", "extension", "pines-extension.ts");
}

export interface PiLaunch {
  command: string;
  prefixArgs: string[];
}

const require = createRequire(import.meta.url);

export function bundledPiEntryPath(): string {
  const packageName = "@earendil-works/pi-coding-agent";
  for (const modulesDir of require.resolve.paths(packageName) ?? []) {
    const candidate = join(modulesDir, packageName, "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate bundled ${packageName} CLI`);
}

/**
 * Use pines' bundled pi by default so the runtime, SDK session writer, and
 * extension API always have the same version. Explicit config/env overrides
 * retain support for development binaries and test fixtures.
 */
export function piLaunch(): PiLaunch {
  const override = process.env.PINES_PI_BIN ?? loadConfig().piBin;
  if (override) return { command: override, prefixArgs: [] };
  return {
    command: process.execPath,
    prefixArgs: [bundledPiEntryPath()],
  };
}

/**
 * Version of the pi this daemon actually launches — the one honest source
 * for anything that displays it. Bundled pi: its manifest, read next to the
 * CLI entry we exec. Override (config piBin / PINES_PI_BIN): probe the
 * binary's `--version` briefly; a binary that won't say (test fixtures,
 * wrappers) reports as "custom" rather than borrowing the bundled number.
 */
export async function piVersion(): Promise<string | undefined> {
  const override = process.env.PINES_PI_BIN ?? loadConfig().piBin;
  if (!override) {
    try {
      const entry = bundledPiEntryPath(); // …/pi-coding-agent/dist/cli.js
      const manifest = join(dirname(dirname(entry)), "package.json");
      const p = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
      return p.version;
    } catch {
      return undefined;
    }
  }
  return new Promise((resolve) => {
    // The probed binary must not see the daemon's own plumbing: a pi-shaped
    // program that ignores argv (test fixtures, wrappers) would otherwise
    // connect back to PINES_SOCK as an extension and be SIGKILLed
    // mid-handshake when the probe times out.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith("PINES_") || k.startsWith("FAKE_PI_")) continue;
      env[k] = v;
    }
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(override, ["--version"], { stdio: ["ignore", "pipe", "ignore"], env });
    } catch {
      return resolve("custom");
    }
    let out = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve("custom");
    }, 800);
    proc.stdout?.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve(/\d+\.\d+[^\s]*/.exec(out)?.[0] ?? "custom");
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve("custom");
    });
  });
}

export class Supervisor extends EventEmitter<SupervisorEvents> {
  readonly trees = new Map<string, TreeRecord>();
  private activityTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly createAgent: (options: AgentProcOptions) => AgentProc = (options) =>
      new AgentProc(options),
  ) {
    super();
    // Fallback status demotion for agents without a connected extension:
    // PTY output implies working; quiet implies waiting for input.
    this.activityTimer = setInterval(() => this.demoteQuietAgents(), 500);
    this.activityTimer.unref();
  }

  liveCount(): number {
    let n = 0;
    for (const t of this.trees.values()) if (t.agent?.isRunning) n++;
    return n;
  }

  summary(rec: TreeRecord): TreeSummary {
    return {
      treeId: rec.treeId,
      sessionPath: rec.sessionPath ?? "",
      sessionId: rec.sessionId,
      name: rec.name,
      cwd: rec.cwd,
      parentSessionPath: rec.parentSessionPath,
      status: rec.status,
      seen: rec.seen,
      leafId: rec.leafId,
      nodeCount: rec.nodeCount,
      x: rec.x,
      y: rec.y,
      live: rec.agent?.isRunning ?? false,
      archived: rec.archived,
      mtime: rec.mtime,
      lastExitCode: rec.lastExitCode,
      parentEntryId: rec.parentEntryId,
    };
  }

  forest(): TreeSummary[] {
    return [...this.trees.values()].map((t) => this.summary(t));
  }

  /** Create a tree record for a session file discovered on disk (dormant). */
  upsertDormant(
    partial: Omit<Partial<TreeRecord>, "treeId"> & { sessionPath: string },
    preferredTreeId?: string,
  ): TreeRecord {
    let rec = [...this.trees.values()].find((t) => t.sessionPath === partial.sessionPath);
    if (!rec) {
      rec = this.newRecord();
      if (preferredTreeId) rec.treeId = preferredTreeId;
      this.trees.set(rec.treeId, rec);
    }
    Object.assign(rec, partial);
    this.touch(rec);
    return rec;
  }

  private newRecord(): TreeRecord {
    return {
      treeId: `t_${randomUUID().slice(0, 8)}`,
      sessionPath: null,
      sessionId: null,
      name: null,
      cwd: null,
      parentSessionPath: null,
      status: "dormant",
      seen: true,
      archived: false,
      leafId: null,
      nodeCount: 0,
      x: 0,
      y: 0,
      mtime: Date.now(),
      extensionConnected: false,
      lastOutputAt: 0,
      lastExitCode: null,
      parentEntryId: null,
    };
  }

  /**
   * Spawn a fresh pi on a new session (or resume `sessionPath` if given).
   * Throws if the live-agent limit is reached.
   */
  spawnAgent(options: {
    cwd: string;
    name?: string;
    prompt?: string;
    sessionPath?: string;
    existing?: TreeRecord;
    cols?: number;
    rows?: number;
  }): TreeRecord {
    const limit = maxLiveAgents();
    if (this.liveCount() >= limit) {
      const idle = [...this.trees.values()]
        .filter((t) => t.agent?.isRunning && t.status === "waiting")
        .map((t) => t.name ?? t.treeId)
        .slice(0, 5);
      throw new Error(
        `live agent limit reached (${limit}); idle candidates to kill: ${idle.join(", ") || "none"}`,
      );
    }

    const rec = options.existing ?? this.newRecord();
    rec.cwd = options.cwd;
    if (options.name) rec.name = options.name;

    const launch = piLaunch();
    const args: string[] = [...launch.prefixArgs, "-e", extensionEntryPath()];
    if (options.sessionPath) args.push("--session", options.sessionPath);
    if (options.name) args.push("--name", options.name);
    if (options.prompt) args.push(options.prompt);

    const agent = this.createAgent({
      treeId: rec.treeId,
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      command: launch.command,
      args,
      env: {
        PINES_SOCK: socketPath(),
        PINES_TREE_ID: rec.treeId,
      },
      onData: (data) => {
        rec.lastOutputAt = Date.now();
        if (!rec.extensionConnected && rec.status !== "running") {
          rec.status = "running";
          this.touch(rec);
        }
        this.emit("output", rec.treeId, data);
      },
      onExit: (code) => {
        const clean = code === 0 && (rec.status === "waiting" || rec.status === "dormant");
        rec.status = clean ? "completed" : code === 0 ? "completed" : "crashed";
        rec.lastExitCode = code;
        rec.seen = false;
        rec.agent?.dispose();
        rec.agent = undefined;
        rec.extensionConnected = false;
        this.touch(rec);
        this.emit("exit", rec.treeId, code);
      },
    });

    rec.agent = agent;
    if (!options.existing) this.trees.set(rec.treeId, rec);
    rec.status = "running";
    rec.seen = true;
    rec.archived = false; // active work belongs in the forest
    this.touch(rec);
    return rec;
  }

  /** Force a persist + broadcast for out-of-band field changes (name, leaf, …). */
  notify(rec: TreeRecord): void {
    this.touch(rec);
  }

  setStatus(rec: TreeRecord, status: TreeStatus, opts?: { unseen?: boolean }): void {
    const changed = rec.status !== status || (opts?.unseen === true && rec.seen);
    rec.status = status;
    if (opts?.unseen) rec.seen = false;
    if (changed) this.touch(rec);
  }

  ackSeen(treeId: string): void {
    const rec = this.trees.get(treeId);
    if (rec && !rec.seen) {
      rec.seen = true;
      this.touch(rec);
    }
  }

  killAgent(treeId: string): boolean {
    const rec = this.trees.get(treeId);
    if (!rec?.agent) return false;
    rec.agent.kill("SIGTERM");
    return true;
  }

  private demoteQuietAgents(): void {
    const now = Date.now();
    for (const rec of this.trees.values()) {
      if (
        rec.agent?.isRunning &&
        !rec.extensionConnected &&
        rec.status === "running" &&
        now - rec.lastOutputAt > ACTIVITY_QUIET_MS
      ) {
        rec.status = "waiting";
        rec.seen = false;
        this.touch(rec);
      }
    }
  }

  private touch(rec: TreeRecord): void {
    rec.mtime = Date.now();
    this.emit("update", rec);
  }

  async shutdown(): Promise<void> {
    if (this.activityTimer) clearInterval(this.activityTimer);
    const live = [...this.trees.values()].filter((t) => t.agent?.isRunning);
    for (const t of live) t.agent!.kill("SIGTERM");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && live.some((t) => t.agent?.isRunning)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const t of live) if (t.agent?.isRunning) t.agent.kill("SIGKILL");
  }
}
