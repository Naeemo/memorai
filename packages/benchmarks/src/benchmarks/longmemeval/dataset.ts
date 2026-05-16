import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Conversation, QA, Turn } from "../../core/types.js";

export interface LongMemEvalMessage {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

export interface LongMemEvalItem {
  question_id: string;
  question: string;
  answer: string;
  question_type: string;
  question_date?: string;
  haystack_dates: string[];
  haystack_sessions: LongMemEvalMessage[][];
}

export const DEFAULT_PATHS = {
  oracle: "datasets/longmemeval/longmemeval_oracle.json",
  s: "datasets/longmemeval/longmemeval_s.json",
};

export type LongMemEvalSplit = keyof typeof DEFAULT_PATHS;

export async function loadLongMemEval(
  split: LongMemEvalSplit = "oracle",
  pathOverride?: string,
): Promise<Conversation[]> {
  const path = pathOverride ?? DEFAULT_PATHS[split];
  const abs = resolve(process.cwd(), path);
  const raw = await readFile(abs, "utf8");
  const items = JSON.parse(raw) as LongMemEvalItem[];
  return items.map(normalizeLongMemEvalItem);
}

export function normalizeLongMemEvalItem(
  item: LongMemEvalItem,
): Conversation {
  const sessions: Turn[][] = item.haystack_sessions.map((session, i) => {
    const dateStr = item.haystack_dates?.[i];
    const tsBase = dateStr ? Date.parse(dateStr) : undefined;
    return session.map((m, j) => ({
      role: m.role,
      content: m.content,
      timestampMs:
        tsBase !== undefined && !Number.isNaN(tsBase)
          ? tsBase + j * 1000
          : undefined,
    }));
  });

  const qa: QA = {
    id: item.question_id,
    question: item.question,
    gold: item.answer,
    category: item.question_type,
  };

  return {
    id: item.question_id,
    sessions,
    qas: [qa],
    meta: {
      dataset: "longmemeval",
      questionDate: item.question_date,
    },
  };
}
