// ─── Service Worker: Memorai instance + import coordination + search service ───

import { Memorai, IndexedDBAdapter, OllamaEmbeddingService } from "memorai";
import { runImport } from "./importer/index.js";
import type { ImportProgress } from "./importer/types.js";

// ─── 1. Initialize Memorai ───

let memory: Memorai | null = null;

async function getMemory(): Promise<Memorai> {
  if (memory) return memory;

  const { ollamaUrl, ollamaModel } = await chrome.storage.local.get(["ollamaUrl", "ollamaModel"]);

  memory = new Memorai({
    storage: new IndexedDBAdapter({
      dbName: "memorai-chatgpt",
      namespace: "browser-extension"
    }),
    embedding: new OllamaEmbeddingService({
      baseURL: ollamaUrl ?? "http://localhost:11434",
      model: ollamaModel ?? "nomic-embed-text",
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

let importState: ImportProgress = {
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

async function startImport(token: string): Promise<ImportProgress> {
  if (importState.isRunning) return importState;

  importAbort = new AbortController();
  importState = { total: 0, completed: 0, skipped: 0, failed: 0, isRunning: true };

  try {
    const mem = await getMemory();
    const result = await runImport(
      mem,
      token,
      { signal: importAbort.signal },
      (progress) => {
        importState = progress;
        if (progress.total > 0) {
          updateBadge(progress.completed, progress.total);
        }
      },
    );

    clearBadge();
    await chrome.storage.local.set({ lastImportAt: Date.now() });
    return result;
  } catch (err) {
    importState.isRunning = false;
    importState.error = (err as Error).message;
    clearBadge();
    throw err;
  }
}

async function cancelImport(): Promise<ImportProgress> {
  importAbort?.abort();
  importState.isRunning = false;
  return importState;
}

// ─── 5. Search ───

async function searchChatGPT(query: string, topK = 10): Promise<{ memories: any[] }> {
  const mem = await getMemory();
  const result = await mem.recall(query, { topK });

  return {
    memories: result.memories.map((m) => ({
      id: m.id,
      at: m.at,
      actor: m.actor,
      summary: m.summary,
      text: m.description || m.summary,
      conversationId: m.id?.split(":")?.[1] || "",
      score: m.score,
      tags: m.tags,
    })),
  };
}

// ─── 6. Ollama Check ───

async function checkOllama(): Promise<{ ok: boolean; message: string }> {
  const { ollamaUrl, ollamaModel } = await chrome.storage.local.get(["ollamaUrl", "ollamaModel"]);
  const baseURL = ollamaUrl ?? "http://localhost:11434";
  const model = ollamaModel ?? "nomic-embed-text";

  try {
    const res = await fetch(`${baseURL}/api/tags`, { method: "GET" });
    if (!res.ok) return { ok: false, message: "Ollama is running but returned an error" };

    const data = await res.json();
    const hasModel = data.models?.some((m: any) => m.name?.includes(model));

    if (!hasModel) {
      return { ok: false, message: `Ollama is running but ${model} is not installed. Run: ollama pull ${model}` };
    }

    return { ok: true, message: `Ollama is ready with ${model}` };
  } catch {
    return { ok: false, message: `Ollama is not reachable at ${baseURL}. Start it with: ollama serve` };
  }
}

// ─── 7. Stats & Clear ───

async function getStats(): Promise<{ conversations: number; messages: number; lastImportAt: number | null }> {
  const mem = await getMemory();
  const result = await mem.recallByTime(
    { start: 0, end: Date.now() },
    { topK: 10000 }
  );

  const conversations = new Set(result.memories.map((m) => m.id?.split(":")?.[1])).size;
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

// ─── 8. Badge Helpers ───

function updateBadge(current: number, total: number) {
  chrome.action.setBadgeText({ text: `${Math.round((current / total) * 100)}%` });
  chrome.action.setBadgeBackgroundColor({ color: "#f97316" });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}

// ─── 9. Settings Watch ───

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes.ollamaUrl || changes.ollamaModel)) {
    // Reset memory so the next getMemory() picks up new Ollama config.
    if (memory) {
      memory.close().catch(console.error);
      memory = null;
    }
  }
});

// ─── 10. Startup ───

getMemory().catch(console.error);
