/**
 * LRU eviction: the live-agent slots are a warm cache of instantly
 * attachable sessions. A spawn at the cap puts the least-recently-active
 * waiting agent to sleep instead of failing; working and attached agents
 * are untouchable, and an unseen result keeps its attention flag through
 * eviction. Daemon shutdown rides the same path, so a restart never turns
 * already-read work into attention dots.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_LIVE_AGENTS, Supervisor, type TreeRecord } from "../src/daemon/supervisor.js";
import { ExtBridge } from "../src/daemon/extbridge.js";
import type { AgentProc, AgentProcOptions } from "../src/daemon/agents.js";
import type { Wire } from "../src/shared/wire.js";

/** Fake AgentProc that also records every signal it was sent. */
interface FakeAgent extends AgentProc {
  signals: string[];
}

/**
 * Fake pi with configurable death semantics:
 * - "sync":   kill() exits on the spot (the simplest tests);
 * - "manual": kill() queues the exit until flush() — a real SIGTERM window,
 *             held open as long as the test wants;
 * - "never":  kill() only records — a wedged pty whose exit never arrives.
 */
function agentFactory(mode: "sync" | "manual" | "never") {
  const pending: Array<() => void> = [];
  const create = (opts: AgentProcOptions): AgentProc => {
    let running = true;
    const exit = () => {
      if (!running) return;
      running = false;
      opts.onExit(0);
    };
    return {
      treeId: opts.treeId,
      pid: 0,
      cols: opts.cols,
      rows: opts.rows,
      signals: [] as string[],
      get isRunning() {
        return running;
      },
      write() {},
      resize() {},
      async snapshot() {
        return "";
      },
      snapshotSync() {
        return "";
      },
      kill(signal = "SIGTERM") {
        this.signals.push(signal);
        if (mode === "sync") exit();
        else if (mode === "manual") pending.push(exit);
      },
      dispose() {},
    } as unknown as AgentProc;
  };
  const flush = () => {
    while (pending.length) pending.shift()!();
  };
  return { create, flush };
}

/** Minimal Wire stand-in: stores handlers, lets tests fire "close". */
function fakeWire() {
  const handlers = new Map<string, () => void>();
  return {
    on(ev: string, cb: () => void) {
      handlers.set(ev, cb);
    },
    send() {},
    emitClose() {
      handlers.get("close")?.();
    },
  } as unknown as Wire & { emitClose: () => void };
}

