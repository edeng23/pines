/** One-shot CLI subcommands: spawn, status, kill. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DaemonClient, staleDaemonMessage } from "./daemon-client.js";
import {
  isProcessAlive,
  isServerListening,
  readDaemonPid,
  requestDaemonShutdown,
  terminateDaemon,
} from "../daemon/lifecycle.js";
import { daemonPidPath } from "../shared/paths.js";

/** Say so when the daemon answering us is not the build that was installed. */
function warnIfStale(client: DaemonClient): void {
  if (client.build.stale) process.stderr.write(`pines: ${staleDaemonMessage(client.build)}\n`);
}

function parseFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 0) flags.set("_", positional.join(" "));
  return flags;
}

export async function spawnCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const cwd = resolve(String(flags.get("cwd") ?? process.cwd()));
  if (!existsSync(cwd)) {
    process.stderr.write(`spawn failed: cwd does not exist: ${cwd}\n`);
    process.exitCode = 1;
    return;
  }
  const name = flags.get("name") ? String(flags.get("name")) : undefined;
  const prompt =
    (flags.get("prompt") ? String(flags.get("prompt")) : undefined) ??
    (flags.get("_") ? String(flags.get("_")) : undefined);

  const client = await DaemonClient.connect({ cols: 80, rows: 24 });
  const res = await client.request({ t: "spawn_tree", id: client.rid(), cwd, name, prompt });
  if (res.ok && "newTreeId" in res) {
    process.stdout.write(`spawned ${res.newTreeId} in ${cwd}\n`);
  } else {
    process.stderr.write(`spawn failed: ${"err" in res ? res.err : "unknown error"}\n`);
    // A failure from a stale daemon is a failure from code that was already
    // fixed — say so here, where the error the user reads is printed.
    warnIfStale(client);
    process.exitCode = 1;
  }
  client.close();
}

export async function statusCommand(): Promise<void> {
  if (!(await isServerListening())) {
    process.stdout.write("daemon: not running\n");
    return;
  }
  const client = await DaemonClient.connect({ cols: 80, rows: 24 });
  const { forest, daemonPid, daemonVersion } = client.helloOk;
  const build = daemonVersion ? ` pines ${daemonVersion},` : "";
  process.stdout.write(`daemon: running (pid ${daemonPid}),${build} ${forest.length} tree(s)\n`);
  warnIfStale(client);
  for (const t of forest) {
    const agent = t.live ? "agent:live" : "         ";
    const name = t.name ?? t.treeId;
    const tags = t.archived ? "  [archived]" : "";
    process.stdout.write(
      `  ${t.treeId}  ${t.status.padEnd(9)} ${agent} ${name}${tags}${t.cwd ? `  (${t.cwd})` : ""}\n`,
    );
  }
  client.close();
}

export async function killCommand(): Promise<void> {
  const listening = await isServerListening();
  // A daemon that lost its socket (or never bound one) is still a daemon: it
  // holds ptys, watches sessions, and writes to the same database.
  const recordedPid = readDaemonPid();
  if (!listening && recordedPid === undefined) {
    process.stdout.write("daemon: not running\n");
    return;
  }

  let pid = recordedPid;
  if (listening) {
    const { closed, daemonPid } = await requestDaemonShutdown();
    pid = daemonPid ?? pid;
    // The socket closing only proves the connection ended — the daemon may
    // have rejected our handshake and hung up. Confirm it is really gone.
    if (closed && (pid === undefined || !isProcessAlive(pid))) {
      if (!(await isServerListening())) {
        process.stdout.write("daemon stopped\n");
        return;
      }
    }
  }

  if (pid === undefined) {
    process.stderr.write(
      "pines: daemon did not respond to shutdown and its pid is unknown " +
        `(no ${daemonPidPath()}) — find it with 'ps' and kill it manually\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`daemon did not shut down cleanly; sending SIGTERM to ${pid}\n`);
  if (await terminateDaemon(pid)) {
    process.stdout.write("daemon stopped\n");
    return;
  }
  process.stderr.write(`pines: daemon ${pid} is still running after SIGTERM\n`);
  process.exitCode = 1;
}
