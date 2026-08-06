/**
 * AgentProc: one live pi process hosted in a PTY, with server-side VT screen
 * state so late-attaching clients get a faithful snapshot.
 *
 * Output flow: pty → @xterm/headless Terminal (screen state + scrollback)
 *                 → raw ANSI passthrough to every attached client.
 */
import pty from "node-pty";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ensureNodePtyReady } from "./pty-compat.js";

export interface AgentProcOptions {
  treeId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Command to run (the pi binary, or a fake in tests). */
  command: string;
  args: string[];
  env?: Record<string, string>;
  onData: (data: string) => void;
  onExit: (exitCode: number | null) => void;
}

const SNAPSHOT_QUIET_MS = 30;
const SNAPSHOT_MAX_WAIT_MS = 200;

export class AgentProc {
  readonly treeId: string;
  readonly pid: number;
  private readonly pty: pty.IPty;
  private readonly term: InstanceType<typeof xterm.Terminal>;
  private readonly serializer: SerializeAddon;
  private lastDataAt = 0;
  private exited = false;
  cols: number;
  rows: number;

  constructor(private readonly opts: AgentProcOptions) {
    ensureNodePtyReady();
    this.treeId = opts.treeId;
    this.cols = opts.cols;
    this.rows = opts.rows;

    this.term = new xterm.Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: 10_000,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);

    this.pty = pty.spawn(opts.command, opts.args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: {
        ...(process.env as Record<string, string>),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...opts.env,
      },
    });
    this.pid = this.pty.pid;

    this.pty.onData((data) => {
      this.lastDataAt = Date.now();
      this.term.write(data);
      opts.onData(data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      opts.onExit(exitCode);
    });
  }

  get isRunning(): boolean {
    return !this.exited;
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  /**
   * Serialize current screen + scrollback to an ANSI string a client replays.
   * Waits for a short quiet period so we don't serialize mid-frame (pi-tui uses
   * CSI 2026 synchronized updates; a snapshot torn inside one renders garbage).
   */
  async snapshot(scrollback = 2000): Promise<string> {
    const start = Date.now();
    while (
      Date.now() - this.lastDataAt < SNAPSHOT_QUIET_MS &&
      Date.now() - start < SNAPSHOT_MAX_WAIT_MS
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.serializer.serialize({ scrollback });
  }

  /** Immediate (non-debounced) serialize — used when the process has exited. */
  snapshotSync(scrollback = 2000): string {
    return this.serializer.serialize({ scrollback });
  }

  kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    if (!this.exited) this.pty.kill(signal);
  }

  dispose(): void {
    this.term.dispose();
  }
}
