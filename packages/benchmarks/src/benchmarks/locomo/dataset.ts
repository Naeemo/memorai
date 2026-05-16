import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Conversation, QA, Turn } from "../../core/types.js";

export interface LoCoMoMessage {
  speaker: string;
  dia_id: string;
  text: string;
}

export interface LoCoMoQA {
  question: string;
  answer: string | number;
  evidence: string[];
  category: number;
}

export interface LoCoMoConversation {
  speaker_a: string;
  speaker_b: string;
  [key: string]: string | LoCoMoMessage[] | undefined;
}

export interface LoCoMoItem {
  sample_id: string;
  qa: LoCoMoQA[];
  conversation: LoCoMoConversation;
}

const CATEGORY_NAMES: Record<number, string> = {
  1: "single_hop",
  2: "temporal",
  3: "multi_hop",
  4: "open_domain",
  5: "adversarial",
};

export const DEFAULT_PATH = "datasets/locomo/locomo10.json";

export async function loadLoCoMo(
  path: string = DEFAULT_PATH,
): Promise<Conversation[]> {
  const abs = resolve(process.cwd(), path);
  const raw = await readFile(abs, "utf8");
  const items = JSON.parse(raw) as LoCoMoItem[];
  return items.map(normalizeLoCoMoItem);
}

export function normalizeLoCoMoItem(item: LoCoMoItem): Conversation {
  const conv = item.conversation;
  const sessions: Turn[][] = [];

  const sessionKeys = Object.keys(conv)
    .filter((k) => k.startsWith("session_") && Array.isArray(conv[k]))
    .sort((a, b) => sessionIndex(a) - sessionIndex(b));

  const speakerA = conv.speaker_a;
  for (const key of sessionKeys) {
    const msgs = conv[key] as LoCoMoMessage[];
    sessions.push(
      msgs.map((m) => ({
        role: m.speaker === speakerA ? "user" : "assistant",
        content: m.text,
      })),
    );
  }

  const qas: QA[] = item.qa.map((q, i) => ({
    id: `${item.sample_id}#${i}`,
    question: q.question,
    gold: String(q.answer),
    category: CATEGORY_NAMES[q.category] ?? String(q.category),
  }));

  return {
    id: item.sample_id,
    sessions,
    qas,
    meta: { dataset: "locomo" },
  };
}

function sessionIndex(key: string): number {
  const n = Number.parseInt(key.split("_")[1], 10);
  return Number.isFinite(n) ? n : 0;
}
