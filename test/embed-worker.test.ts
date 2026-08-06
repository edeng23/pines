/**
 * Embed worker behavior — adaptive to environment:
 *  - network + model available → real MiniLM embeddings, semantic ordering check
 *  - offline / blocked        → clean `fatal` fallback (lexical layout remains)
 * Either way the worker must respond and never wedge the daemon.
 */
import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "dist", "daemon", "embed-worker.js");

describe("embed worker", () => {
  it("either produces normalized embedding batches with sane semantics, or fails over cleanly", async () => {
    const home = mkdtempSync(join(tmpdir(), "pines-embed-"));
    const worker = new Worker(WORKER, { env: { ...process.env, PINES_HOME: home } });
    const inbox: Array<Record<string, unknown>> = [];
    worker.on("message", (m) => inbox.push(m as Record<string, unknown>));

    // One batched request embedding three chunks, like SemanticLayout sends.
    worker.postMessage({
      reqId: "r1",
      texts: [
        "fix the failing auth tests, login returns 401",
        "add oauth token refresh to the login flow",
        "optimize the canvas render loop frame time",
      ],
    });

    const outcome = await new Promise<"vectors" | "fatal">((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker never responded")), 120_000);
      const check = setInterval(() => {
        if (inbox.some((m) => m.fatal)) {
          clearTimeout(timer);
          clearInterval(check);
          resolve("fatal");
        }
        if (inbox.some((m) => m.reqId === "r1" && Array.isArray(m.vectors))) {
          clearTimeout(timer);
          clearInterval(check);
          resolve("vectors");
        }
      }, 100);
    });

    if (outcome === "vectors") {
      const reply = inbox.find((m) => m.reqId === "r1")!;
      const vecs = reply.vectors as number[][];
      expect(vecs).toHaveLength(3);
      const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
      const [auth1, auth2, render] = vecs as [number[], number[], number[]];
      expect(auth1).toHaveLength(384);
      expect(dot(auth1, auth1)).toBeCloseTo(1, 1); // normalized
      // Two auth prompts are closer than auth vs rendering.
      expect(dot(auth1, auth2)).toBeGreaterThan(dot(auth1, render));
    } else {
      // Fallback: exactly the path SemanticLayout handles by keeping lexical
      // layout; the queue is dropped and no vectors leak out afterwards.
      expect(inbox.some((m) => Array.isArray(m.vectors))).toBe(false);
    }

    await worker.terminate();
  }, 130_000);
});
