/**
 * LRU eviction: the live-agent slots are a warm cache of instantly
 * attachable sessions. A spawn at the cap puts the least-recently-active
 * waiting agent to sleep instead of failing; working and attached agents
 * are untouchable, and an unseen result keeps its attention flag through
 * eviction.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_LIVE_AGENTS, Supervisor, type TreeRecord } from "../src/daemon/supervisor.js";
import type { AgentProc, AgentProcOptions } from "../src/daemon/agents.js";

function fakeAgent(opts: AgentProcOptions): AgentProc {
  let running = true;
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
      if (!running) return;
      running = false;
      opts.onExit(0);
    },
    dispose() {},
  } as unknown as AgentProc;
}

describe("LRU agent eviction", () => {
  let supervisor: Supervisor;

  afterEach(async () => {
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
    supervisor = new Supervisor(fakeAgent);
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
    supervisor = new Supervisor(fakeAgent);
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
});
