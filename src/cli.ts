#!/usr/bin/env node
/**
 * pines CLI dispatch.
 *
 *   pines              attach to the daemon (auto-spawns it), open the forest
 *   pines server       run the daemon in the foreground (internal; use `pines`)
 *   pines spawn        spawn a new tree (pi session) via the daemon
 *   pines status       print daemon + agents status
 *   pines kill         stop the daemon (and its pi children)
 *   pines --version    print version
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function version(): string {
  return (require("../package.json") as { version: string }).version;
}

async function main(): Promise<void> {
  // Piped output (e.g. `pines status | head`) must not crash on EPIPE.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") process.exit(0);
      throw err;
    });
  }
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`pines ${version()}\n`);
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  switch (cmd) {
    case "server": {
      const { runServer } = await import("./daemon/server.js");
      await runServer();
      return;
    }
    case "spawn": {
      const { spawnCommand } = await import("./client/commands.js");
      await spawnCommand(args.slice(1));
      return;
    }
    case "status": {
      const { statusCommand } = await import("./client/commands.js");
      await statusCommand();
      return;
    }
    case "kill": {
      const { killCommand } = await import("./client/commands.js");
      await killCommand();
      return;
    }
    case undefined: {
      const { runApp } = await import("./client/app.js");
      await runApp();
      return;
    }
    default: {
      process.stderr.write(`pines: unknown command '${cmd}'\n\n${HELP}`);
      process.exitCode = 2;
    }
  }
}

const HELP = `pines ${version()} — tree-first orchestration for pi agents

usage:
  pines                 open the forest (auto-starts the daemon)
  pines spawn [--cwd DIR] [--name NAME] [--prompt TEXT]
                        spawn a new tree (pi session) in the background
  pines status          show daemon and agent status
  pines kill            stop the daemon and all pi processes
  pines server          run the daemon in the foreground (internal)
  pines --version       print version
`;

main().catch((err) => {
  process.stderr.write(`pines: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