describe("LRU agent eviction", () => {
  let supervisor: Supervisor;

  afterEach(async () => {
    vi.useRealTimers();
    // Unit teardown: drop the records so shutdown() doesn't spend its 3s
    // deadline waiting on fakes that only die when a test flushes them.
    supervisor.trees.clear();
    await supervisor.shutdown();
  });

  /** Fill every slot, then park each agent as waiting with a staggered age. */
  function fillSlots(): TreeRecord[] {
    const recs: TreeRecord[] = [];
    for (let i = 0; i < DEFAULT_MAX_LIVE_AGENTS; i++) {
      const rec = supervisor.spawnAgent({ cwd: process.cwd(), name: `t${i}` });
      rec.status = "waiting";
      rec.mtime = 1000 + i; // t0 is the least recently active
      recs.push(rec);
    }
    return recs;
  }

  it("evicts the least-recently-active waiting agent to make room", () => {
    supervisor = new Supervisor(agentFactory("sync").create);
    const recs = fillSlots();
    recs[0]!.seen = false; // pure LRU: unseen does not protect a slot

    const fresh = supervisor.spawnAgent({ cwd: process.cwd(), name: "fresh" });

    expect(fresh.agent?.isRunning).toBe(true);
    expect(supervisor.liveCount()).toBe(DEFAULT_MAX_LIVE_AGENTS);
    // The oldest went quietly dormant…
    const evicted = recs[0]!;
    expect(evicted.agent).toBeUndefined();
    expect(evicted.status).toBe("dormant");
    expect(evicted.evicting).toBe(false);
    // …with no crash verdict, no attention reset, and its age intact.
    expect(evicted.lastExitCode).toBeNull();
    expect(evicted.seen).toBe(false); // the unseen result still wants eyes
    expect(evicted.mtime).toBe(1000);
    // Its neighbors kept their slots.
    expect(recs[1]!.agent?.isRunning).toBe(true);
  });

  it("never evicts a working or attached agent, and fails when nothing is idle", () => {
    supervisor = new Supervisor(agentFactory("sync").create);
    const recs = fillSlots();
    // Everyone is busy except the two oldest; the very oldest is attached.
    for (const rec of recs.slice(2)) rec.status = "running";
    supervisor.isAttachedCheck = (treeId) => treeId === recs[0]!.treeId;

    // The attached one survives; the second-oldest idle agent goes.
    supervisor.spawnAgent({ cwd: process.cwd(), name: "fresh" });
    expect(recs[0]!.agent?.isRunning).toBe(true);
    expect(recs[1]!.status).toBe("dormant");

    // Now nothing is idle at all: the spawn fails like it always did.
    expect(() => supervisor.spawnAgent({ cwd: process.cwd(), name: "one-too-many" })).toThrow(
      /working or attached/,
    );
  });

  it("evicts exactly one victim per burst spawn while the deaths are in flight", () => {
    // Real SIGTERM semantics: victims keep running until flushed. The cap
    // bounds slots, not corpses — processes may transiently overshoot
    // (documented in liveActive), but each spawn claims a distinct victim
    // and nothing is double-evicted.
    const fake = agentFactory("manual");
    supervisor = new Supervisor(fake.create);
    const recs = fillSlots();

    for (let i = 0; i < 3; i++) supervisor.spawnAgent({ cwd: process.cwd(), name: `burst${i}` });

    const evicting = recs.filter((r) => r.evicting);
    expect(evicting.map((r) => r.name)).toEqual(["t0", "t1", "t2"]); // LRU order, no repeats
    // Transient overshoot: 12 slot-holders + 3 dying victims.
    expect(supervisor.liveCount()).toBe(DEFAULT_MAX_LIVE_AGENTS + 3);
    // Their tips report not-live already: nobody is invited to attach.
    for (const r of evicting) expect(supervisor.summary(r).live).toBe(false);

    fake.flush(); // the SIGTERMs land
    expect(supervisor.liveCount()).toBe(DEFAULT_MAX_LIVE_AGENTS);
    for (const r of recs.slice(0, 3)) {
      expect(r.status).toBe("dormant");
      expect(r.evicting).toBe(false);
    }
  });

  it("reconciles a wedged eviction instead of leaking the slot forever", () => {
    vi.useFakeTimers();
    supervisor = new Supervisor(agentFactory("never").create);
    const recs = fillSlots();

    supervisor.spawnAgent({ cwd: process.cwd(), name: "fresh" });
    const victim = recs[0]!;
    expect(victim.evicting).toBe(true);
    expect(victim.agent?.isRunning).toBe(true); // SIGTERM ignored, exit never fires

    vi.advanceTimersByTime(3_100); // SIGKILL backstop (also ignored)
    vi.advanceTimersByTime(3_100); // reconciliation forces the record dormant
    expect(victim.evicting).toBe(false);
    expect(victim.status).toBe("dormant");
    expect(victim.agent).toBeUndefined();
    expect(victim.lastExitCode).toBeNull();
  });

  it("SIGKILLs an orphaned victim even after a resume moves the record on", () => {
    // The backstop is scoped to the agent, not the record: a resume during
    // the death window replaces rec.agent, but the SIGTERM'd process must
    // still be driven to SIGKILL — and the successor's record left alone.
    vi.useFakeTimers();
    supervisor = new Supervisor(agentFactory("never").create);
    const recs = fillSlots();

    supervisor.spawnAgent({ cwd: process.cwd(), name: "fresh" }); // evicts t0
    const victim = recs[0]!;
    const orphan = victim.agent as FakeAgent;
    expect(victim.evicting).toBe(true);

    // Resume-mid-eviction: a fresh agent takes over the record.
    supervisor.spawnAgent({ cwd: process.cwd(), existing: victim });
    expect(victim.evicting).toBe(false);
    expect(victim.agent).not.toBe(orphan);

    vi.advanceTimersByTime(3_100);
    expect(orphan.signals).toEqual(["SIGTERM", "SIGKILL"]); // the orphan still dies
    vi.advanceTimersByTime(3_100); // reconcile window passes…
    // …without reaping the successor: the record stays the new agent's.
    // (Status may read "waiting" here — the quiet-PTY fallback demotes a
    // silent fake under fake timers — the invariant is it never went dormant.)
    expect(victim.status).not.toBe("dormant");
    expect(victim.agent).not.toBe(orphan);
    expect(victim.agent?.isRunning).toBe(true);
  });

  it("awaitEviction settles when the victim dies and times out on a wedged one", async () => {
    const fake = agentFactory("manual");
    supervisor = new Supervisor(fake.create);
    const recs = fillSlots();

    supervisor.spawnAgent({ cwd: process.cwd(), name: "fresh" }); // evicts t0
    const wait = supervisor.awaitEviction(recs[0]!, 2000);
    fake.flush(); // SIGTERM lands
    expect(await wait).toBe(true);
    expect(recs[0]!.status).toBe("dormant");

    supervisor.spawnAgent({ cwd: process.cwd(), name: "fresh2" }); // evicts t1
    // Nothing flushes this one: the wait must give up, not hang.
    expect(await supervisor.awaitEviction(recs[1]!, 250)).toBe(false);
  });

  it("a stale extension of a replaced agent cannot touch the record", async () => {
    supervisor = new Supervisor(agentFactory("never").create);
    const rec = supervisor.spawnAgent({ cwd: process.cwd(), name: "t" });
    const bridge = new ExtBridge(supervisor, {
      claimSession: async () => rec,
      onSessionActivity: () => {},
      isAttached: () => false,
      log: () => {},
    });
    const hello = (treeId: string) =>
      ({ t: "hello", role: "extension", treeId, sessionId: "s", sessionPath: "/p" }) as never;

    const staleWire = fakeWire();
    bridge.handle(staleWire, hello(rec.treeId));
    await Promise.resolve(); // let the async claim land
    expect(rec.extensionConnected).toBe(true);

    // The agent is replaced (evict + resume); its extension is now stale.
    supervisor.spawnAgent({ cwd: process.cwd(), existing: rec });
    expect(rec.extensionConnected).toBe(false); // fresh process, no ext yet
    const freshWire = fakeWire();
    bridge.handle(freshWire, hello(rec.treeId));
    await Promise.resolve();
    expect(rec.extensionConnected).toBe(true);

    // A late event from the dying pi must not flip the working record…
    rec.status = "running";
    rec.seen = true;
    bridge.handle(staleWire, { t: "ev", type: "agent_settled" } as never);
    expect(rec.status).toBe("running");
    expect(rec.seen).toBe(true);
    // …and its socket close must not strip the successor's leaf authority.
    staleWire.emitClose();
    expect(rec.extensionConnected).toBe(true);
  });

  it("a hello racing its own eviction stamps the predecessor, not the successor", async () => {
    // The claim is slow (full ingest) — slow enough that the pi saying hello
    // can be evicted and replaced before the claim resolves. The stamp is
    // taken synchronously at hello time, so the resolved connection must
    // read as stale and neither mark nor later unmark the successor.
    supervisor = new Supervisor(agentFactory("never").create);
    const rec = supervisor.spawnAgent({ cwd: process.cwd(), name: "t" });
    let releaseClaim!: () => void;
    const gate = new Promise<void>((r) => (releaseClaim = r));
    const bridge = new ExtBridge(supervisor, {
      claimSession: async () => {
        await gate;
        return rec;
      },
      onSessionActivity: () => {},
      isAttached: () => false,
      log: () => {},
    });
    const hello = (treeId: string) =>
      ({ t: "hello", role: "extension", treeId, sessionId: "s", sessionPath: "/p" }) as never;

    const staleWire = fakeWire();
    bridge.handle(staleWire, hello(rec.treeId)); // predecessor's hello, claim in flight

    // Evict + resume while the claim is parked: the record moves on.
    supervisor.spawnAgent({ cwd: process.cwd(), existing: rec });
    const freshWire = fakeWire();
    bridge.handle(freshWire, hello(rec.treeId)); // successor's hello, also parked

    releaseClaim();
    await Promise.resolve();
    await Promise.resolve();

    // The successor's hello connected; the predecessor's resolved as stale.
    expect(rec.extensionConnected).toBe(true);
    staleWire.emitClose(); // and its close cannot strip the successor's flag
    expect(rec.extensionConnected).toBe(true);
  });

  it("daemon shutdown lands agents as quiet dormancy, not unseen work", async () => {
    supervisor = new Supervisor(agentFactory("sync").create);
    const recs = fillSlots(); // status waiting, seen: true (spawn acks)

    await supervisor.shutdown();

    for (const rec of recs) {
      expect(rec.status).toBe("dormant");
      expect(rec.seen).toBe(true); // read work stays read across restarts
      expect(rec.lastExitCode).toBeNull(); // no crash verdict from our own SIGTERM
    }
  });
});
