/**
 * The pines daemon: owns all pi PTYs, serves thin clients and pi-extension
 * connections over one Unix socket with a role handshake, and keeps the
 * SQLite forest state in sync with pi's session files on disk.
 *
 * Runs detached from any terminal (spawned via lifecycle.spawnServerDaemon).
 * Continues running after every client disconnects — that is the whole point.
 */
import { createServer, type Server } from "node:net";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { Wire } from "../shared/wire.js";
import {
  PROTOCOL_VERSION,
  isHello,
  type AttachMsg,
  type BranchMsg,
  type ClientToDaemon,
  type DaemonToClient,
  type ExtensionHello,
  type ExtensionToDaemon,
  type GetTreeMsg,
  type RenameTreeMsg,
  type ResumeTreeMsg,
  type SearchMsg,
  type SetArchivedMsg,
  type SetLabelMsg,
  type SimilarMsg,
  type SpawnTreeMsg,
} from "../shared/protocol.js";
import { pinesVersion } from "../shared/version.js";
import { daemonLogPath, ensurePinesHome, socketPath } from "../shared/paths.js";
import {
  clearDaemonPid,
  isServerListening,
  readDaemonPid,
  writeDaemonPid,
} from "./lifecycle.js";
import { piVersion, Supervisor, type TreeRecord } from "./supervisor.js";
import { ExtBridge } from "./extbridge.js";
import {
  openDb,
  allTrees,
  deleteTree,
  treeBySessionPath,
  upsertTree,
  type DB,
} from "../store/db.js";
import { watchSessions, type SessionWatcher } from "../store/watcher.js";
import { ingestSessionFile } from "../session/ingest.js";
import { parseSessionFile, toTreeDetail } from "../session/parser.js";
import { assignLexicalPositions, isSanePosition } from "../layout/lexical.js";
import type { ParsedSession } from "../session/parser.js";

/** Human-readable fallback name for sessions that never got an explicit one. */
function deriveTreeName(parsed: ParsedSession): string | null {
  const clip = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    // Generous: displays truncate to fit themselves, but a name clipped here
    // is clipped everywhere — a wide sidebar can show the longer read.
    return t.length > 48 ? t.slice(0, 47) + "…" : t;
  };
  // Branched sessions share their parent's opening message — the divergence
  // point (their leaf-most text) is what distinguishes them.
  if (parsed.header.parentSession) {
    for (let i = parsed.entries.length - 1; i >= 0; i--) {
      const text = parsed.entries[i]!.text;
      if (text) return clip(text);
    }
  }
  if (parsed.firstUserText) return clip(parsed.firstUserText);
  // Deliberately no directory fallback: a dozen trees named after the same
  // repo tell you nothing. Clients render cwd dimmed while name is null.
  return null;
}
import { relax } from "../layout/relax.js";
import { branchInPlace, branchToNewTree, setNodeLabel, type BranchDeps } from "./branch.js";
import { SemanticLayout } from "./semantic.js";
import { searchFts, similarTrees } from "../store/db.js";
import type { SearchHit, SimilarHit, TreeStatus } from "../shared/types.js";

/** How long a version-rejected connection stays open to accept `shutdown`. */
const REJECTED_GRACE_MS = 2000;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(daemonLogPath(), line);
  } catch {
    // Logging must never take the daemon down.
  }
}

interface ClientConn {
  wire: Wire;
  cols: number;
  rows: number;
  attached: Set<string>;
}

export class Daemon {
  readonly supervisor = new Supervisor();
  readonly db: DB;
  readonly extBridge: ExtBridge;
  readonly semantic: SemanticLayout;
  private readonly clients = new Set<ClientConn>();
  private server: Server | undefined;
  private watcher: SessionWatcher | undefined;
  private shuttingDown = false;
  /** Resolved once at startup; hellos sent before it lands simply omit it. */
  private piVersion: string | undefined;

