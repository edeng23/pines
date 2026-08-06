/** Builders for pi session JSONL fixtures used across tests. */

let ids = 0;
export function eid(): string {
  ids++;
  return ids.toString(16).padStart(8, "0");
}

export function header(cwd: string, opts?: { parentSession?: string; id?: string }): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: opts?.id ?? "11111111-2222-3333-4444-555555555555",
    timestamp: new Date(0).toISOString(),
    cwd,
    ...(opts?.parentSession ? { parentSession: opts.parentSession } : {}),
  });
}

export function msg(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" | "toolResult",
  text: string,
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    message: { role, content: [{ type: "text", text }], timestamp: 0 },
  });
}

export function label(id: string, targetId: string, labelText: string | undefined): string {
  return JSON.stringify({
    type: "label",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    targetId,
    label: labelText,
  });
}

export function sessionInfo(id: string, name: string): string {
  return JSON.stringify({
    type: "session_info",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    name,
  });
}

export function leafEntry(id: string, targetId: string | null): string {
  return JSON.stringify({
    type: "leaf",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    targetId,
  });
}

/**
 * A small branched session:
 *
 *   u1 ── a1 ── u2 ── a2          (main path)
 *          └── u3 ── a3           (branch from a1)
 */
export function branchedSession(cwd: string): { content: string; ids: Record<string, string> } {
  const u1 = "aaaa0001";
  const a1 = "aaaa0002";
  const u2 = "aaaa0003";
  const a2 = "aaaa0004";
  const u3 = "aaaa0005";
  const a3 = "aaaa0006";
  const lines = [
    header(cwd),
    msg(u1, null, "user", "build me a parser for the pines forest"),
    msg(a1, u1, "assistant", "sure, here is a plan"),
    msg(u2, a1, "user", "make it incremental"),
    msg(a2, u2, "assistant", "done, incremental it is"),
    msg(u3, a1, "user", "actually use a different approach with embeddings"),
    msg(a3, u3, "assistant", "switched to embeddings"),
    label("aaaa0007", a1, "plan-approved"),
    sessionInfo("aaaa0008", "parser-work"),
  ];
  return { content: lines.join("\n") + "\n", ids: { u1, a1, u2, a2, u3, a3 } };
}
