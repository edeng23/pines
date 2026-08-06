import { describe, expect, it } from "vitest";
import { parseSessionContent, toTreeDetail } from "../src/session/parser.js";
import { branchedSession, header, leafEntry, msg } from "./fixtures/sessions.js";

describe("session parser", () => {
  it("parses a branched v3 session into a tree with labels, name, and leaf", async () => {
    const { content, ids } = branchedSession("/tmp/proj");
    const parsed = await parseSessionContent(content);

    expect(parsed.header.cwd).toBe("/tmp/proj");
    expect(parsed.name).toBe("parser-work");
    expect(parsed.labels.get(ids.a1)).toBe("plan-approved");
    expect(parsed.firstUserText).toContain("build me a parser");
    // Leaf = last appended tree entry (a3, the branch tip).
    expect(parsed.leafId).toBe(ids.a3);

    const detail = toTreeDetail("t_test", parsed);
    expect(detail.rootIds).toEqual([ids.u1]);
    expect(detail.nodes[ids.a1]?.children).toEqual([ids.u2, ids.u3]);
    expect(detail.nodes[ids.u3]?.kind).toBe("user");
    expect(detail.nodes[ids.a1]?.label).toBe("plan-approved");
  });

  it("ignores a torn trailing line and reports completeBytes before it", async () => {
    const { content } = branchedSession("/tmp/proj");
    const torn = content + '{"type":"message","id":"zzzz0001","parentId":"aaaa000';
    const parsed = await parseSessionContent(torn);
    expect(parsed.entries.map((e) => e.id)).not.toContain("zzzz0001");
    expect(parsed.completeBytes).toBe(Buffer.byteLength(content, "utf8"));
    // Re-parsing the complete portion yields identical structure.
    const clean = await parseSessionContent(content);
    expect(parsed.entries.length).toBe(clean.entries.length);
  });

  it("honors an explicit leaf entry (newer agent-core LeafEntry)", async () => {
    const lines = [
      header("/tmp/x"),
      msg("bbbb0001", null, "user", "root"),
      msg("bbbb0002", "bbbb0001", "assistant", "answer"),
      leafEntry("bbbb0003", "bbbb0001"),
    ];
    const parsed = await parseSessionContent(lines.join("\n") + "\n");
    expect(parsed.leafId).toBe("bbbb0001");
  });

  it("excerpts tool-only and thinking-only assistant turns instead of blanking", async () => {
    // Real pi assistant turns often carry no text block at all — just
    // thinking and tool calls. The excerpt falls back through them.
    const mk = (id: string, parentId: string | null, content: unknown[]) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: "2026-07-25T10:00:00Z",
        message: { role: "assistant", content, timestamp: 0 },
      });
    const lines = [
      header("/tmp/x"),
      msg("dddd0001", null, "user", "go"),
      mk("dddd0002", "dddd0001", [
        { type: "thinking", thinking: "let me check the file" },
        { type: "toolCall", id: "tc1", name: "read_file", arguments: {} },
      ]),
      mk("dddd0003", "dddd0002", [{ type: "thinking", thinking: "the tests pass, done" }]),
      mk("dddd0004", "dddd0003", [
        { type: "thinking", thinking: "noise" },
        { type: "text", text: "All green." },
      ]),
    ];
    const parsed = await parseSessionContent(lines.join("\n") + "\n");
    const byId = new Map(parsed.entries.map((e) => [e.id, e.text]));
    expect(byId.get("dddd0002")).toBe("read_file(…)"); // tool call over thinking
    expect(byId.get("dddd0003")).toBe("the tests pass, done"); // thinking over nothing
    expect(byId.get("dddd0004")).toBe("All green."); // text always wins
  });

  it("captures parentSession lineage from the header", async () => {
    const lines = [
      header("/tmp/x", { parentSession: "/tmp/other/session.jsonl" }),
      msg("cccc0001", null, "user", "hi"),
    ];
    const parsed = await parseSessionContent(lines.join("\n") + "\n");
    expect(parsed.header.parentSession).toBe("/tmp/other/session.jsonl");
  });
});
