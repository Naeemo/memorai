// ─── Service Worker: Memorai instance + import coordination + search service ───

import { Memorai, IndexedDBAdapter, OllamaEmbeddingService } from "memorai";
import type { Event, RecordHandle } from "memorai";

// ─── 1. Initialize Memorai ───

let memory: Memorai | null = null;

async function getMemory(): Promise<Memorai> {
  if (memory) return memory;

  memory = new Memorai({
    storage: new IndexedDBAdapter({
      dbName: "memorai-chatgpt",
      namespace: "browser-extension",
    }),
    embedding: new OllamaEmbeddingService({
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
    }),
    agentProfile: {
      agentId: "browser-extension",
      role: "reasoning",
      writePolicy: {
        levels: ["segment"],
        modalities: ["text"],
        salienceBoost: 1,
      },
      readPolicy: {
        defaultLevel: "segment",
        defaultTraversal: "reverse",
        timeHorizonMs: 365 * 24 * 60 * 60 * 1000, // 1 year
      },
    },
  });

  return memory;
}

// ─── 2. Import State ───

interface ImportState {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  isRunning: boolean;
  error?: string;
}

let importState: ImportState = {
  total: 0,
  completed: 0,
  skipped: 0,
  failed: 0,
  isRunning: false,
};

let importAbort: AbortController | null = null;

// ─── 3. Message Handlers ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case "IMPORT_START":
        return startImport(message.token);
      case "IMPORT_CANCEL":
        return cancelImport();
      case "IMPORT_STATUS":
        return importState;
      case "SEARCH":
        return searchChatGPT(message.query, message.topK);
      case "OLLAMA_CHECK":
        return checkOllama();
      case "GET_STATS":
        return getStats();
      case "CLEAR_ALL":
        return clearAll();
      default:
        return { error: "Unknown message type" };
    }
  };

  handler().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true; // async response
});

// ─── 4. Import Logic ───

async function startImport(token: string): Promise<ImportState> {
  if (importState.isRunning) return importState;

  importAbort = new AbortController();
  importState = { total: 0, completed: 0, skipped: 0, failed: 0, isRunning: true };

  try {
    const mem = await getMemory();
    const conversations = await fetchAllConversations(token, importAbort.signal);

    importState.total = conversations.length;

    for (const conv of conversations) {
      if (importAbort.signal.aborted) break;

      try {
        const detail = await fetchConversationDetail(token, conv.id, importAbort.signal);
        const events = mapConversationToEvents(detail, conv);

        let imported = 0;
        let skipped = 0;

        for (const event of events) {
          const exists = await checkExists(mem, event);
          if (exists) {
            skipped++;
            continue;
          }

          await mem.recordEvent(event);
          imported++;
        }

        importState.completed++;
        importState.skipped += skipped;

        // Update badge
        updateBadge(importState.completed, importState.total);
      } catch (err) {
        importState.failed++;
        console.error(`Import failed for conversation ${conv.id}:`, err);
      }
    }

    importState.isRunning = false;
    clearBadge();

    // Save last import time
    await chrome.storage.local.set({ lastImportAt: Date.now() });

    return importState;
  } catch (err) {
    importState.isRunning = false;
    importState.error = (err as Error).message;
    clearBadge();
    throw err;
  }
}

async function cancelImport(): Promise<ImportState> {
  importAbort?.abort();
  importState.isRunning = false;
  return importState;
}

// ─── 5. ChatGPT API ───