  constructor() {
    this.db = openDb();
    // LRU eviction must never take a terminal someone is attached to.
    this.supervisor.isAttachedCheck = (treeId) => this.isAttached(treeId);
    this.semantic = new SemanticLayout({
      db: this.db,
      supervisor: this.supervisor,
      log,
      toast: (text) => this.broadcast({ t: "toast", level: "info", text }),
    });
    this.extBridge = new ExtBridge(this.supervisor, {
      claimSession: (treeId, hello) => this.claimSession(treeId, hello),
      onSessionActivity: (sessionPath) => void this.ingest(sessionPath),
      isAttached: (treeId) => this.isAttached(treeId),
      onSettled: (treeId) => void this.runPendingNav(treeId),
      log,
    });
    void piVersion().then((v) => {
      this.piVersion = v;
    });
    this.loadPersistedTrees();
    // Re-embed trees whose stored vectors predate the current chunking scheme
    // (or the configured model). No-op on an up-to-date store.
    this.semantic.enqueueStale();

    this.supervisor.on("update", (rec) => {
      this.persist(rec);
      this.broadcast({ t: "forest_update", upsert: [this.supervisor.summary(rec)] });
    });
    this.supervisor.on("output", (treeId, data) => {
      const b64 = Buffer.from(data, "utf8").toString("base64");
      for (const c of this.clients) {
        if (c.attached.has(treeId)) c.wire.send({ t: "output", treeId, data: b64 });
      }
    });
    this.supervisor.on("exit", (treeId, code) => {
      const rec = this.supervisor.trees.get(treeId);
      if (rec?.sessionPath) {
        // Keep the final screen for post-mortem peeks (best effort).
        if (existsSync(rec.sessionPath)) void this.ingest(rec.sessionPath);
        // A crash before the session file ever appeared must stay visible —
        // deleting the tree would erase the only evidence anything failed.
        // An evicted/stopping agent's nonzero code is the signal we sent it,
        // not a crash (lastExitCode was cleared on the way down) — but a
        // missing file is still no reason to silently delete the tree as a
        // side effect of housekeeping: log it and leave the record be.
        else if (code === 0) this.removeSession(rec.sessionPath);
        else if (rec.lastExitCode === null)
          log(`agent of ${treeId} stopped (evicted/shutdown) before writing ${rec.sessionPath}`);
        else log(`agent of ${treeId} crashed (exit ${code}) before writing ${rec.sessionPath}`);
      }
      for (const c of this.clients) {
        if (c.attached.has(treeId)) c.wire.send({ t: "agent_exit", treeId, code });
      }
    });
  }

  private loadPersistedTrees(): void {
    for (const row of allTrees(this.db)) {
      if (!existsSync(row.session_path)) {
        deleteTree(this.db, row.tree_id);
        continue;
      }
      // Corrupt persisted positions (from the old relax() explosion bug)
      // reset to the unplaced sentinel so assignPositions re-places them.
      const sane = isSanePosition(row.x, row.y);
      if (!sane) log(`resetting corrupt position of ${row.tree_id} (${row.x}, ${row.y})`);
      const rec = this.supervisor.upsertDormant({
        sessionPath: row.session_path,
        sessionId: row.session_id,
        name: row.name,
        cwd: row.cwd,
        parentSessionPath: row.parent_session_path,
        leafId: row.leaf_id,
        nodeCount: row.node_count,
        x: sane ? row.x : 0,
        y: sane ? row.y : 0,
        mtime: row.mtime,
        status: "dormant",
        // Attention survives restarts: a result the user never looked at is
        // still unlooked-at after the daemon comes back.
        seen: row.seen === 1,
        archived: row.archived === 1,
      }, row.tree_id);
    }
    // Fork points (graft ordinal 0) hydrate parentEntryId for fork chips.
    try {
      const rows = this.db
        .prepare("SELECT tree_id, parent_entry_id FROM graft_parents WHERE ordinal = 0")
        .all() as Array<{ tree_id: string; parent_entry_id: string }>;
      for (const r of rows) {
        const rec = this.supervisor.trees.get(r.tree_id);
        if (rec) rec.parentEntryId = r.parent_entry_id;
      }
    } catch {
      /* older DBs without the table */
    }
    log(`loaded ${this.supervisor.trees.size} persisted tree(s)`);
    this.assignPositions();
  }

