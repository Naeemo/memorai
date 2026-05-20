import type { Conversation, RunRecord, RunResult } from "./types.js";
import type { MemoryProvider } from "./provider.js";
import { generateAnswer } from "./llm/answerer.js";
import { judgeBinary, type JudgeLabel } from "./llm/judge.js";
import { pickAnswererBackend, pickJudgeBackend } from "./llm/pick.js";
import { aggregateByCategory, formatPublicMarkdown, percentile } from "./metrics.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface RunOptions {
  suite: string;
  provider: MemoryProvider;
  ingestMode: string;
  embedder: string;
  conversations: Conversation[];
  topK?: number;
  evolve?: boolean;
  answererModel?: string;
  judgeModel?: string;
  categories?: string[];
  outDir?: string;
  /** Max QAs per conversation — useful for smoke tests. */
  limitQas?: number;
  onProgress?: (msg: string) => void;
}

export async function runSuite(opts: RunOptions): Promise<RunResult> {
  const {
    suite,
    provider,
    ingestMode,
    embedder,
    conversations,
    topK = 30,
    evolve = true,
    categories,
    outDir = "results",
    limitQas,
  } = opts;

  const answererBackend = pickAnswererBackend(opts.answererModel);
  const judgeBackend = pickJudgeBackend(opts.judgeModel);
  const onProgress = opts.onProgress ?? (() => {});

  await provider.init();

  const records: RunRecord[] = [];
  const start = performance.now();
  // Stamp `runAt` once so checkpoint writes during the run reuse the same
  // file name — the final state overwrites the partial in place.
  const runAt = new Date().toISOString();

  let convIdx = 0;
  let lastErr: unknown;

  // buildResult: closure over the mutable record / timing state so we can
  // call it after each conversation completes (or on failure) to compute
  // the current aggregate without duplicating the field-build below.
  const buildResult = (conversationsCompleted: number): RunResult => {
    const correct = records.filter((r) => r.judgeLabel === "CORRECT").length;
    const latencies = records.map((r) => r.latencyMs);
    const avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length);
    const p95LatencyMs = percentile(latencies, 95);
    const byCategory = aggregateByCategory(records);
    return {
      suite,
      provider: provider.name,
      ingestMode,
      answererModel: `${answererBackend.provider}:${answererBackend.model}`,
      judgeModel: `${judgeBackend.provider}:${judgeBackend.model}`,
      embedder,
      conversations: conversationsCompleted,
      totalQas: records.length,
      correct,
      accuracy: records.length === 0 ? 0 : correct / records.length,
      avgLatencyMs,
      p95LatencyMs,
      byCategory,
      records,
      runAt,
      durationMs: performance.now() - start,
    };
  };

  try {
    for (const conv of conversations) {
      convIdx += 1;
      onProgress(
        `[${suite}] conv ${convIdx}/${conversations.length}: ${conv.id} (${conv.sessions.length} sessions, ${conv.qas.length} qas)`,
      );

      await provider.resetUser(conv.id);

      for (const [si, session] of conv.sessions.entries()) {
        await provider.ingestTurns(session, {
          userId: conv.id,
          sessionId: String(si),
          evolve,
        });
      }

      const qas = limitQas ? conv.qas.slice(0, limitQas) : conv.qas;
      for (const qa of qas) {
        if (categories && qa.category && !categories.includes(qa.category)) {
          continue;
        }
        const t0 = performance.now();
        const hits = await provider.query(qa.question, {
          userId: conv.id,
          topK,
        });
        const predicted = await generateAnswer(answererBackend, qa.question, hits);
        let judgeLabel: JudgeLabel;
        try {
          judgeLabel = await judgeBinary(judgeBackend, qa.question, qa.gold, predicted);
        } catch (err) {
          onProgress(`  judge failed on qa ${qa.id}: ${String(err)}`);
          judgeLabel = "INCORRECT";
        }
        const latencyMs = performance.now() - t0;
        records.push({
          qa,
          hits: hits.map((h) => ({ content: h.content, score: h.score })),
          predicted,
          judgeLabel,
          latencyMs,
          hitCount: hits.length,
        });
      }

      // Checkpoint after each conversation. Hours-long runs that die from
      // quota / cloud timeouts / process crashes used to lose every record;
      // now the on-disk result reflects the last successful conversation.
      try {
        await writeRunResult(buildResult(convIdx), outDir);
      } catch (writeErr) {
        // Don't let a transient disk error sink the whole run.
        onProgress(`  checkpoint write failed: ${String(writeErr)}`);
      }
    }
  } catch (err) {
    lastErr = err;
  }

  await provider.close();

  const result = buildResult(convIdx);

  if (lastErr) {
    // Write a final checkpoint reflecting partial state, then re-throw so
    // the caller still surfaces the error. The on-disk file is the same
    // path as a successful run — readers don't need to know it's partial.
    try {
      await writeRunResult(result, outDir);
    } catch {
      // ignore
    }
    throw lastErr;
  }

  // Final clean write — already written by the last checkpoint, but
  // overwrite once more so `durationMs` reflects the full run incl.
  // provider.close().
  await writeRunResult(result, outDir);
  return result;
}

export async function writeRunResult(
  result: RunResult,
  outDir: string,
): Promise<{ jsonPath: string; mdPath: string }> {
  const ts = result.runAt.replace(/[:.]/g, "-");
  const base = `${result.suite}-${result.provider}-${ts}`;
  const dir = resolve(process.cwd(), outDir);
  await mkdir(dir, { recursive: true });
  const jsonPath = resolve(dir, `${base}.json`);
  const mdPath = resolve(dir, `${base}.md`);
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(result, null, 2));
  await writeFile(mdPath, formatPublicMarkdown(result));
  return { jsonPath, mdPath };
}
