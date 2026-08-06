/**
 * Embedding worker (worker_thread): loads the embedding pipeline lazily so the
 * daemon's event loop and startup are never blocked by model init/download.
 *
 * Messages in:  { reqId: string, texts: string[] }
 * Messages out: { reqId: string, vectors: number[][] } | { reqId, error: string }
 *               | { ready: true } | { fatal: string }
 *
 * The model defaults to MiniLM and can be overridden via PINES_EMBED_MODEL
 * (set from config by SemanticLayout when spawning the worker).
 */
import { parentPort } from "node:worker_threads";
import { modelsDir } from "../shared/paths.js";

if (!parentPort) throw new Error("embed-worker must run as a worker thread");
const port = parentPort;

type Extractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let extractorPromise: Promise<Extractor> | null = null;

function getExtractor(): Promise<Extractor> {
  extractorPromise ??= (async () => {
    process.env.HF_HOME ??= modelsDir();
    const { pipeline, env } = await import("@huggingface/transformers");
    // Keep everything on-disk and offline-friendly after first download.
    env.cacheDir = modelsDir();
    const model = process.env.PINES_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
    const pipe = await pipeline("feature-extraction", model, {
      dtype: "q8",
    });
    port.postMessage({ ready: true });
    return pipe as unknown as Extractor;
  })();
  return extractorPromise;
}

const queue: Array<{ reqId: string; texts: string[] }> = [];
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const extractor = await getExtractor();
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        // One text at a time keeps memory bounded for large batches; the
        // worker is the throughput ceiling either way.
        const vectors: number[][] = [];
        for (const text of job.texts) {
          const out = await extractor(text, { pooling: "mean", normalize: true });
          vectors.push(Array.from(out.data));
        }
        port.postMessage({ reqId: job.reqId, vectors });
      } catch (err) {
        port.postMessage({
          reqId: job.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // Model never loaded (offline first run, missing optional dep, …).
    port.postMessage({ fatal: err instanceof Error ? err.message : String(err) });
    queue.length = 0;
  } finally {
    draining = false;
  }
}

port.on("message", (msg: { reqId: string; texts: string[] }) => {
  queue.push(msg);
  void drain();
});
