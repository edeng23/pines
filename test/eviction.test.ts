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
import type { AgentProc, AgentProcOptions } from "../src/daemon/agents.js";

/**
 * Fake pi with configurable death semantics:
 * - "sync":   kill() exits on the spot (the simplest tests);
 * - "manual": kill() queues the exit until flush() — a real SIGTERM window,
 *             held open as long as the test wants;
 * - "never":  kill() is ignored — a wedged pty whose exit never arrives.
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
      kill() {
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

describe("LRU agent eviction", () => {
  let supervisor: Supervisor;

  afterEach(async () => {
    vi.useRealTimers();
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
