/**
 * Watch pi's session directories so sessions created outside pines (a user
 * running plain `pi`) appear in the forest automatically, and live sessions'
 * appends get re-ingested.
 */
import chokidar from "chokidar";
import { existsSync } from "node:fs";
import { piSessionsRoot } from "../shared/paths.js";

export interface SessionWatcher {
  close(): Promise<void>;
}

export interface WatchSessionsOptions {
  root?: string;
  onUnlink?: (path: string) => void;
}

const DEBOUNCE_MS = 250;

export function watchSessions(
  onFile: (path: string) => void,
  options: WatchSessionsOptions = {},
): SessionWatcher {
  const root = options.root ?? piSessionsRoot();
  if (!existsSync(root)) {
    // pi never ran on this machine — nothing to watch yet. A daemon restart
    // after the first pi run picks it up; cheap poll covers the gap.
    const poll = setInterval(() => {
      if (existsSync(root)) {
        clearInterval(poll);
        start();
      }
    }, 5000);
    poll.unref();
    let watcher: SessionWatcher | undefined;
    const start = () => {
      watcher = makeWatcher(onFile, options.onUnlink, root);
    };
    return {
      close: async () => {
        clearInterval(poll);
        await watcher?.close();
      },
    };
  }
  return makeWatcher(onFile, options.onUnlink, root);
}

function makeWatcher(
  onFile: (path: string) => void,
  onUnlink: ((path: string) => void) | undefined,
  root: string,
): SessionWatcher {
  const pending = new Map<string, { timer: NodeJS.Timeout; kind: "ingest" | "unlink" }>();
  const watcher = chokidar.watch(root, {
    ignoreInitial: false,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  const schedule = (path: string, kind: "ingest" | "unlink") => {
    if (!path.endsWith(".jsonl")) return;
    const prior = pending.get(path);
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      pending.delete(path);
      if (kind === "unlink") onUnlink?.(path);
      else onFile(path);
    }, DEBOUNCE_MS);
    pending.set(path, { timer, kind });
  };
  watcher.on("add", (path) => schedule(path, "ingest"));
  watcher.on("change", (path) => schedule(path, "ingest"));
  watcher.on("unlink", (path) => schedule(path, "unlink"));
  return {
    close: async () => {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      await watcher.close();
    },
  };
}
