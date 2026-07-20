import type { ChatGPTConversation, ChatGPTConversationMeta } from "./types.js";

const BASE_URL = "https://chatgpt.com/backend-api";
const PAGE_SIZE = 28;
const CACHE_KEY = "memorai:conversations";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedConversations {
  fetchedAt: number;
  items: ChatGPTConversationMeta[];
}

/** Fetch a page of conversation metadata. */
export async function fetchConversationPage(
  token: string,
  offset: number,
  signal?: AbortSignal,
): Promise<{ items: ChatGPTConversationMeta[]; hasMore: boolean }> {
  const res = await fetch(
    `${BASE_URL}/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    },
  );

  if (!res.ok) {
    throw new Error(`Fetch conversations failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    items?: ChatGPTConversationMeta[];
    has_more?: boolean;
  };

  return {
    items: data.items ?? [],
    hasMore: data.has_more ?? false,
  };
}

/** Fetch all conversation metadata (paginated), with a short-lived session cache. */
export async function fetchAllConversations(
  token: string,
  opts: { maxConversations?: number; signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<ChatGPTConversationMeta[]> {
  if (!opts.forceRefresh) {
    const cached = await getCachedConversations();
    if (cached) {
      return cached.slice(0, opts.maxConversations);
    }
  }

  const conversations: ChatGPTConversationMeta[] = [];
  let offset = 0;

  while (true) {
    if (opts.signal?.aborted) break;
    if (opts.maxConversations !== undefined && conversations.length >= opts.maxConversations) {
      break;
    }

    const page = await fetchConversationPage(token, offset, opts.signal);
    if (page.items.length === 0) break;

    conversations.push(...page.items);
    offset += page.items.length;

    if (!page.hasMore) break;
  }

  const result = conversations.slice(0, opts.maxConversations);
  await setCachedConversations(result);
  return result;
}

async function getCachedConversations(): Promise<ChatGPTConversationMeta[] | null> {
  try {
    const data = await chrome.storage.session.get(CACHE_KEY);
    const cached = data[CACHE_KEY] as CachedConversations | undefined;
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
    return cached.items;
  } catch {
    return null;
  }
}

async function setCachedConversations(items: ChatGPTConversationMeta[]): Promise<void> {
  try {
    const value: CachedConversations = { fetchedAt: Date.now(), items };
    await chrome.storage.session.set({ [CACHE_KEY]: value });
  } catch {
    // cache is best-effort
  }
}

/** Fetch full conversation detail including message mapping. */
export async function fetchConversationDetail(
  token: string,
  id: string,
  signal?: AbortSignal,
): Promise<ChatGPTConversation> {
  const res = await fetch(`${BASE_URL}/conversation/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Fetch conversation ${id} failed: ${res.status}`);
  }

  return res.json() as Promise<ChatGPTConversation>;
}
