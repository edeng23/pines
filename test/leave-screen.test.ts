/**
 * Integration: the two peek-and-leave paths added to the wire.
 *  - leave: the (fake) extension swallows a plain ← on an empty editor and the
 *    daemon tells ONLY the attached clients to step out; text in the editor
 *    keeps ← as ordinary input.
 *  - screen: a live agent's visible screen as cropped styled lines, with no
 *    attach, no resize and no "seen" side effect; dormant trees refuse.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";
import { visibleLength } from "../src/client/ansi.js";
import { branchedSession } from "./fixtures/sessions.js";
import { FAKE_PI, startDaemon, waitFor } from "./fixtures/daemon.js";

let home: string;
let sessionsRoot: string;
let fixtureSession: string;
let dormantSession: string;
let daemon: ChildProcess;
let sockPath: string;

type Msg = Record<string, unknown>;

function connectClient(cols = 100, rows = 30): Promise<{ wire: Wire; sock: Socket; inbox: Msg[] }> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    sock.once("error", reject);
    const inbox: Msg[] = [];
    const wire = new Wire(sock);
    wire.on("msg", (m) => inbox.push(m as Msg));
    sock.once("connect", () => {
      wire.send({ t: "hello", role: "client", protocolVersion: PROTOCOL_VERSION, cols, rows });
      resolve({ wire, sock, inbox });
    });
  });
}

const upserts = (inbox: Msg[]): Msg[] =>
  inbox.filter((m) => m.t === "forest_update").flatMap((m) => (m.upsert as Msg[] | undefined) ?? []);
const reply = (inbox: Msg[], re: string) => waitFor(() => inbox.find((m) => m.re === re), 8000, `reply ${re}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-leave-"));
  sessionsRoot = join(home, "pi-sessions");
  const dir = join(sessionsRoot, "--tmp-proj--");
  mkdirSync(dir, { recursive: true });
  fixtureSession = join(dir, "2026-01-01T00-00-00-000Z_11111111.jsonl");
  writeFileSync(fixtureSession, branchedSession("/tmp/proj").content);
  dormantSession = join(dir, "2026-01-02T00-00-00-000Z_22222222.jsonl");
  writeFileSync(dormantSession, branchedSession("/tmp/proj").content);

  chmodSync(FAKE_PI, 0o755);
  const started = await startDaemon({
    home,
    env: {
      PINES_PI_BIN: FAKE_PI,
      PINES_PI_SESSIONS: sessionsRoot,
      FAKE_PI_EXT: "1",
      FAKE_PI_SESSION: fixtureSession,
    },
  });
  daemon = started.proc;
  sockPath = started.sockPath;
});

afterAll(() => {
  daemon?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

describe("leave and screen over the wire", () => {
  it("← on an empty editor reaches only attached clients as `leave`; text keeps ← as input", async () => {
    const a = await connectClient();
    const bystander = await connectClient();
    await waitFor(() => a.inbox.find((m) => m.t === "hello_ok"), 5000, "hello_ok");
    await waitFor(() => bystander.inbox.find((m) => m.t === "hello_ok"), 5000, "hello_ok");

    a.wire.send({ t: "spawn_tree", id: "s1", cwd: home });
    expect((await reply(a.inbox, "s1")).ok).toBe(true);
    // The fake extension binds the fixture session and settles to waiting.
    const settled = await waitFor(
      () => upserts(a.inbox).find((t) => t.sessionPath === fixtureSession && t.status === "waiting"),
      8000,
      "settled",
    );
    const treeId = settled.treeId as string;

    a.wire.send({ t: "attach", id: "at1", treeId, cols: 100, rows: 29 });
    const attached = await reply(a.inbox, "at1");
    expect(attached.t).toBe("attach_ok");

    // Plain ← with nothing typed: the extension reports leave, the daemon
    // relays it to the attached client and nobody else.
    a.wire.send({ t: "input", treeId, data: b64("\x1b[D") });
    const leave = await waitFor(() => a.inbox.find((m) => m.t === "leave"), 5000, "leave");
    expect(leave.treeId).toBe(treeId);
    await sleep(200);
    expect(bystander.inbox.some((m) => m.t === "leave")).toBe(false);

    // With text in the editor ← is pi's: no leave, and the line still submits.
    const before = a.inbox.filter((m) => m.t === "leave").length;
    a.wire.send({ t: "input", treeId, data: b64("abc") });
    await sleep(50);
    a.wire.send({ t: "input", treeId, data: b64("\x1b[D") });
    await sleep(300);
    expect(a.inbox.filter((m) => m.t === "leave").length).toBe(before);
    a.wire.send({ t: "input", treeId, data: b64("\r") });
    await waitFor(
      () =>
        a.inbox.some(
          (m) =>
            m.t === "output" &&
            Buffer.from(m.data as string, "base64").toString("utf8").includes("echo:abc\x1b[D"),
        )
          ? true
          : undefined,
      5000,
      "echo of the typed line including the arrow bytes",
    );

    a.wire.send({ t: "detach", treeId });
    a.sock.destroy();
    bystander.sock.destroy();
  });

  it("screen returns the live agent's visible rows cropped to `cols`, without attaching", async () => {
    const c = await connectClient();
    await waitFor(() => c.inbox.find((m) => m.t === "hello_ok"), 5000, "hello_ok");
    // The previous test's agent is still live; it arrives in the hello forest.
    const tree = await waitFor(
      () => {
        const hello = c.inbox.find((m) => m.t === "hello_ok");
        const all = [...((hello?.forest as Msg[] | undefined) ?? []), ...upserts(c.inbox)];
        return all.find((t) => t.sessionPath === fixtureSession && t.live === true);
      },
      5000,
      "live tree",
    );
    const treeId = tree.treeId as string;

    c.wire.send({ t: "screen", id: "sc1", treeId, cols: 24 });
    const res = await reply(c.inbox, "sc1");
    expect(res.ok).toBe(true);
    const lines = res.screen as string[];
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(text).toContain("FAKE-PI READY");
    for (const l of lines) {
      expect(visibleLength(l)).toBeLessThanOrEqual(24);
      expect(l).not.toMatch(/\x1b\[[0-9;]*[A-Za-ln-z]/); // SGR only, no cursor moves
    }
    // The banner is bold in the fake's output; styling survives as plain SGR.
    expect(lines.some((l) => /\x1b\[0;1m/.test(l))).toBe(true);
    // Peeking is not attaching: no output stream follows, no attach_ok.
    await sleep(400);
    expect(c.inbox.some((m) => m.t === "output")).toBe(false);
    c.sock.destroy();
  });

  it("screen refuses a tree with no live agent", async () => {
    const c = await connectClient();
    await waitFor(() => c.inbox.find((m) => m.t === "hello_ok"), 5000, "hello_ok");
    const dormant = await waitFor(
      () => {
        const hello = c.inbox.find((m) => m.t === "hello_ok");
        const all = [...((hello?.forest as Msg[] | undefined) ?? []), ...upserts(c.inbox)];
        return all.find((t) => t.sessionPath === dormantSession);
      },
      10_000,
      "dormant tree discovered",
    );
    c.wire.send({ t: "screen", id: "sc2", treeId: dormant.treeId as string, cols: 40 });
    const res = await reply(c.inbox, "sc2");
    expect(res.ok).toBe(false);
    expect(String(res.err)).toContain("no live agent");
    c.sock.destroy();
  });
});