  private persist(rec: TreeRecord): void {
    if (!rec.sessionPath) return;
    upsertTree(this.db, {
      tree_id: rec.treeId,
      session_path: rec.sessionPath,
      session_id: rec.sessionId,
      name: rec.name,
      cwd: rec.cwd,
      parent_session_path: rec.parentSessionPath,
      status: rec.status,
      seen: rec.seen ? 1 : 0,
      leaf_id: rec.leafId,
      node_count: rec.nodeCount,
      mtime: rec.mtime,
      x: rec.x,
      y: rec.y,
      archived: rec.archived ? 1 : 0,
    });
  }

  /** Place any unpositioned trees with the lexical (cwd + recency) layout. */
  private assignPositions(): void {
    const all = [...this.supervisor.trees.values()];
    const changed = new Set(assignLexicalPositions(all));
    if (changed.size === 0) return;
    // Push newly placed trees out of each other's (and existing trees')
    // space — minis have real extent at z1, so spacing must respect it.
    const points = all.map((rec) => ({ x: rec.x, y: rec.y, pinned: !changed.has(rec), rec }));
    relax(points, 3.6, 40);
    for (const p of points) {
      if (p.pinned) continue;
      p.rec.x = p.x;
      p.rec.y = p.y;
      this.supervisor.notify(p.rec);
    }
  }

  private isAttached(treeId: string): boolean {
    for (const c of this.clients) if (c.attached.has(treeId)) return true;
    return false;
  }