async function fetchAllConversations(token: string, signal: AbortSignal): Promise<Array<{ id: string; title: string; update_time: number }>> {
  const conversations: Array<{ id: string; title: string; update_time: number }> = [];
  let offset = 0;
  const limit = 28;

  while (!signal.aborted) {
    const res = await fetch(`https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });

    if (!res.ok) throw new Error(`Fetch conversations failed: ${res.status}`);

    const data = await res.json();
    if (!data.items || data.items.length === 0) break;

    conversations.push(...data.items);
    offset += data.items.length;

    if (!data.has_more) break;
  }

  return conversations;
}

async function fetchConversationDetail(token: string, id: string, signal: AbortSignal): Promise<ChatGPTConversation> {
  const res = await fetch(`https://chatgpt.com/backend-api/conversation/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (!res.ok) throw new Error(`Fetch detail failed: ${res.status}`);
  return res.json();
}

// ─── 6. Mapping ───

interface ChatGPTMessage {
  id: string;
  author: { role: "user" | "assistant" | "system" };
  content: { content_type: "text"; parts: string[] };
  create_time: number;
}

interface ChatGPTConversation {
  id: string;
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, { message?: ChatGPTMessage; parent?: string; children: string[] }>;
}

function mapConversationToEvents(conv: ChatGPTConversation, meta: { id: string; title: string }): Event[] {
  const events: Event[] = [];

  for (const node of Object.values(conv.mapping)) {
    if (!node.message) continue;
    const msg = node.message;
    if (msg.author.role === "system") continue;

    const text = msg.content.parts[0] ?? "";
    if (!text.trim()) continue;

    events.push({
      at: msg.create_time * 1000,
      actor: msg.author.role,
      content: { kind: "observation", text: text.slice(0, 8000) },
      tags: ["chatgpt", meta.title],
      id: `chatgpt-msg:${msg.id}`,
      context: `conversation:${meta.id}`,
      salienceHint: 0.7,
    });
  }

  return events;
}

// ─── 7. Dedup ───

async function checkExists(mem: Memorai, event: Event): Promise<boolean> {
  if (!event.id) return false;

  try {
    const result = await mem.recall(event.id, { topK: 1, level: "segment" });
    return result.memories.some((m) => m.provenance?.includes("eventId") && m.meta?.eventId === event.id);
  } catch {
    return false;
  }
}

// ─── 8. Search ───

async function searchChatGPT(query: string, topK = 10): Promise<{ memories: any[] }> {
  const mem = await getMemory();
  const result = await mem.recall(query, { topK });

  return {
    memories: result.memories.map((m) => ({
      id: m.id,
      at: m.at,
      actor: m.actor,
      summary: m.summary,
      text: m.text,
      conversationId: m.meta?.context?.replace("conversation:", ""),
      score: m.score,
      tags: m.tags,
    })),
  };
}

// ─── 9. Ollama Check ───

async function checkOllama(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", { method: "GET" });
    if (!res.ok) return { ok: false, message: "Ollama is running but returned an error" };

    const data = await res.json();
    const hasModel = data.models?.some((m: any) => m.name?.includes("nomic-embed-text"));

    if (!hasModel) {
      return { ok: false, message: "Ollama is running but nomic-embed-text is not installed. Run: ollama pull nomic-embed-text" };
    }

    return { ok: true, message: "Ollama is ready with nomic-embed-text" };
  } catch {
    return { ok: false, message: "Ollama is not running. Start it with: ollama serve" };
  }
}

// ─── 10. Stats & Clear ───

async function getStats(): Promise<{ conversations: number; messages: number; lastImportAt: number | null }> {
  const mem = await getMemory();
  const result = await mem.recallByTime(
    { start: 0, end: Date.now() },
    { topK: 10000 }
  );

  const conversations = new Set(result.memories.map((m) => m.meta?.context)).size;
  const { lastImportAt } = await chrome.storage.local.get("lastImportAt");

  return {
    conversations,
    messages: result.memories.length,
    lastImportAt: lastImportAt ?? null,
  };
}

async function clearAll(): Promise<{ ok: boolean }> {
  if (memory) {
    await memory.close();
    memory = null;
  }
  await chrome.storage.local.clear();
  return { ok: true };
}

// ─── 11. Badge Helpers ───

function updateBadge(current: number, total: number) {
  chrome.action.setBadgeText({ text: `${Math.round((current / total) * 100)}%` });
  chrome.action.setBadgeBackgroundColor({ color: "#f97316" });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}

// ─── 12. Startup ───

getMemory().catch(console.error);