  /**
   * Ingest a session file and sync the supervisor record for it (creating a
   * dormant record for sessions discovered outside pines).
   */
  private async ingest(sessionPath: string, preferredTreeId?: string): Promise<TreeRecord | undefined> {
    if (!existsSync(sessionPath)) return undefined;
    try {
      const { treeId, parsed, mtimeMs } = await ingestSessionFile(this.db, sessionPath, {
        preferredTreeId,
      });
      let rec = [...this.supervisor.trees.values()].find((t) => t.sessionPath === sessionPath);
      if (!rec) {
        // Install the DB identity before the first update is broadcast. A
        // provisional update followed by an in-memory rename leaves connected
        // clients with a ghost node they can never remove.
        rec = this.supervisor.upsertDormant({ sessionPath }, treeId);
      }
      rec.sessionId = parsed.header.sessionId;
      // The file's own mtime is the honest activity clock. Wall-clock "now"
      // here would reset every age to 0s on daemon start, when the watcher's
      // initial sweep re-ingests every session — and persist() would then
      // write that lie back to SQLite.
      rec.mtime = mtimeMs;
      rec.cwd = parsed.header.cwd ?? rec.cwd;
      rec.parentSessionPath = parsed.header.parentSession;
      rec.nodeCount = parsed.entries.length;
      // Naming: explicit session name wins; otherwise derive from content.
      // Also heal names persisted by the old directory-basename fallback —
      // they made every tree in a repo show the same word.
      if (parsed.name) rec.name = parsed.name;
      else if (!rec.name || rec.name === basename(rec.cwd ?? "")) {
        rec.name = deriveTreeName(parsed) ?? rec.name;
      }
      // Leaf authority: a live extension's word wins while its agent is IDLE
      // (the user may have navigated the tree up, away from the file tail) —
      // but the extension only reports a new leaf on settle, so while the
      // agent is RUNNING the growing file's tail is the truth. Without this,
      // the tip pins to the previous settle point for the whole run while
      // the transcript shows the new messages.
      if (!rec.extensionConnected || rec.status === "running") rec.leafId = parsed.leafId;
      if (rec.parentSessionPath && !rec.parentEntryId) {
        void this.computeForkPoint(rec, parsed);
      }
      this.supervisor.notify(rec); // persist + broadcast
      if (rec.x === 0 && rec.y === 0) this.assignPositions();
      this.semantic.enqueue(rec);
      return rec;
    } catch (err) {
      log(`ingest failed for ${sessionPath}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Remove a dormant session consistently from memory, SQLite, and clients. */
  private removeSession(sessionPath: string): void {
    const rec = [...this.supervisor.trees.values()].find((t) => t.sessionPath === sessionPath);
    // A live pi may briefly rotate or defer its file. Its exit or a later add
    // event will settle the final state.
    if (rec?.agent?.isRunning) return;
    const treeId = rec?.treeId ?? treeBySessionPath(this.db, sessionPath)?.tree_id;
    if (!treeId) return;
    this.supervisor.trees.delete(treeId);
    deleteTree(this.db, treeId);
    this.broadcast({ t: "forest_update", remove: [treeId] });
    log(`removed missing session ${sessionPath}`);
  }

  /**
   * An extension said hello: bind its session file to the tree record of the
   * pi process we spawned (provisional treeId from env), reconciling identity
   * with any record the file watcher created first for the same session path.
   */
  private async claimSession(
    envTreeId: string,
    hello: ExtensionHello,
  ): Promise<TreeRecord | undefined> {
    const rec = await this.claimSessionInner(envTreeId, hello);
    // A live pi on an archived tree would be a working agent hidden from the
    // forest — an extension claiming a session always un-archives it.
    if (rec?.archived) {
      rec.archived = false;
      this.supervisor.notify(rec);
    }
    return rec;
  }

  private async claimSessionInner(
    envTreeId: string,
    hello: ExtensionHello,
  ): Promise<TreeRecord | undefined> {
    const spawned = this.supervisor.trees.get(envTreeId);
    const sessionPath = hello.sessionPath;
    if (!sessionPath) return spawned;

    if (spawned) {
      // Absorb any watcher-created dormant duplicate for the same file.
      const dup = [...this.supervisor.trees.values()].find(
        (t) => t !== spawned && t.sessionPath === sessionPath && !t.agent,
      );
      if (dup) {
        this.supervisor.trees.delete(dup.treeId);
        this.broadcast({ t: "forest_update", remove: [dup.treeId] });
      }
      spawned.sessionPath = sessionPath;
      const dbId = (await this.ingest(sessionPath, spawned.treeId))?.treeId;
      // ingest() found rec by sessionPath === spawned, so identity only diverges
      // when the DB already had a row (watcher won the race): adopt the DB id.
      const row = this.db
        .prepare("SELECT tree_id FROM trees WHERE session_path = ?")
        .get(sessionPath) as { tree_id: string } | undefined;
      const canonical = row?.tree_id ?? dbId ?? spawned.treeId;
      // Never adopt an identity another live agent already owns — two pi
      // processes claiming one session path must stay separate records.
      const owner = canonical !== spawned.treeId ? this.supervisor.trees.get(canonical) : undefined;
      if (canonical !== spawned.treeId && !owner?.agent?.isRunning) {
        this.supervisor.trees.delete(spawned.treeId);
        this.broadcast({ t: "forest_update", remove: [spawned.treeId] });
        spawned.treeId = canonical;
        this.supervisor.trees.set(canonical, spawned);
        this.supervisor.setStatus(spawned, spawned.status);
      }
      return spawned;
    }

    // No spawned record (e.g. daemon restarted under a live pi): fall back to
    // the session-path record.
    return this.ingest(sessionPath);
  }

  broadcast(msg: DaemonToClient): void {
    for (const c of this.clients) c.wire.send(msg);
  }

  async listen(path = socketPath()): Promise<void> {
    ensurePinesHome();
    if (existsSync(path)) {
      // Unlinking a *live* socket does not fail — it silently steals the path
      // and leaves the previous daemon running headless, still holding its
      // ptys, its session watcher, and a writable handle on the same SQLite
      // file. Probe before removing; only a socket with no listener is stale.
      if (await isServerListening(path)) {
        throw new Error(
          `another pines daemon is already listening on ${path} (pid ${readDaemonPid() ?? "unknown"}) — run 'pines kill' first`,
        );
      }
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
    this.server = createServer((sock) => this.onConnection(new Wire(sock)));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(path, resolve);
    });
    writeDaemonPid();
    this.watcher = watchSessions((file) => void this.ingest(file), {
      onUnlink: (file) => this.removeSession(file),
    });
    log(`daemon listening on ${path} (pid ${process.pid})`);
  }

  private onConnection(wire: Wire): void {
    let role: "client" | "extension" | undefined;
    let client: ClientConn | undefined;
    // Set when we rejected the handshake but are still willing to accept the
    // one message that must never depend on protocol agreement: shutdown.
    let rejected = false;

    wire.on("error", (err) => log(`conn error: ${err.message}`));
    wire.on("close", () => {
      if (client) {
        this.clients.delete(client);
        log(`client disconnected (${this.clients.size} remain)`);
      }
    });

    wire.on("msg", (raw) => {
      if (rejected) {
        // A rejected connection gets exactly one useful verb. Without this, a
        // daemon running stale code cannot be stopped by the very command its
        // own error message recommends.
        if ((raw as { t?: string }).t === "shutdown") {
          log("shutdown requested by version-mismatched client");
          void this.shutdown();
          return;
        }
        wire.end();
        return;
      }
      if (role === undefined) {
        if (!isHello(raw)) {
          wire.send({ t: "hello_err", reason: "other", message: "first message must be hello" });
          wire.end();
          return;
        }
        if (raw.protocolVersion !== PROTOCOL_VERSION) {
          wire.send({
            t: "hello_err",
            reason: "version",
            serverProtocolVersion: PROTOCOL_VERSION,
            daemonPid: process.pid,
          });
          // Deliberately not end()ing: give the peer a grace window to ask for
          // shutdown. Ending here also meant the *next* already-buffered frame
          // tried to write to a closed wire ("write after end" in the log).
          rejected = true;
          setTimeout(() => wire.end(), REJECTED_GRACE_MS).unref?.();
          return;
        }
        role = raw.role;
        if (role === "client") {
          const hello = raw as { cols?: number; rows?: number };
          client = {
            wire,
            cols: hello.cols ?? 80,
            rows: hello.rows ?? 24,
            attached: new Set(),
          };
          this.clients.add(client);
          wire.send({
            t: "hello_ok",
            protocolVersion: PROTOCOL_VERSION,
            daemonPid: process.pid,
            piVersion: this.piVersion,
            daemonVersion: pinesVersion(),
            forest: this.supervisor.forest(),
          });
          const build = (raw as { buildVersion?: string }).buildVersion;
          if (build !== undefined && build !== pinesVersion()) {
            log(`client build ${build} differs from daemon build ${pinesVersion()}`);
          }
          log(`client connected (${this.clients.size} total)`);
        } else {
          this.extBridge.handle(wire, raw as ExtensionToDaemon);
        }
        return;
      }

      if (role === "client" && client) {
        this.routeClient(client, raw as ClientToDaemon).catch((err) => {
          log(`client msg error: ${err instanceof Error ? err.stack : String(err)}`);
        });
      } else {
        if (!this.extBridge.handle(wire, raw as ExtensionToDaemon)) {
          log(`extension msg (unhandled): ${JSON.stringify(raw).slice(0, 200)}`);
        }
      }
    });
  }

  private async routeClient(client: ClientConn, msg: ClientToDaemon): Promise<void> {
    switch (msg.t) {
      case "spawn_tree":
        return this.handleSpawn(client, msg);
      case "resume_tree":
        return this.handleResume(client, msg);
      case "attach":
        return this.handleAttach(client, msg);
      case "input": {
        const rec = this.supervisor.trees.get(msg.treeId);
        rec?.agent?.write(Buffer.from(msg.data, "base64").toString("utf8"));
        return;
      }
      case "resize": {
        const rec = this.supervisor.trees.get(msg.treeId);
        rec?.agent?.resize(msg.cols, msg.rows);
        return;
      }
      case "detach":
        client.attached.delete(msg.treeId);
        return;
      case "ack_seen":
        this.supervisor.ackSeen(msg.treeId);
        return;
      case "kill_agent":
        this.supervisor.killAgent(msg.treeId);
        return;
      case "branch":
        return this.handleBranch(client, msg);
      case "search":
        return this.handleSearch(client, msg);
      case "similar":
        return this.handleSimilar(client, msg);
      case "get_tree":
        return this.handleGetTree(client, msg);
      case "rename_tree":
        return this.handleRename(client, msg);
      case "set_label":
        return this.handleSetLabel(client, msg);
      case "set_archived":
        return this.handleSetArchived(client, msg);
      case "relayout":
        this.semantic.refit();
        client.wire.send({ t: "result", re: msg.id, ok: true });
        return;
      case "shutdown":
        log("shutdown requested by client");
        await this.shutdown();
        return;
      case "hello":
        return; // duplicate hello — ignore
    }
  }

  private fail(client: ClientConn, id: string, err: unknown): void {
    client.wire.send({
      t: "result",
      re: id,
      ok: false,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  private async handleSpawn(client: ClientConn, msg: SpawnTreeMsg): Promise<void> {
    if (!existsSync(msg.cwd)) {
      return this.fail(client, msg.id, `cwd does not exist: ${msg.cwd}`);
    }
    try {
      const rec = this.supervisor.spawnAgent({
        cwd: msg.cwd,
        // No directory-name fallback: the first prompt becomes the title on
        // ingest; until then clients render the cwd dimmed as a placeholder.
        name: msg.name,
        prompt: msg.prompt,
        cols: client.cols,
        rows: client.rows,
      });
      // Place the new tree immediately — don't wait for its session file to
      // appear on disk before it shows up in the forest.
      this.assignPositions();
      client.wire.send({ t: "result", re: msg.id, ok: true, newTreeId: rec.treeId });
    } catch (err) {
      this.fail(client, msg.id, err);
    }
  }

  private async handleResume(client: ClientConn, msg: ResumeTreeMsg): Promise<void> {
    const rec = this.supervisor.trees.get(msg.treeId);
    if (!rec) return this.fail(client, msg.id, "unknown tree");
    // Resuming mid-eviction must not race the dying pi: it is flushing the
    // very session file the successor would reopen, and two writers on one
    // JSONL is how sessions tear. The pipeline is bounded (SIGTERM → SIGKILL
    // backstop → reconcile), so wait it out rather than failing the resume.
    if (rec.evicting) {
      const settled = await this.supervisor.awaitEviction(rec);
      if (!settled) return this.fail(client, msg.id, "agent is still shutting down — try again");
    }
    if (rec.agent?.isRunning && !rec.evicting) {
      client.wire.send({ t: "result", re: msg.id, ok: true, newTreeId: rec.treeId });
      return;
    }
    if (!rec.sessionPath || !rec.cwd) {
      return this.fail(client, msg.id, "tree has no session file");
    }
    if (!existsSync(rec.cwd)) {
      // Spawning in a missing directory fails opaquely inside node-pty;
      // detect it here so the user learns the actual reason.
      return this.fail(client, msg.id, `cwd no longer exists: ${rec.cwd} (project moved or deleted?)`);
    }
    try {
      this.supervisor.spawnAgent({
        cwd: rec.cwd,
        sessionPath: rec.sessionPath,
        existing: rec,
        cols: client.cols,
        rows: client.rows,
      });
      client.wire.send({ t: "result", re: msg.id, ok: true, newTreeId: rec.treeId });
    } catch (err) {
      this.fail(client, msg.id, err);
    }
  }

  private async handleAttach(client: ClientConn, msg: AttachMsg): Promise<void> {
    const rec = this.supervisor.trees.get(msg.treeId);
    // Evicting counts as not-live: handing out a snapshot of a dying
    // terminal reports success and then the screen just stops.
    if (!rec?.agent?.isRunning || rec.evicting) {
      const why =
        rec?.lastExitCode != null && rec.lastExitCode !== 0
          ? `agent crashed (exit ${rec.lastExitCode}) — see ${daemonLogPath()}`
          : "no live agent for tree";
      return this.fail(client, msg.id, why);
    }
    client.cols = msg.cols;
    client.rows = msg.rows;
    rec.agent.resize(msg.cols, msg.rows);
    const snapshot = await rec.agent.snapshot();
    client.attached.add(msg.treeId);
    client.wire.send({
      t: "attach_ok",
      re: msg.id,
      snapshot: Buffer.from(snapshot, "utf8").toString("base64"),
      cols: rec.agent.cols,
      rows: rec.agent.rows,
    });
    this.supervisor.ackSeen(msg.treeId);
  }

  private async handleGetTree(client: ClientConn, msg: GetTreeMsg): Promise<void> {
    const rec = this.supervisor.trees.get(msg.treeId);
    if (!rec?.sessionPath) return this.fail(client, msg.id, "tree has no session file");
    try {
      const parsed = await parseSessionFile(rec.sessionPath);
      const detail = toTreeDetail(rec.treeId, parsed);
      // Same rule as ingest: extension leaf wins only while idle — a running
      // agent's leaf is wherever the file just grew to.
      if (rec.extensionConnected && rec.leafId && rec.status !== "running") {
        detail.leafId = rec.leafId;
      }
      client.wire.send({ t: "result", re: msg.id, ok: true, tree: detail });
    } catch (err) {
      this.fail(client, msg.id, err);
    }
  }

  private async handleRename(client: ClientConn, msg: RenameTreeMsg): Promise<void> {
    const rec = this.supervisor.trees.get(msg.treeId);
    if (!rec) return this.fail(client, msg.id, "unknown tree");
    if (rec.agent?.isRunning && this.extBridge.hasExtension(rec.treeId)) {
      const res = await this.extBridge.command(rec.treeId, {
        op: "set_session_name",
        name: msg.name,
      });
      if (!res.ok) return this.fail(client, msg.id, res.err);
    } else if (rec.sessionPath) {
      // Dormant: daemon may write via pi's SDK (ownership rule).
      try {
        const { SessionManager } = await import("@earendil-works/pi-coding-agent");
        SessionManager.open(rec.sessionPath).appendSessionInfo(msg.name);
      } catch (err) {
        return this.fail(client, msg.id, err);
      }
    } else {
      return this.fail(client, msg.id, "tree has no session file");
    }
    rec.name = msg.name;
    this.supervisor.notify(rec);
    client.wire.send({ t: "result", re: msg.id, ok: true });
  }

  /**
   * Fork-point fallback for sessions forked outside pines: the deepest entry
   * of the child that also exists in the parent (ids are preserved on copy).
   * Persisted to graft_parents so it computes once.
   */
  private async computeForkPoint(rec: TreeRecord, parsed: ParsedSession): Promise<void> {
    const parentPath = rec.parentSessionPath;
    if (!parentPath || !existsSync(parentPath)) return;
    try {
      const parent = await parseSessionFile(parentPath);
      const parentIds = new Set(parent.order);
      for (let i = parsed.order.length - 1; i >= 0; i--) {
        const id = parsed.order[i]!;
        if (parentIds.has(id)) {
          rec.parentEntryId = id;
          this.db
            .prepare(
              `INSERT INTO graft_parents (tree_id, parent_session_path, parent_entry_id, ordinal)
               VALUES (?, ?, ?, 0)
               ON CONFLICT(tree_id, ordinal) DO UPDATE SET
                 parent_session_path = excluded.parent_session_path,
                 parent_entry_id = excluded.parent_entry_id`,
            )
            .run(rec.treeId, parentPath, id);
          this.supervisor.notify(rec);
          return;
        }
      }
    } catch {
      /* parent unreadable — chips fall back to end-of-session anchoring */
    }
  }

  /** In-place navigations deferred behind busy agents (treeId → nodeId). */
  private readonly pendingNav = new Map<string, string>();

  /** Run a deferred navigation once its agent settles to idle. */
  private async runPendingNav(treeId: string): Promise<void> {
    const nodeId = this.pendingNav.get(treeId);
    if (!nodeId) return;
    this.pendingNav.delete(treeId);
    const rec = this.supervisor.trees.get(treeId);
    if (!rec?.agent?.isRunning) return;
    const name = rec.name ?? treeId;
    const res = await this.extBridge.command(treeId, { op: "navigate_tree", targetId: nodeId });
    if (res.ok) {
      rec.agent.write("\r");
      this.broadcast({ t: "toast", level: "info", text: `${name}: continued from the requested node` });
      log(`ran queued navigation for ${treeId} → ${nodeId}`);
    } else {
      this.broadcast({
        t: "toast",
        level: "info",
        text: `${name}: couldn't move to the requested node (${res.err})`,
      });
    }
  }

  private branchDeps(): BranchDeps {
    return {
      supervisor: this.supervisor,
      extBridge: this.extBridge,
      queueNav: (treeId, nodeId) => this.pendingNav.set(treeId, nodeId),
      ingest: (sessionPath, preferredTreeId) => this.ingest(sessionPath, preferredTreeId),
      setGraftParent: (treeId, parentSessionPath, parentEntryId) => {
        const rec = this.supervisor.trees.get(treeId);
        if (rec) rec.parentEntryId = parentEntryId;
        this.db
          .prepare(
            `INSERT INTO graft_parents (tree_id, parent_session_path, parent_entry_id, ordinal)
             VALUES (?, ?, ?, 0)
             ON CONFLICT(tree_id, ordinal) DO UPDATE SET
               parent_session_path = excluded.parent_session_path,
               parent_entry_id = excluded.parent_entry_id`,
          )
          .run(treeId, parentSessionPath, parentEntryId);
      },
      log,
    };
  }

  protected async handleBranch(client: ClientConn, msg: BranchMsg): Promise<void> {
    const rec = this.supervisor.trees.get(msg.treeId);
    if (!rec) return this.fail(client, msg.id, "unknown tree");
    const res =
      msg.mode === "in-place"
        ? await branchInPlace(this.branchDeps(), rec, msg.nodeId)
        : await branchToNewTree(this.branchDeps(), rec, msg.nodeId, {
            spawn: msg.spawn ?? false,
            cols: client.cols,
            rows: client.rows,
          });
    client.wire.send({
      t: "result",
      re: msg.id,
      ok: res.ok,
      err: res.err,
      note: res.note,
      newTreeId: res.newTreeId,
    });
  }

  protected async handleSearch(client: ClientConn, msg: SearchMsg): Promise<void> {
    const hits = searchFts(this.db, msg.query, 40, msg.treeId);
    const mapped: SearchHit[] = hits.map((h) => ({
      treeId: h.tree_id,
      entryId: h.entry_id,
      kind: h.kind as SearchHit["kind"],
      snippet: h.snippet,
      rank: h.rank,
    }));
    client.wire.send({ t: "result", re: msg.id, ok: true, hits: mapped });
  }

  protected async handleSetArchived(client: ClientConn, msg: SetArchivedMsg): Promise<void> {
    const rec = this.supervisor.trees.get(msg.treeId);
    if (!rec) return this.fail(client, msg.id, "unknown tree");
    if (msg.archived && rec.agent?.isRunning) {
      return this.fail(client, msg.id, "tree has a live agent — kill it first");
    }
    if (rec.archived !== msg.archived) {
      rec.archived = msg.archived;
      this.supervisor.notify(rec); // persist + broadcast
    }
    client.wire.send({ t: "result", re: msg.id, ok: true });
  }

  protected async handleSimilar(client: ClientConn, msg: SimilarMsg): Promise<void> {
    // A tree with no embedding yet is not an error — the model may still be
    // warming (or unavailable); the client renders the empty list accordingly.
    const rows = similarTrees(this.db, msg.treeId, msg.k ?? 8);
    const similar: SimilarHit[] = rows.map((r) => ({ treeId: r.tree_id, score: r.score }));
    client.wire.send({ t: "result", re: msg.id, ok: true, similar });
  }

  protected async handleSetLabel(client: ClientConn, msg: SetLabelMsg): Promise<void> {
    const rec = this.supervisor.trees.get(msg.treeId);
    if (!rec) return this.fail(client, msg.id, "unknown tree");
    const res = await setNodeLabel(this.branchDeps(), rec, msg.nodeId, msg.label);
    client.wire.send({ t: "result", re: msg.id, ok: res.ok, err: res.err });
  }

  async shutdown(): Promise<void> {
    // SIGTERM and a client `shutdown` can arrive together; tearing the
    // supervisor down twice is not safe.
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log("daemon shutting down");
    await this.watcher?.close();
    await this.semantic.dispose();
    await this.supervisor.shutdown();
    for (const c of this.clients) c.wire.end();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    const path = socketPath();
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
    clearDaemonPid();
    process.exit(0);
  }
}

export async function runServer(): Promise<void> {
  const daemon = new Daemon();
  process.on("SIGTERM", () => void daemon.shutdown());
  process.on("SIGINT", () => void daemon.shutdown());
  process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err.message}`));
  process.on("unhandledRejection", (err) => log(`unhandled rejection: ${String(err)}`));
  try {
    await daemon.listen();
  } catch (err) {
    // Losing the race to another daemon is a normal outcome, not a crash: exit
    // quietly and leave the incumbent — and its running agents — alone.
    const message = err instanceof Error ? err.message : String(err);
    log(`refusing to start: ${message}`);
    process.stderr.write(`pines: ${message}\n`);
    process.exit(1);
  }
  // Keep the process alive forever; the socket server holds the loop open.
}

export type { TreeStatus };
